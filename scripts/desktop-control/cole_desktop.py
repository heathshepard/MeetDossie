"""Cole desktop control - core driver.

Functions for screenshot, click, type, hotkey, drag, window lookup, and audit
logging. Every state-changing action passes through guards.py BEFORE being
invoked. This module is the low-level tool layer - it does NOT make policy
decisions about whether an action is allowed.

All actions are logged to Supabase `desktop_actions` table with before/after
screenshots uploaded to the `desktop-screenshots` public bucket.

Phase 1 scope:
- Screenshots via mss (fast, no external bin)
- Cursor + keyboard via pyautogui
- Native Windows app lookup via pywinauto
- Logging via Supabase REST (no extra dep beyond requests)
- OCR/read_text_at deferred to Phase 3 (Tesseract is a hassle on Windows)
"""

from __future__ import annotations

import io
import os
import time
import uuid
import logging
from pathlib import Path
from typing import Optional, Sequence, Tuple

import pyautogui
import requests
from dotenv import load_dotenv
from mss import mss
from PIL import Image

# pywinauto is optional at import time - only required when find_window is called
try:
    from pywinauto import Desktop, Application
    _PYWINAUTO_OK = True
except Exception as _e:  # noqa
    Desktop = None  # type: ignore
    Application = None  # type: ignore
    _PYWINAUTO_OK = False

# Load env from the MeetDossie .env.local (repo root, two levels up from this file)
_REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(_REPO_ROOT / ".env.local")

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

SCREENSHOT_BUCKET = "desktop-screenshots"

# PyAutoGUI safety: leave failsafe ON. Slamming cursor to top-left of screen
# abort-raises FailSafeException. Adds a second physical kill switch.
pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.1  # small pause between actions for native app responsiveness

log = logging.getLogger("cole_desktop")


# ----------------------------------------------------------------------------
# Supabase helpers
# ----------------------------------------------------------------------------

def _sb_headers(extra: Optional[dict] = None) -> dict:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured")
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
    }
    if extra:
        headers.update(extra)
    return headers


def _upload_png(path_in_bucket: str, png_bytes: bytes) -> Optional[str]:
    """Upload PNG to Supabase Storage, return public URL or None on failure."""
    if not SUPABASE_URL:
        log.warning("SUPABASE_URL not set - skipping screenshot upload")
        return None
    url = f"{SUPABASE_URL}/storage/v1/object/{SCREENSHOT_BUCKET}/{path_in_bucket}"
    try:
        resp = requests.post(
            url,
            headers=_sb_headers({
                "Content-Type": "image/png",
                "x-upsert": "true",
            }),
            data=png_bytes,
            timeout=15,
        )
        if resp.status_code not in (200, 201):
            log.warning("Screenshot upload failed: %s %s", resp.status_code, resp.text[:200])
            return None
    except Exception as e:
        log.warning("Screenshot upload exception: %s", e)
        return None
    return f"{SUPABASE_URL}/storage/v1/object/public/{SCREENSHOT_BUCKET}/{path_in_bucket}"


def log_action(
    action_type: str,
    target: Optional[str] = None,
    text_typed: Optional[str] = None,
    screenshot_before_url: Optional[str] = None,
    screenshot_after_url: Optional[str] = None,
    requested_by: str = "cole",
    approved_by: Optional[str] = None,
    result: str = "success",
) -> Optional[int]:
    """Insert a row into desktop_actions. Returns the new row id or None."""
    if not SUPABASE_URL:
        log.warning("SUPABASE_URL not set - skipping action log")
        return None
    payload = {
        "action_type": action_type,
        "target": target,
        "text_typed": text_typed,
        "screenshot_before_url": screenshot_before_url,
        "screenshot_after_url": screenshot_after_url,
        "requested_by": requested_by,
        "approved_by": approved_by,
        "result": result,
    }
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/desktop_actions",
            headers=_sb_headers({
                "Content-Type": "application/json",
                "Prefer": "return=representation",
            }),
            json=payload,
            timeout=10,
        )
        if resp.status_code not in (200, 201):
            log.warning("log_action insert failed: %s %s", resp.status_code, resp.text[:200])
            return None
        data = resp.json()
        if isinstance(data, list) and data:
            return data[0].get("id")
    except Exception as e:
        log.warning("log_action exception: %s", e)
    return None


# ----------------------------------------------------------------------------
# Screenshot
# ----------------------------------------------------------------------------

def _capture_full_desktop_png() -> bytes:
    """Capture all monitors as a single PNG, return bytes."""
    with mss() as sct:
        # Monitor 0 = "all monitors" virtual canvas in mss
        sct_img = sct.grab(sct.monitors[0])
        img = Image.frombytes("RGB", sct_img.size, sct_img.rgb)
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=True)
        return buf.getvalue()


def screenshot(label: str = "shot") -> str:
    """Capture full desktop, upload to Supabase, return public URL (or empty)."""
    safe_label = "".join(c if c.isalnum() or c in "-_" else "_" for c in label)[:40]
    fname = f"{int(time.time())}-{safe_label}-{uuid.uuid4().hex[:6]}.png"
    png_bytes = _capture_full_desktop_png()
    url = _upload_png(fname, png_bytes)
    return url or ""


# ----------------------------------------------------------------------------
# Window lookup (pywinauto)
# ----------------------------------------------------------------------------

def find_window(title_substring: str):
    """Find a top-level window whose title contains the substring (case-insensitive).

    Returns a pywinauto WindowSpecification or None. Caller can call .wait('visible')
    or extract .rectangle() / .child_window(...).
    """
    if not _PYWINAUTO_OK:
        log.error("pywinauto not available - cannot find_window")
        return None
    needle = title_substring.lower()
    try:
        windows = Desktop(backend="uia").windows()
        for w in windows:
            try:
                title = w.window_text() or ""
            except Exception:
                title = ""
            if needle in title.lower():
                return w
    except Exception as e:
        log.warning("find_window failure: %s", e)
    return None


# ----------------------------------------------------------------------------
# Click / type / hotkey / drag
# ----------------------------------------------------------------------------

def _do_with_screenshots(
    action_type: str,
    target: str,
    fn,
    text_typed: Optional[str] = None,
    requested_by: str = "cole",
    approved_by: Optional[str] = None,
    capture_after: bool = True,
) -> dict:
    """Internal: bracket an action with before/after screenshots + logging."""
    before_url = screenshot(f"{action_type}-before")
    err: Optional[Exception] = None
    try:
        fn()
        result = "success"
    except pyautogui.FailSafeException as e:
        result = "aborted-failsafe"
        err = e
    except Exception as e:
        result = "failure"
        err = e

    # Allow UI to settle before capturing after-shot
    if capture_after:
        time.sleep(0.25)
        after_url = screenshot(f"{action_type}-after")
    else:
        after_url = ""

    row_id = log_action(
        action_type=action_type,
        target=target,
        text_typed=text_typed,
        screenshot_before_url=before_url,
        screenshot_after_url=after_url,
        requested_by=requested_by,
        approved_by=approved_by,
        result=result,
    )

    out = {
        "action_id": row_id,
        "action_type": action_type,
        "target": target,
        "result": result,
        "screenshot_before_url": before_url,
        "screenshot_after_url": after_url,
    }
    if err:
        out["error"] = str(err)
    return out


def click(x: int, y: int, button: str = "left", requested_by: str = "cole",
          approved_by: Optional[str] = None) -> dict:
    """Move cursor to (x, y) and click. Logs before/after screenshots."""
    return _do_with_screenshots(
        action_type="click",
        target=f"({x},{y}) {button}",
        fn=lambda: pyautogui.click(x=x, y=y, button=button),
        requested_by=requested_by,
        approved_by=approved_by,
    )


def double_click(x: int, y: int, requested_by: str = "cole",
                 approved_by: Optional[str] = None) -> dict:
    return _do_with_screenshots(
        action_type="double_click",
        target=f"({x},{y})",
        fn=lambda: pyautogui.doubleClick(x=x, y=y),
        requested_by=requested_by,
        approved_by=approved_by,
    )


def type_text(text: str, redact_password: bool = False, interval: float = 0.02,
              requested_by: str = "cole",
              approved_by: Optional[str] = None) -> dict:
    """Type a string at current cursor. If redact_password, logged value is masked."""
    logged_text = "[REDACTED-PASSWORD]" if redact_password else text
    return _do_with_screenshots(
        action_type="type",
        target=f"len={len(text)}",
        fn=lambda: pyautogui.typewrite(text, interval=interval),
        text_typed=logged_text,
        requested_by=requested_by,
        approved_by=approved_by,
    )


def hotkey(*keys: str, requested_by: str = "cole",
           approved_by: Optional[str] = None) -> dict:
    """Press a keyboard combo (e.g. hotkey('ctrl','s'))."""
    return _do_with_screenshots(
        action_type="hotkey",
        target="+".join(keys),
        fn=lambda: pyautogui.hotkey(*keys),
        requested_by=requested_by,
        approved_by=approved_by,
    )


def press_key(key: str, requested_by: str = "cole",
              approved_by: Optional[str] = None) -> dict:
    return _do_with_screenshots(
        action_type="press_key",
        target=key,
        fn=lambda: pyautogui.press(key),
        requested_by=requested_by,
        approved_by=approved_by,
    )


def drag(x1: int, y1: int, x2: int, y2: int, duration: float = 0.4,
         requested_by: str = "cole",
         approved_by: Optional[str] = None) -> dict:
    def _do():
        pyautogui.moveTo(x1, y1)
        pyautogui.dragTo(x2, y2, duration=duration, button="left")
    return _do_with_screenshots(
        action_type="drag",
        target=f"({x1},{y1})->({x2},{y2})",
        fn=_do,
        requested_by=requested_by,
        approved_by=approved_by,
    )


def move_to(x: int, y: int, requested_by: str = "cole",
            approved_by: Optional[str] = None) -> dict:
    return _do_with_screenshots(
        action_type="move",
        target=f"({x},{y})",
        fn=lambda: pyautogui.moveTo(x, y, duration=0.2),
        requested_by=requested_by,
        approved_by=approved_by,
        capture_after=False,
    )


def screen_size() -> Tuple[int, int]:
    w, h = pyautogui.size()
    return int(w), int(h)


def read_text_at(region: Tuple[int, int, int, int]) -> str:
    """OCR readback - deferred to Phase 3 (requires Tesseract). Returns ''."""
    log.info("read_text_at called but OCR not enabled in Phase 1 (region=%s)", region)
    return ""


# ----------------------------------------------------------------------------
# Convenience entry point for ad-hoc testing
# ----------------------------------------------------------------------------

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    url = screenshot("manual-test")
    print("Screenshot URL:", url or "(upload failed - check SUPABASE_URL)")
    print("Screen size:", screen_size())
