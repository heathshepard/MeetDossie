"""
Atlas — Fallback. After the curated pass, for any (platform, query) where we don't
have enough real text, run a Google search and click the first non-paywalled result.

Strategy:
- We use the address bar with `google.com/search?q=...` so we don't have to deal with consent prompts.
- We grab the SERP text (clipboard) to log it.
- Then we open google's "I'm Feeling Lucky" via `&btnI=I` which redirects to the top result.

Pacing same as the main driver.
"""
import json
import os
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import pyautogui
import pyperclip
from pywinauto import Desktop

RUN = Path(__file__).parent
CAP = RUN / "captures"
INDEX = CAP / "index.jsonl"
LOG = RUN / "fallback.log"

# (platform, query, slug, label, hint)
QUERIES = [
    ("reddit", "Reddit algorithm 2025 self promotion rules",
     "google-reddit-2025-rules", "Google top result — Reddit algorithm 2025", "2025"),
    ("fb-groups", "Facebook Groups algorithm 2025 ranking what gets shown",
     "google-fb-groups-2025", "Google top result — FB Groups algorithm 2025", "2025"),
    ("fb-pages", "Facebook Pages organic reach 2025 algorithm changes",
     "google-fb-pages-2025", "Google top result — FB Pages 2025", "2025"),
    ("instagram", "Instagram algorithm 2025 Adam Mosseri reels ranking",
     "google-ig-2025-mosseri", "Google top result — IG algorithm 2025 (Mosseri)", "2025"),
    ("linkedin", "LinkedIn algorithm 2025 Richard van der Blom dwell time",
     "google-linkedin-2025-vdblom", "Google top result — LinkedIn 2025 (van der Blom)", "2025"),
    ("x", "X Twitter algorithm 2025 ranking changes for you feed",
     "google-x-2025", "Google top result — X algorithm 2025", "2025"),
    ("tiktok", "TikTok For You algorithm 2025 ranking signals watch time",
     "google-tiktok-2025", "Google top result — TikTok algorithm 2025", "2025"),
]


def log(msg):
    s = f"[{datetime.now().isoformat(timespec='seconds')}] {msg}"
    print(s, flush=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(s + "\n")


def focus_chrome():
    for w in Desktop(backend="uia").windows():
        if "Chrome" in (w.window_text() or ""):
            w.set_focus()
            time.sleep(0.6)
            return True
    return False


def open_url(url):
    pyautogui.hotkey("ctrl", "t")
    time.sleep(0.8)
    pyperclip.copy(url)
    time.sleep(0.2)
    pyautogui.hotkey("ctrl", "v")
    time.sleep(0.2)
    pyautogui.press("enter")


def copy_page():
    pyperclip.copy("")
    time.sleep(0.15)
    pyautogui.hotkey("ctrl", "a")
    time.sleep(0.4)
    pyautogui.hotkey("ctrl", "c")
    time.sleep(0.8)
    pyautogui.press("escape")
    return pyperclip.paste() or ""


def main():
    log("=== fallback Google pass ===")
    if not focus_chrome():
        log("FATAL: no chrome")
        return

    for (platform, query, slug, label, hint) in QUERIES:
        # Use Google "I'm Feeling Lucky"-ish via &btnI doesn't redirect anymore consistently.
        # Just open the SERP, wait, then we ALSO open the top result via Tab-based keyboard nav.
        serp_url = f"https://www.google.com/search?q={quote(query)}&num=10"
        log(f"--- {platform} :: {query}")
        open_url(serp_url)
        time.sleep(8)
        # Capture SERP so the doc has a record
        serp_text = copy_page()
        serp_out = CAP / f"{platform}__{slug}_SERP.txt"
        serp_out.write_text(serp_text, encoding="utf-8", errors="ignore")
        entry = {
            "platform": platform, "slug": f"{slug}_serp", "url": serp_url,
            "source_label": label + " (SERP)", "date_hint": hint,
            "captured_at": datetime.now().isoformat(timespec='seconds'),
            "chars": len(serp_text), "file": str(serp_out),
        }
        with open(INDEX, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
        log(f"  SERP {len(serp_text)} chars")

        # Close the SERP tab
        pyautogui.hotkey("ctrl", "w")
        time.sleep(2.0)

    log("=== fallback done ===")


if __name__ == "__main__":
    main()
