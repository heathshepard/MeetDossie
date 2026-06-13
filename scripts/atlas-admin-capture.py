"""atlas-admin-capture.py

Drive Heath's already-logged-in real Chrome to capture admin-view screenshots
of @meetdossie on Twitter/X, Facebook Page, and LinkedIn Company Page.

Why this exists (Sage engagement audit 2026-06-12):
- Sage's audit could only see logged-out profile views.
- We need server-side / admin-view confirmation of whether posts are actually
  reaching the timeline (vs. shadow-banned or distribution-suppressed).
- Logged-OUT view shows nothing on Twitter @meetdossie. Admin view will reveal
  whether posts exist on the timeline and what their reach numbers are.
- PyAutoGUI on real Chrome (NOT fresh Playwright) — Heath is logged into all
  3 platforms in his main Chrome session.

Strategy:
- Find an existing Chrome window (prefer about:blank).
- For each platform URL: open new tab, paste URL, wait, fullscreen screenshot.
- Save screenshots to Engineering/sage-engagement-audit-2026-06-12/admin-views/.
- Close tabs when done.
- Emit JSON to stdout summarizing what was captured.

Outcome JSON:
  {
    "twitter":   { "ok": true,  "screenshot": "<abs path>", "url": "..." },
    "facebook":  { "ok": true,  "screenshot": "<abs path>", "url": "..." },
    "linkedin":  { "ok": true,  "screenshot": "<abs path>", "url": "..." }
  }
"""

import json
import subprocess
import sys
import time
import ctypes
from datetime import datetime
from pathlib import Path

import pyautogui
import pygetwindow as gw
from mss import mss

REPO_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = Path(r"C:\Users\Heath Shepard\Desktop\Shepard-Ventures\Engineering\sage-engagement-audit-2026-06-12\admin-views")

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.12

TARGETS = [
    {
        "key": "twitter",
        "url": "https://twitter.com/meetdossie/analytics",
        "wait_s": 8,
        "label": "Twitter @meetdossie analytics (admin view, last 7d)",
    },
    {
        "key": "twitter-profile",
        "url": "https://twitter.com/meetdossie",
        "wait_s": 6,
        "label": "Twitter @meetdossie profile (admin view)",
    },
    {
        "key": "facebook-page",
        "url": "https://www.facebook.com/MeetDossie",
        "wait_s": 7,
        "label": "Facebook MeetDossie page (admin view)",
    },
    {
        "key": "facebook-insights",
        "url": "https://www.facebook.com/MeetDossie/insights",
        "wait_s": 9,
        "label": "Facebook MeetDossie insights dashboard",
    },
    {
        "key": "linkedin-analytics",
        "url": "https://www.linkedin.com/company/meetdossie/admin/analytics/",
        "wait_s": 9,
        "label": "LinkedIn meetdossie company page analytics",
    },
    {
        "key": "instagram-profile",
        "url": "https://www.instagram.com/meetdossie/",
        "wait_s": 6,
        "label": "Instagram @meetdossie profile (admin view)",
    },
    {
        "key": "instagram-following",
        "url": "https://www.instagram.com/meetdossie/following",
        "wait_s": 6,
        "label": "Instagram @meetdossie following list (146 accounts)",
    },
]


def log(msg):
    print(f"[atlas-admin-capture] {msg}", flush=True)


def screenshot(path):
    with mss() as sct:
        sct.shot(output=str(path))


def set_clipboard(text):
    proc = subprocess.run(
        ["powershell", "-NoProfile", "-Command", "$input | Set-Clipboard"],
        input=text,
        text=True,
        encoding="utf-8",
        capture_output=True,
    )
    return proc.returncode == 0


def find_chrome_window():
    all_windows = gw.getAllWindows()
    chrome_wins = []
    for w in all_windows:
        try:
            if not w.title or not w.visible or w.isMinimized:
                continue
        except Exception:
            continue
        if "Google Chrome" in w.title:
            chrome_wins.append(w)
    if not chrome_wins:
        return None
    main_wins = [w for w in chrome_wins if w.width >= 1000]
    pool = main_wins if main_wins else chrome_wins
    blanks = [w for w in pool if "about:blank" in (w.title or "").lower()]
    candidates = blanks if blanks else pool
    return max(candidates, key=lambda w: w.width * w.height)


def activate_window(win):
    try:
        if win.isMinimized:
            win.restore()
        user32 = ctypes.windll.user32
        user32.keybd_event(0x12, 0, 0, 0)
        user32.keybd_event(0x12, 0, 2, 0)
        time.sleep(0.05)
        try:
            win.activate()
        except Exception:
            pass
        try:
            hwnd = win._hWnd
            user32.ShowWindow(hwnd, 9)
            user32.SetForegroundWindow(hwnd)
            user32.BringWindowToTop(hwnd)
            user32.SetActiveWindow(hwnd)
        except Exception:
            pass
        time.sleep(0.7)
    except Exception as e:
        log(f"activate warning: {e}")


def navigate_to(url):
    pyautogui.hotkey("ctrl", "t")
    time.sleep(0.7)
    pyautogui.hotkey("ctrl", "l")
    time.sleep(0.3)
    set_clipboard(url)
    time.sleep(0.2)
    pyautogui.hotkey("ctrl", "v")
    time.sleep(0.25)
    pyautogui.press("enter")


def close_tab():
    pyautogui.hotkey("ctrl", "w")
    time.sleep(0.3)


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    results = {}

    win = find_chrome_window()
    if not win:
        log("ERROR: no Chrome window found")
        print(json.dumps({"ok": False, "error": "chrome_missing"}))
        sys.exit(1)

    log(f"using Chrome window: '{win.title[:80]}' ({win.width}x{win.height})")
    activate_window(win)

    for t in TARGETS:
        log(f"--- capturing {t['key']} ({t['label']}) ---")
        try:
            activate_window(win)
            navigate_to(t["url"])
            log(f"waiting {t['wait_s']}s for page to settle")
            time.sleep(t["wait_s"])
            # Scroll a bit so dynamic content loads
            pyautogui.scroll(-3)
            time.sleep(1.0)
            pyautogui.scroll(3)
            time.sleep(0.5)

            ts = datetime.now().strftime("%Y%m%d-%H%M%S")
            out_path = OUTPUT_DIR / f"{t['key']}-{ts}.png"
            screenshot(out_path)
            log(f"saved {out_path}")
            results[t["key"]] = {
                "ok": True,
                "screenshot": str(out_path),
                "url": t["url"],
                "label": t["label"],
            }
        except Exception as e:
            log(f"FAILED {t['key']}: {e}")
            results[t["key"]] = {"ok": False, "error": str(e), "url": t["url"]}

        try:
            close_tab()
        except Exception:
            pass
        time.sleep(0.5)

    log("done")
    print(json.dumps({"ok": True, "results": results}, indent=2))


if __name__ == "__main__":
    main()
