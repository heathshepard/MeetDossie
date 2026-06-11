"""Cap enforcement for the unified social-engagement poster.

Mirror of ``api/_lib/engagement-caps.js`` but in Python so the PyAutoGUI
poster honors the same Heath-spec caps even if a stale approved row sits
in the queue across multiple days. The Telegram-approval cron already
filters before pinging Heath -- this layer is belt-and-suspenders for
the actual posting step.

Caps (Heath recalibration 2026-06-10 PM, single source of truth lives in
``scripts/_lib/comment-caps.js``):
- Per-platform daily: FB 12, IG 8, LinkedIn 6, Reddit 5, Twitter 15
- Total daily: 46 across all platforms
- Per-author cooldown: 7 days

We hit Supabase REST directly via ``sb._headers()`` to avoid a second HTTP
client dependency.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Dict, Optional, Set, Tuple

import requests

from . import sb

log = logging.getLogger("unified_scanner.caps")

# Mirror of scripts/_lib/comment-caps.js -- keep in sync. The JS file is the
# canonical source for the JS crons; this Python mirror exists for the
# poster only. If caps change, edit BOTH files in the same commit.
PLATFORM_DAILY_CAPS: Dict[str, int] = {
    "facebook":  12,
    "instagram": 8,
    "linkedin":  6,
    "reddit":    5,
    "twitter":   15,
}
TOTAL_DAILY_CAP = sum(PLATFORM_DAILY_CAPS.values())  # 46
PER_AUTHOR_WINDOW_DAYS = 7

PLATFORMS = tuple(PLATFORM_DAILY_CAPS.keys())


def _today_start_utc_iso() -> str:
    d = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    return d.isoformat()


def _n_days_ago_iso(n: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=n)).isoformat()


def _get(path: str) -> list:
    url = f"{sb.SUPABASE_URL}{path}"
    try:
        r = requests.get(url, headers=sb._headers(), timeout=10)
        if r.status_code != 200:
            log.warning("caps GET %s -> %s %s", path, r.status_code, r.text[:200])
            return []
        return r.json() or []
    except Exception as e:
        log.warning("caps GET %s exception: %s", path, e)
        return []


def load_daily_counts() -> Tuple[int, Dict[str, int]]:
    """Return (total_posted_today, {platform: count})."""
    since = _today_start_utc_iso()
    path = (
        "/rest/v1/engagement_candidates"
        "?select=platform&status=eq.posted"
        f"&posted_at=gte.{requests.utils.quote(since)}"
        "&limit=500"
    )
    rows = _get(path)
    per_platform: Dict[str, int] = {}
    for row in rows:
        p = row.get("platform") or ""
        per_platform[p] = per_platform.get(p, 0) + 1
    return len(rows), per_platform


def load_author_blocklist() -> Set[str]:
    """Return set of "platform::author" already engaged in the last 7d."""
    since = _n_days_ago_iso(PER_AUTHOR_WINDOW_DAYS)
    path = (
        "/rest/v1/engagement_candidates"
        "?select=author_handle,platform,status,created_at"
        "&status=in.(sent_for_approval,approved,posted)"
        f"&created_at=gte.{requests.utils.quote(since)}"
        "&author_handle=not.is.null"
        "&limit=500"
    )
    rows = _get(path)
    blocked: Set[str] = set()
    for row in rows:
        author = (row.get("author_handle") or "").strip().lower()
        platform = row.get("platform") or ""
        if not author or not platform:
            continue
        blocked.add(f"{platform}::{author}")
    return blocked


class CapState:
    """Mutable cap budget tracked across a single poster run."""

    def __init__(
        self,
        total_posted_today: int,
        per_platform_posted_today: Dict[str, int],
        blocked_authors: Set[str],
    ):
        self.total_remaining = max(0, TOTAL_DAILY_CAP - total_posted_today)
        self.per_platform_remaining: Dict[str, int] = {
            p: max(0, PLATFORM_DAILY_CAPS[p] - per_platform_posted_today.get(p, 0))
            for p in PLATFORMS
        }
        self.blocked_authors = set(blocked_authors)

    def try_consume(self, row: dict) -> Tuple[bool, str]:
        if self.total_remaining <= 0:
            return False, "total_daily_cap"
        platform = row.get("platform") or ""
        if self.per_platform_remaining.get(platform, 0) <= 0:
            return False, "platform_daily_cap"
        author = (row.get("author_handle") or "").strip().lower()
        if author:
            key = f"{platform}::{author}"
            if key in self.blocked_authors:
                return False, "author_7d_cooldown"
        self.total_remaining -= 1
        self.per_platform_remaining[platform] = self.per_platform_remaining.get(platform, 0) - 1
        if author:
            self.blocked_authors.add(f"{platform}::{author}")
        return True, "ok"

    def snapshot(self) -> dict:
        return {
            "total_remaining": self.total_remaining,
            "per_platform_remaining": dict(self.per_platform_remaining),
        }


def load_state() -> CapState:
    total, per_platform = load_daily_counts()
    blocked = load_author_blocklist()
    return CapState(total, per_platform, blocked)
