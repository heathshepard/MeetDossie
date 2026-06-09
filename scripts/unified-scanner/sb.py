"""Supabase REST helpers for the unified scanner.

Light wrapper that reuses the .env.local at the MeetDossie repo root the same
way ``desktop-control/cole_desktop.py`` does. No new dependencies.

Functions:
- insert_candidate(...)  -- upsert a candidate row; dedups on (platform, post_url)
- update_candidate(id, fields)
- fetch_candidates(status, platform=None, limit=...)
- log_desktop_action(...)  -- thin pass-through to desktop_actions for audit
"""

from __future__ import annotations

import os
import time
import logging
from pathlib import Path
from typing import Any, Iterable, Optional

import requests
from dotenv import load_dotenv

_REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(_REPO_ROOT / ".env.local")

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

log = logging.getLogger("unified_scanner.sb")


def _headers(extra: Optional[dict] = None) -> dict:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set")
    h = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }
    if extra:
        h.update(extra)
    return h


def insert_candidate(
    platform: str,
    post_url: str,
    post_text: str = "",
    author_handle: str = "",
    posted_at: Optional[str] = None,
    relevance_score: float = 0.0,
    matched_keywords: Optional[Iterable[str]] = None,
    scanner_run_id: Optional[str] = None,
) -> Optional[dict]:
    """Upsert one candidate. Returns the row or None on failure.

    Uses ``on_conflict=platform,post_url`` to avoid duplicates across runs.
    """
    if not post_url:
        return None
    payload = {
        "platform": platform,
        "post_url": post_url,
        "post_text": (post_text or "")[:8000],
        "author_handle": (author_handle or "")[:200],
        "posted_at": posted_at,
        "relevance_score": float(relevance_score or 0.0),
        "matched_keywords": list(matched_keywords) if matched_keywords else None,
        "status": "pending",
        "scanner_run_id": scanner_run_id,
    }
    url = f"{SUPABASE_URL}/rest/v1/engagement_candidates?on_conflict=platform,post_url"
    try:
        r = requests.post(
            url,
            headers=_headers({
                "Prefer": "resolution=merge-duplicates,return=representation",
            }),
            json=payload,
            timeout=10,
        )
        if r.status_code not in (200, 201, 204):
            log.warning("insert_candidate failed: %s %s", r.status_code, r.text[:200])
            return None
        if r.text:
            data = r.json()
            if isinstance(data, list) and data:
                return data[0]
        return payload
    except Exception as e:
        log.warning("insert_candidate exception: %s", e)
        return None


def update_candidate(candidate_id: int, fields: dict) -> bool:
    url = f"{SUPABASE_URL}/rest/v1/engagement_candidates?id=eq.{candidate_id}"
    try:
        r = requests.patch(
            url,
            headers=_headers({"Prefer": "return=minimal"}),
            json=fields,
            timeout=10,
        )
        if r.status_code not in (200, 204):
            log.warning("update_candidate failed: %s %s", r.status_code, r.text[:200])
            return False
        return True
    except Exception as e:
        log.warning("update_candidate exception: %s", e)
        return False


def fetch_candidates(
    status: str,
    platform: Optional[str] = None,
    limit: int = 50,
    order: str = "created_at.asc",
) -> list:
    q = f"status=eq.{status}&order={order}&limit={limit}"
    if platform:
        q += f"&platform=eq.{platform}"
    url = f"{SUPABASE_URL}/rest/v1/engagement_candidates?{q}"
    try:
        r = requests.get(url, headers=_headers(), timeout=10)
        if r.status_code != 200:
            log.warning("fetch_candidates failed: %s %s", r.status_code, r.text[:200])
            return []
        return r.json() or []
    except Exception as e:
        log.warning("fetch_candidates exception: %s", e)
        return []


def fetch_active_groups() -> list:
    """Active Facebook groups (skip=false) from group_registry."""
    url = (
        f"{SUPABASE_URL}/rest/v1/group_registry"
        "?skip=eq.false&select=id,group_name,group_url,requires_heath_review"
        "&order=group_name.asc"
    )
    try:
        r = requests.get(url, headers=_headers(), timeout=10)
        if r.status_code != 200:
            log.warning("fetch_active_groups failed: %s %s", r.status_code, r.text[:200])
            return []
        return r.json() or []
    except Exception as e:
        log.warning("fetch_active_groups exception: %s", e)
        return []


def log_desktop_action(
    action_type: str,
    target: str = "",
    text_typed: str = "",
    result: str = "success",
    requested_by: str = "atlas",
    approved_by: Optional[str] = None,
) -> Optional[int]:
    """Best-effort row insert into desktop_actions for audit trail.

    Mirrors cole_desktop.log_action signature minus screenshots so this
    module stays free of the mss/PIL dependency.
    """
    payload = {
        "action_type": action_type,
        "target": target[:500] if target else None,
        "text_typed": text_typed[:1000] if text_typed else None,
        "requested_by": requested_by,
        "approved_by": approved_by,
        "result": result,
    }
    try:
        r = requests.post(
            f"{SUPABASE_URL}/rest/v1/desktop_actions",
            headers=_headers({"Prefer": "return=representation"}),
            json=payload,
            timeout=8,
        )
        if r.status_code not in (200, 201):
            return None
        data = r.json()
        if isinstance(data, list) and data:
            return data[0].get("id")
    except Exception as e:
        log.debug("log_desktop_action exception: %s", e)
    return None


def telegram_alert(text: str) -> None:
    """Send a one-shot Claudy alert. Used for fatal scanner errors."""
    token = os.getenv("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.getenv("TELEGRAM_CHAT_ID", "")
    if not token or not chat_id:
        return
    try:
        requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": chat_id, "text": text, "disable_web_page_preview": True},
            timeout=8,
        )
    except Exception:
        pass
