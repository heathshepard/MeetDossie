"""Cole desktop control - guard layer.

Every state-changing call MUST pass through these checks before the underlying
cole_desktop.* function runs. The guards enforce:
- Spend > $20 = Telegram confirm required
- Customer comms = Telegram confirm required (Heath-only auto-pass)
- Destructive file actions = Telegram confirm required
- System settings changes = Telegram confirm required
- Bank account interactions = HARD BLOCK unless prior session consent recorded

If a confirmation is requested via Telegram, this module inserts a row into
`desktop_pending_confirmations`, sends Heath an inline-keyboard message, then
polls the table for up to TIMEOUT_SECONDS. Default on timeout = DENY.
"""

from __future__ import annotations

import os
import re
import time
import logging
from pathlib import Path
from typing import Optional

import requests
from dotenv import load_dotenv

_REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(_REPO_ROOT / ".env.local")

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "7874782923")
VERCEL_BASE = os.getenv("VERCEL_BASE_URL", "https://meetdossie.com").rstrip("/")

TIMEOUT_SECONDS = 90  # how long to wait for Heath's reply before defaulting to DENY
POLL_INTERVAL = 2  # seconds between status checks

log = logging.getLogger("cole_desktop.guards")


# ----------------------------------------------------------------------------
# Heath's whitelist (for "is this a customer or Heath himself")
# ----------------------------------------------------------------------------

HEATH_OWNED_RECIPIENTS = {
    "heath@meetdossie.com",
    "heath.shepard@kw.com",
    "heath.shepard@gmail.com",
    "heathshepard@meetdossie.com",
    "info@meetdossie.com",
}


# ----------------------------------------------------------------------------
# Heuristics
# ----------------------------------------------------------------------------

_SPEND_KEYWORDS = (
    "pay now", "subscribe", "place order", "complete purchase", "checkout",
    "total:", "total amount", "billing", "credit card", "card number",
    "payment method", "buy now", "confirm order", "submit payment",
)


def is_spend_action(screenshot_or_text: str = "", action_payload: Optional[dict] = None) -> bool:
    """Heuristic: does the current screen or pending action involve paying money?"""
    text = (screenshot_or_text or "").lower()
    if any(k in text for k in _SPEND_KEYWORDS):
        return True
    if "$" in text and re.search(r"\$\s?\d{1,5}", text):
        return True
    if action_payload and action_payload.get("type") in ("checkout", "pay", "subscribe"):
        return True
    return False


def is_customer_comm(screenshot_or_text: str = "", recipient: str = "") -> bool:
    """True if sending an email/text/DM to a non-Heath recipient."""
    if recipient and recipient.lower().strip() in HEATH_OWNED_RECIPIENTS:
        return False
    if recipient and "@" in recipient:
        return True
    text = (screenshot_or_text or "").lower()
    send_signals = ("send email", "send message", "compose", "to:", "recipient", "send dm")
    return any(s in text for s in send_signals) and "heath" not in text


_DESTRUCTIVE_FILE_KEYWORDS = (
    "delete forever", "permanently delete", "format drive", "wipe",
    "remove all", "empty trash", "empty recycle bin",
)


def is_destructive_file_action(action: dict) -> bool:
    target = (action or {}).get("target", "").lower()
    text = (action or {}).get("text_typed", "").lower()
    action_type = (action or {}).get("action_type", "").lower()
    if action_type in ("delete", "format", "rm", "rmdir"):
        return True
    blob = f"{target} {text}"
    return any(k in blob for k in _DESTRUCTIVE_FILE_KEYWORDS)


_SYSTEM_SETTINGS_TITLES = (
    "settings", "control panel", "registry editor", "regedit", "services",
    "system configuration", "msconfig", "device manager", "group policy",
    "task scheduler", "windows defender",
)


def is_system_settings(window_title: str = "") -> bool:
    t = (window_title or "").lower()
    return any(s in t for s in _SYSTEM_SETTINGS_TITLES)


_BANK_DOMAINS = (
    "mercury.com", "mercury.co", "chase.com", "bankofamerica.com", "bofa.com",
    "capitalone.com", "wellsfargo.com", "citi.com", "citibank.com", "usbank.com",
    "navyfederal.org", "stripe.com/dashboard/payouts", "stripe.com/payouts",
    "paypal.com", "venmo.com", "cashapp.com", "ally.com", "discover.com/banking",
    "schwab.com", "fidelity.com", "vanguard.com",
)

_BANK_TITLE_KEYWORDS = (
    "mercury", "chase", "bank of america", "capital one", "wells fargo",
    "navy federal", "paypal", "venmo", "cash app", "stripe payouts",
)


def is_bank_site(url_or_title: str = "") -> bool:
    t = (url_or_title or "").lower()
    if any(d in t for d in _BANK_DOMAINS):
        return True
    return any(k in t for k in _BANK_TITLE_KEYWORDS)


# ----------------------------------------------------------------------------
# Bank consent session check
# ----------------------------------------------------------------------------

def has_bank_consent() -> bool:
    """Check Supabase desktop_session_state for an unexpired bank-consent token."""
    if not SUPABASE_URL:
        return False
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/desktop_session_state?id=eq.1&select=bank_consent_session_id,bank_consent_expires_at",
            headers={
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            },
            timeout=5,
        )
        rows = resp.json() if resp.ok else []
    except Exception as e:
        log.warning("has_bank_consent fetch failed: %s", e)
        return False
    if not rows:
        return False
    row = rows[0]
    if not row.get("bank_consent_session_id"):
        return False
    exp = row.get("bank_consent_expires_at")
    if not exp:
        return False
    # Compare as ISO strings - Postgres returns UTC ISO
    from datetime import datetime, timezone
    try:
        exp_dt = datetime.fromisoformat(exp.replace("Z", "+00:00"))
    except Exception:
        return False
    return exp_dt > datetime.now(timezone.utc)


# ----------------------------------------------------------------------------
# Lock / session state
# ----------------------------------------------------------------------------

def is_locked() -> tuple[bool, Optional[str]]:
    """Return (locked, reason). Used by __main__ before every action."""
    if not SUPABASE_URL:
        return False, None
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/desktop_session_state?id=eq.1&select=locked,lock_reason",
            headers={
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            },
            timeout=5,
        )
        rows = resp.json() if resp.ok else []
    except Exception:
        return False, None
    if not rows:
        return False, None
    return bool(rows[0].get("locked")), rows[0].get("lock_reason")


def set_locked(locked: bool, reason: str = "") -> None:
    if not SUPABASE_URL:
        return
    try:
        requests.patch(
            f"{SUPABASE_URL}/rest/v1/desktop_session_state?id=eq.1",
            headers={
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            json={
                "locked": locked,
                "lock_reason": reason if locked else None,
            },
            timeout=5,
        )
    except Exception as e:
        log.warning("set_locked failed: %s", e)


# ----------------------------------------------------------------------------
# Telegram confirm flow
# ----------------------------------------------------------------------------

def _create_pending(question: str, screenshot_url: Optional[str]) -> Optional[int]:
    if not SUPABASE_URL:
        return None
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/desktop_pending_confirmations",
            headers={
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "return=representation",
            },
            json={
                "question": question,
                "screenshot_url": screenshot_url,
            },
            timeout=5,
        )
        if resp.status_code in (200, 201):
            data = resp.json()
            if isinstance(data, list) and data:
                return data[0].get("id")
    except Exception as e:
        log.warning("_create_pending failed: %s", e)
    return None


def _send_telegram_with_buttons(text: str, pending_id: int, screenshot_url: Optional[str]) -> None:
    if not TELEGRAM_BOT_TOKEN:
        log.warning("TELEGRAM_BOT_TOKEN not set - cannot ask for confirmation")
        return
    keyboard = {
        "inline_keyboard": [[
            {"text": "Confirm", "callback_data": f"desktop_confirm:{pending_id}"},
            {"text": "Deny", "callback_data": f"desktop_deny:{pending_id}"},
        ]]
    }
    full_text = text
    if screenshot_url:
        full_text = f"{text}\n\nPreview: {screenshot_url}"
    try:
        requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
            json={
                "chat_id": TELEGRAM_CHAT_ID,
                "text": full_text,
                "reply_markup": keyboard,
            },
            timeout=10,
        )
    except Exception as e:
        log.warning("send_telegram_with_buttons failed: %s", e)


def _poll_pending(pending_id: int, timeout: int = TIMEOUT_SECONDS) -> str:
    """Poll until status != 'pending' or timeout. Returns final status."""
    if not SUPABASE_URL or pending_id is None:
        return "denied"
    started = time.time()
    while time.time() - started < timeout:
        try:
            resp = requests.get(
                f"{SUPABASE_URL}/rest/v1/desktop_pending_confirmations?id=eq.{pending_id}&select=status",
                headers={
                    "apikey": SUPABASE_SERVICE_ROLE_KEY,
                    "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                },
                timeout=5,
            )
            rows = resp.json() if resp.ok else []
            if rows and rows[0].get("status") != "pending":
                return rows[0]["status"]
        except Exception as e:
            log.warning("_poll_pending error: %s", e)
        time.sleep(POLL_INTERVAL)

    # Timed out - mark as timeout
    try:
        requests.patch(
            f"{SUPABASE_URL}/rest/v1/desktop_pending_confirmations?id=eq.{pending_id}",
            headers={
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            json={"status": "timeout", "resolved_at": "now()"},
            timeout=5,
        )
    except Exception:
        pass
    return "timeout"


def confirm_via_telegram(question: str, screenshot_url: Optional[str] = None,
                         timeout: int = TIMEOUT_SECONDS) -> bool:
    """Block until Heath confirms or denies via Telegram. Default-deny on timeout."""
    pending_id = _create_pending(question, screenshot_url)
    if pending_id is None:
        log.warning("Could not create pending confirmation - default DENY")
        return False
    _send_telegram_with_buttons(
        f"Cole needs approval: {question}",
        pending_id,
        screenshot_url,
    )
    status = _poll_pending(pending_id, timeout=timeout)
    log.info("confirm_via_telegram pending_id=%s status=%s", pending_id, status)
    return status == "confirmed"


# ----------------------------------------------------------------------------
# Public guard entry point
# ----------------------------------------------------------------------------

class GuardResult:
    def __init__(self, allowed: bool, reason: str = "", approved_by: Optional[str] = None):
        self.allowed = allowed
        self.reason = reason
        self.approved_by = approved_by

    def __bool__(self) -> bool:
        return self.allowed

    def __repr__(self) -> str:
        return f"GuardResult(allowed={self.allowed}, reason={self.reason!r}, approved_by={self.approved_by!r})"


def evaluate_action(
    action_type: str,
    target: str = "",
    text_typed: str = "",
    recipient: str = "",
    visible_text: str = "",
    window_title: str = "",
    url: str = "",
    pre_screenshot_url: Optional[str] = None,
) -> GuardResult:
    """The single chokepoint. Every desktop action passes through this first.

    Returns a GuardResult with .allowed True/False. If a Telegram confirm fires,
    this BLOCKS until Heath answers (or timeout). On timeout, default DENY.
    """
    # 0. Lock check
    locked, reason = is_locked()
    if locked:
        return GuardResult(False, f"Desktop tool LOCKED: {reason or 'no reason given'}")

    payload = {
        "action_type": action_type,
        "target": target,
        "text_typed": text_typed,
    }
    blob = " ".join(filter(None, [visible_text, window_title, url, target, text_typed]))

    # 1. HARD-NEVER: bank sites
    if is_bank_site(url) or is_bank_site(window_title):
        if has_bank_consent():
            return GuardResult(True, "bank consent session active", approved_by="heath")
        return GuardResult(False, f"HARD-NEVER: bank site detected ({url or window_title}) without prior session consent")

    # 2. Destructive file action
    if is_destructive_file_action(payload):
        ok = confirm_via_telegram(
            f"Destructive file action: {action_type} {target}. Confirm?",
            screenshot_url=pre_screenshot_url,
        )
        return GuardResult(ok, "destructive file action requires confirm",
                           approved_by="heath" if ok else None)

    # 3. System settings
    if is_system_settings(window_title):
        ok = confirm_via_telegram(
            f"About to change system settings in '{window_title}'. Confirm?",
            screenshot_url=pre_screenshot_url,
        )
        return GuardResult(ok, "system-settings change requires confirm",
                           approved_by="heath" if ok else None)

    # 4. Spend > $20 (we use blob heuristic; precise $ extraction happens here)
    if is_spend_action(blob, action_payload={"type": action_type}):
        # Try to pull a dollar amount from the visible blob
        m = re.search(r"\$\s?(\d{1,6}(?:\.\d{2})?)", blob)
        amount = float(m.group(1)) if m else None
        if amount is not None and amount <= 20.0:
            # Under the gate - allow autonomously
            return GuardResult(True, f"spend ${amount:.2f} under $20 gate")
        prompt = f"About to spend"
        if amount is not None:
            prompt += f" ${amount:.2f}"
        prompt += f" on '{url or window_title or target}'. Confirm?"
        ok = confirm_via_telegram(prompt, screenshot_url=pre_screenshot_url)
        return GuardResult(ok, "spend over $20 requires confirm",
                           approved_by="heath" if ok else None)

    # 5. Customer comms
    if is_customer_comm(blob, recipient=recipient):
        ok = confirm_via_telegram(
            f"About to send customer comm to '{recipient or 'unknown recipient'}'. Confirm?",
            screenshot_url=pre_screenshot_url,
        )
        return GuardResult(ok, "customer comm requires confirm",
                           approved_by="heath" if ok else None)

    return GuardResult(True, "no gate triggered")
