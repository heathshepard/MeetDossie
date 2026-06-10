"""Cole desktop control - Telegram kill switch.

Polls Telegram getUpdates for any message containing 'STOP' (case-insensitive)
from Heath's chat. When detected, sets desktop_session_state.locked=true and
raises KillSwitchTriggered on the next action attempt.

The polling thread runs as a daemon - it dies with the parent process. The
lock state lives in Supabase, so even if the polling thread misses an update,
any future invocation of __main__ will refuse to act while locked.

Unlock requires Heath to text RESUME (or call set_locked(False) directly).
"""

from __future__ import annotations

import os
import time
import logging
import threading
from pathlib import Path

import requests
from dotenv import load_dotenv

from guards import set_locked, is_locked

_REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(_REPO_ROOT / ".env.local")

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = str(os.getenv("TELEGRAM_CHAT_ID", "7874782923"))

POLL_INTERVAL = 3  # seconds
log = logging.getLogger("cole_desktop.kill_switch")


class KillSwitchTriggered(Exception):
    """Raised when Heath has texted STOP."""


_state = {
    "last_update_id": 0,
    "running": False,
}


def _fetch_updates() -> list:
    if not TELEGRAM_BOT_TOKEN:
        return []
    try:
        resp = requests.get(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/getUpdates",
            params={
                "offset": _state["last_update_id"] + 1,
                "timeout": 0,
                "allowed_updates": ["message"],
            },
            timeout=10,
        )
        if not resp.ok:
            return []
        data = resp.json()
        if data.get("ok"):
            return data.get("result", [])
    except Exception as e:
        log.warning("kill_switch fetch failed: %s", e)
    return []


def _handle_updates(updates: list) -> bool:
    """Returns True if STOP was seen. Side effect: updates last_update_id."""
    saw_stop = False
    for upd in updates:
        _state["last_update_id"] = max(_state["last_update_id"], upd.get("update_id", 0))
        msg = upd.get("message") or {}
        chat = msg.get("chat") or {}
        if str(chat.get("id")) != TELEGRAM_CHAT_ID:
            continue
        text = (msg.get("text") or "").strip().upper()
        if text == "STOP":
            saw_stop = True
            set_locked(True, "STOP received via Telegram")
            log.warning("KILL SWITCH: STOP received - desktop tool locked")
            # Echo back so Heath knows it was received
            try:
                requests.post(
                    f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
                    json={
                        "chat_id": TELEGRAM_CHAT_ID,
                        "text": "STOP received. Desktop control locked. Text RESUME to unlock.",
                    },
                    timeout=5,
                )
            except Exception:
                pass
        elif text == "RESUME":
            set_locked(False, "")
            log.info("RESUME received - desktop tool unlocked")
            try:
                requests.post(
                    f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
                    json={
                        "chat_id": TELEGRAM_CHAT_ID,
                        "text": "RESUME received. Desktop control unlocked.",
                    },
                    timeout=5,
                )
            except Exception:
                pass
    return saw_stop


def _poll_loop():
    log.info("Kill-switch poll loop started")
    while _state["running"]:
        try:
            updates = _fetch_updates()
            if updates:
                _handle_updates(updates)
        except Exception as e:
            log.warning("poll loop exception: %s", e)
        time.sleep(POLL_INTERVAL)
    log.info("Kill-switch poll loop stopped")


def start() -> threading.Thread:
    """Start the background polling thread (daemon). Returns the Thread."""
    if _state["running"]:
        log.info("Kill-switch already running")
        return None  # type: ignore
    _state["running"] = True
    t = threading.Thread(target=_poll_loop, name="cole-kill-switch", daemon=True)
    t.start()
    return t


def stop() -> None:
    _state["running"] = False


def ensure_unlocked() -> None:
    """Call before every state-changing action. Raises KillSwitchTriggered if locked."""
    locked, reason = is_locked()
    if locked:
        raise KillSwitchTriggered(f"Desktop tool locked: {reason or 'unknown'}")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    start()
    print("Kill-switch running. Text STOP to Telegram to test. Ctrl-C to exit.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        stop()
        print("Exiting.")
