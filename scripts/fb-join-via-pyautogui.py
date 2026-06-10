"""fb-join-via-pyautogui.py

Drive Heath's already-open Chrome window to join the Boerne Real Estate FB group
and (if admitted) scan recent posts. Used when Playwright launchPersistentContext
collides with the open Chrome session.

Approach:
1. Activate the about:blank Chrome window (or any Chrome window).
2. Open a new tab (Ctrl+T) and navigate to the group URL.
3. Take a screenshot, OCR-free heuristic via window screenshot inspection isn't
   possible without Tesseract — so we rely on coordinate-stable Facebook UI
   patterns: Join button is typically in the top-right of the group header.
4. Save before/after screenshots for review.

Because we can't read the page DOM from PyAutoGUI, we keep this minimal:
- Navigate
- Wait for load
- Take a full screenshot
- Save it to scripts/atlas-runs/join-{ts}/screenshot.png
- Report the screenshot path back so a human (or Cole) can decide next step.

We DO NOT auto-click the Join button blindly — coordinates are not stable enough.
The screenshot is the deliverable; Cole sees it and decides whether to ping Heath.
"""

import os
import sys
import time
import json
from pathlib import Path
from datetime import datetime

import pyautogui
import pygetwindow as gw
from mss import mss

REPO_ROOT = Path(__file__).resolve().parents[1]
RUN_DIR = REPO_ROOT / "scripts" / "atlas-runs" / f"fb-join-{int(time.time())}"
RUN_DIR.mkdir(parents=True, exist_ok=True)

GROUP_URL = "https://www.facebook.com/groups/236047010341691/"

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.15


def log(msg):
    print(f"[fb-join-pyautogui] {msg}", flush=True)


def find_chrome_window():
    """Find the first visible Chrome window. Prefer about:blank if available."""
    all_windows = gw.getAllWindows()
    chrome_wins = []
    for w in all_windows:
        try:
            if not w.title or not w.visible:
                continue
        except Exception:
            continue
        if "Google Chrome" in w.title:
            chrome_wins.append(w)

    if not chrome_wins:
        return None

    # Prefer about:blank window (least disruptive)
    for w in chrome_wins:
        if "about:blank" in w.title.lower():
            return w
    return chrome_wins[0]


def take_screenshot(path):
    with mss() as sct:
        sct.shot(output=str(path))


def main():
    result = {
        "ts": datetime.now().isoformat(),
        "group_url": GROUP_URL,
        "steps": [],
        "screenshots": [],
        "outcome": None,
    }

    win = find_chrome_window()
    if win is None:
        result["outcome"] = "no_chrome_window"
        log("FATAL: no Chrome window found")
        (RUN_DIR / "result.json").write_text(json.dumps(result, indent=2))
        sys.exit(2)

    log(f"Using Chrome window: {win.title!r} at ({win.left},{win.top}) {win.width}x{win.height}")
    result["window"] = {"title": win.title, "rect": [win.left, win.top, win.width, win.height]}

    # Activate window
    try:
        if win.isMinimized:
            win.restore()
        win.activate()
        time.sleep(0.8)
    except Exception as e:
        log(f"window.activate warning: {e}")

    # Take BEFORE screenshot
    before = RUN_DIR / "01-before.png"
    take_screenshot(before)
    result["screenshots"].append(str(before))
    result["steps"].append("captured before screenshot")
    log(f"saved {before}")

    # Open new tab — Ctrl+T
    pyautogui.hotkey("ctrl", "t")
    time.sleep(0.6)
    result["steps"].append("opened new tab (ctrl+t)")

    # Focus address bar (Ctrl+L) just in case
    pyautogui.hotkey("ctrl", "l")
    time.sleep(0.3)

    # Type the URL using clipboard paste for reliability (typing fb URLs can autocomplete)
    import subprocess
    # Use PowerShell to set clipboard cleanly
    subprocess.run(
        ["powershell", "-NoProfile", "-Command", f"Set-Clipboard -Value '{GROUP_URL}'"],
        check=False,
        capture_output=True,
    )
    time.sleep(0.3)
    pyautogui.hotkey("ctrl", "v")
    time.sleep(0.3)
    pyautogui.press("enter")
    result["steps"].append(f"navigated to {GROUP_URL}")
    log("navigated; waiting for FB to load")

    # Wait for FB to render (FB is slow)
    time.sleep(9)

    # AFTER screenshot
    after = RUN_DIR / "02-loaded.png"
    take_screenshot(after)
    result["screenshots"].append(str(after))
    result["steps"].append("captured loaded screenshot")
    log(f"saved {after}")

    # We don't auto-click — pixel coords are too unstable. The screenshot tells us
    # what we need. Cole reviews and decides next step.
    result["outcome"] = "navigated_screenshot_saved"

    (RUN_DIR / "result.json").write_text(json.dumps(result, indent=2))
    log(f"DONE. run dir: {RUN_DIR}")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
