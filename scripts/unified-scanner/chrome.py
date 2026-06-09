"""Drive Heath's REAL Chrome via PyAutoGUI.

The unified scanner does NOT launch a fresh Playwright/Chromium browser. It
assumes Chrome is already open with Heath's logged-in profile and uses the
keyboard + clipboard to navigate and scrape. This is the same approach that
proved PlayHT was offline (SV-PLAYHT-001) -- bot-detection signals are
different when you drive Heath's real session.

Why this works:
- Heath is already authenticated on FB/IG/LinkedIn/Reddit in his Chrome.
- Ctrl+L focuses the address bar, type URL, Enter navigates.
- Ctrl+A + Ctrl+C copies the entire visible page text to clipboard.
- pyperclip reads the clipboard.
- For comment posting, the same Ctrl+L navigation puts us on the post page,
  then click box + type + submit.

Cole's desktop-control module owns the click/type primitives + the guards +
the audit log. We re-export the safe verbs here so each scanner module can
do ``from chrome import goto_url, copy_visible_text`` without dragging in
mss/PIL/pywinauto.
"""

from __future__ import annotations

import logging
import sys
import time
from pathlib import Path
from typing import Optional

import pyautogui
import pyperclip

# Add desktop-control to sys.path so we can reuse cole_desktop's primitives.
_THIS_DIR = Path(__file__).resolve().parent
_DESKTOP_CONTROL = _THIS_DIR.parent / "desktop-control"
if str(_DESKTOP_CONTROL) not in sys.path:
    sys.path.insert(0, str(_DESKTOP_CONTROL))

try:
    import cole_desktop as desktop  # noqa: F401 -- re-exported for callers
    _DESKTOP_AVAILABLE = True
except Exception as e:  # pragma: no cover
    logging.warning("cole_desktop not importable: %s", e)
    desktop = None  # type: ignore
    _DESKTOP_AVAILABLE = False

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.08

log = logging.getLogger("unified_scanner.chrome")


# ----------------------------------------------------------------------------
# Window focus helpers
# ----------------------------------------------------------------------------

def focus_chrome() -> bool:
    """Best-effort: bring an existing Chrome window to the foreground.

    If pywinauto / cole_desktop isn't available, fall back to alt-tab cycling.
    We don't launch Chrome ourselves -- Heath has it open. If we can't find
    it, the caller should bail.
    """
    if _DESKTOP_AVAILABLE:
        try:
            from pywinauto import Desktop
            for w in Desktop(backend="uia").windows():
                try:
                    title = (w.window_text() or "").lower()
                except Exception:
                    continue
                if "google chrome" in title or "chrome" in title.split(" - ")[-1].lower():
                    try:
                        w.set_focus()
                        time.sleep(0.3)
                        return True
                    except Exception:
                        continue
        except Exception as e:
            log.debug("pywinauto chrome focus failed: %s", e)

    # Fallback: just hope it's already foregrounded
    return False


# ----------------------------------------------------------------------------
# Address-bar navigation
# ----------------------------------------------------------------------------

def goto_url(url: str, settle_seconds: float = 4.0) -> None:
    """Focus address bar, type URL, press Enter, wait for page to settle.

    Caller must ensure Chrome is the active window before calling. We can't
    guarantee that from inside Python -- ``focus_chrome()`` is best-effort.
    """
    focus_chrome()
    pyautogui.hotkey("ctrl", "l")
    time.sleep(0.25)
    # Clear any existing URL highlighted in the address bar.
    pyautogui.press("delete")
    time.sleep(0.1)
    # Use clipboard for URLs that contain special chars (faster + correct).
    pyperclip.copy(url)
    time.sleep(0.1)
    pyautogui.hotkey("ctrl", "v")
    time.sleep(0.2)
    pyautogui.press("enter")
    time.sleep(settle_seconds)


def copy_visible_text() -> str:
    """Select all + copy. Returns the page text from the clipboard.

    The clipboard is the lowest-friction scrape -- Chrome's "view source"
    Ctrl+U or DevTools would be lower-noise but require window focus and
    extra clicks. ``Ctrl+A; Ctrl+C`` runs in the page, picks up the text
    layer (skipping <script> blocks), and we get a clean string.
    """
    # Stash the existing clipboard so we don't clobber Heath's copy buffer.
    try:
        prior = pyperclip.paste()
    except Exception:
        prior = ""

    # Move focus into the document body (Esc collapses any selection /
    # closes most modals -- Tab moves into the page DOM).
    pyautogui.press("escape")
    time.sleep(0.15)

    pyperclip.copy("")  # clear so we can detect a real result
    time.sleep(0.1)

    pyautogui.hotkey("ctrl", "a")
    time.sleep(0.25)
    pyautogui.hotkey("ctrl", "c")
    time.sleep(0.6)

    text = ""
    try:
        text = pyperclip.paste() or ""
    except Exception:
        text = ""

    # Best-effort: restore prior clipboard content.
    try:
        if prior and prior != text:
            pyperclip.copy(prior)
    except Exception:
        pass

    return text


def scroll(amount: int = -800) -> None:
    """Scroll the page. Negative = down, positive = up."""
    pyautogui.scroll(amount)
    time.sleep(0.4)


def scroll_to_top() -> None:
    pyautogui.hotkey("ctrl", "home")
    time.sleep(0.3)


def press_key(key: str) -> None:
    pyautogui.press(key)
    time.sleep(0.1)


def type_text(text: str, interval: float = 0.02) -> None:
    """Type literal text via PyAutoGUI (use for short ASCII strings only)."""
    pyautogui.typewrite(text, interval=interval)


def paste_text(text: str) -> None:
    """Copy text to clipboard then Ctrl+V. Handles unicode + long strings."""
    pyperclip.copy(text)
    time.sleep(0.15)
    pyautogui.hotkey("ctrl", "v")
    time.sleep(0.25)


def click_xy(x: int, y: int) -> None:
    pyautogui.click(x=x, y=y)
    time.sleep(0.3)


def screen_size() -> tuple:
    return tuple(pyautogui.size())  # type: ignore


# ----------------------------------------------------------------------------
# Guard hook
# ----------------------------------------------------------------------------

def kill_switch_check() -> bool:
    """Returns True if kill switch is engaged (caller should abort)."""
    if not _DESKTOP_AVAILABLE:
        return False
    try:
        # Re-import locally so we don't add desktop-control to global namespace.
        import guards  # type: ignore
        locked, _reason = guards.is_locked()
        return bool(locked)
    except Exception:
        return False
