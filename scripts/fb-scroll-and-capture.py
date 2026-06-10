"""fb-scroll-and-capture.py

Assumes a Facebook group page is already open in the foreground Chrome tab.
Scrolls down N times, captures a screenshot after each scroll, and saves them
to scripts/atlas-runs/fb-scroll-{ts}/.

Used after fb-join-via-pyautogui.py when we're already a member and need to
inspect recent posts visually (no DOM access from PyAutoGUI).
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
RUN_DIR = REPO_ROOT / "scripts" / "atlas-runs" / f"fb-scroll-{int(time.time())}"
RUN_DIR.mkdir(parents=True, exist_ok=True)

NUM_SCROLLS = 6
SCROLL_AMOUNT = -7  # negative = scroll down for pyautogui.scroll

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.15


def log(msg):
    print(f"[fb-scroll-capture] {msg}", flush=True)


def find_active_chrome():
    all_windows = gw.getAllWindows()
    for w in all_windows:
        try:
            if not w.title or not w.visible:
                continue
        except Exception:
            continue
        if "Google Chrome" in w.title and "about:blank" not in w.title:
            return w
    # Fallback to about:blank if that's what was navigated
    for w in all_windows:
        try:
            if "Google Chrome" in w.title and w.visible:
                return w
        except Exception:
            continue
    return None


def take_screenshot(path):
    with mss() as sct:
        sct.shot(output=str(path))


def main():
    result = {
        "ts": datetime.now().isoformat(),
        "screenshots": [],
    }

    win = find_active_chrome()
    if win is None:
        log("FATAL: no Chrome window found")
        sys.exit(2)

    log(f"Using window: {win.title!r}")
    try:
        win.activate()
        time.sleep(0.8)
    except Exception:
        pass

    # Position cursor in the center of the page area (below tab bar, above bottom)
    cx = win.left + win.width // 2
    cy = win.top + win.height // 2
    pyautogui.moveTo(cx, cy)
    time.sleep(0.3)

    # Initial screenshot
    p = RUN_DIR / "00-initial.png"
    take_screenshot(p)
    result["screenshots"].append(str(p))
    log(f"saved {p.name}")

    for i in range(1, NUM_SCROLLS + 1):
        # PyAutoGUI scroll wheel — negative = down
        pyautogui.scroll(-800)
        time.sleep(1.5)  # let FB lazy-load
        p = RUN_DIR / f"{i:02d}-scroll.png"
        take_screenshot(p)
        result["screenshots"].append(str(p))
        log(f"saved {p.name}")

    (RUN_DIR / "result.json").write_text(json.dumps(result, indent=2))
    log(f"DONE. run dir: {RUN_DIR}")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
