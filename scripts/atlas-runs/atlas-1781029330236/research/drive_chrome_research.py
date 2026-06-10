"""
Atlas — Cited platform algorithm research driver.

Drives Heath's real logged-in Chrome via PyAutoGUI + pywinauto.
For each platform, opens curated authoritative URLs (Mosseri/Meta/X eng/Buffer/Hootsuite/Later/van der Blom),
copies visible page text, and writes a raw capture log.

Sources are curated (not blind googled) so we know they are trustworthy AND recent.
Heath sees the cursor move; pacing is 30-60s per source.

OUT: research/captures/<platform>__<slug>.txt + research/captures/index.jsonl
"""
import json
import os
import sys
import time
import subprocess
from datetime import datetime
from pathlib import Path

import pyautogui
import pyperclip
from pywinauto import Desktop

RUN_DIR = Path(__file__).parent
CAPTURES_DIR = RUN_DIR / "captures"
CAPTURES_DIR.mkdir(parents=True, exist_ok=True)

INDEX_PATH = CAPTURES_DIR / "index.jsonl"
LOG_PATH = RUN_DIR / "research.log"

# ----------- CURATED SOURCES (trustworthy + 2025-2026 where possible) -----------
# Each entry: (platform, slug, url, source_label, expected_date_hint)
SOURCES = [
    # ----------------- REDDIT -----------------
    ("reddit", "reddit-help-content-policy",
     "https://support.reddithelp.com/hc/en-us/articles/360043071072-What-constitutes-spam-Self-promotion-on-Reddit",
     "Reddit Help Center", "current policy"),
    ("reddit", "buffer-reddit-marketing",
     "https://buffer.com/library/reddit-marketing/",
     "Buffer", "2024-2025"),
    ("reddit", "hootsuite-reddit-algorithm",
     "https://blog.hootsuite.com/reddit-marketing/",
     "Hootsuite", "2024-2025"),
    ("reddit", "later-reddit-best-times",
     "https://later.com/blog/best-time-to-post-on-reddit/",
     "Later", "2025"),
    ("reddit", "sprout-reddit-strategy",
     "https://sproutsocial.com/insights/reddit-marketing/",
     "Sprout Social", "2024-2025"),

    # ----------------- FACEBOOK GROUPS -----------------
    ("fb-groups", "meta-groups-help",
     "https://www.facebook.com/help/1629740080681586",
     "Meta Help — Groups", "current"),
    ("fb-groups", "meta-feed-ranking-2023",
     "https://about.fb.com/news/2023/06/how-facebook-and-instagram-decide-what-you-see/",
     "Meta Newsroom — ranking transparency", "2023 (canonical, still cited)"),
    ("fb-groups", "buffer-facebook-algorithm",
     "https://buffer.com/library/facebook-algorithm/",
     "Buffer", "2024-2025"),
    ("fb-groups", "hootsuite-fb-groups",
     "https://blog.hootsuite.com/facebook-groups-for-business/",
     "Hootsuite", "2024-2025"),
    ("fb-groups", "later-best-times-fb",
     "https://later.com/blog/best-time-to-post-on-facebook/",
     "Later", "2025"),

    # ----------------- FACEBOOK PAGES -----------------
    ("fb-pages", "meta-page-reach",
     "https://www.facebook.com/business/help/1622464934712872",
     "Meta Business Help", "current"),
    ("fb-pages", "buffer-fb-pages",
     "https://buffer.com/library/facebook-pages/",
     "Buffer", "2024-2025"),
    ("fb-pages", "hootsuite-fb-reach",
     "https://blog.hootsuite.com/facebook-organic-reach-declining/",
     "Hootsuite", "2024-2025"),
    ("fb-pages", "socialinsider-fb-2025",
     "https://www.socialinsider.io/blog/facebook-benchmarks/",
     "SocialInsider", "2025"),
    ("fb-pages", "later-fb-page-strategy",
     "https://later.com/blog/facebook-marketing-strategy/",
     "Later", "2024-2025"),

    # ----------------- INSTAGRAM -----------------
    ("instagram", "mosseri-instagram-2025",
     "https://creators.instagram.com/blog/instagram-ranking-explained",
     "Adam Mosseri / @creators", "2025"),
    ("instagram", "instagram-reels-ranking",
     "https://help.instagram.com/1986234648360433",
     "Instagram Help — Reels", "current"),
    ("instagram", "later-instagram-algorithm",
     "https://later.com/blog/how-instagram-algorithm-works/",
     "Later", "2025"),
    ("instagram", "hootsuite-instagram-algorithm",
     "https://blog.hootsuite.com/instagram-algorithm/",
     "Hootsuite", "2025"),
    ("instagram", "buffer-instagram-2025",
     "https://buffer.com/library/instagram-algorithm/",
     "Buffer", "2025"),
    ("instagram", "later-best-times-ig",
     "https://later.com/blog/best-time-to-post-on-instagram/",
     "Later", "2025"),

    # ----------------- LINKEDIN -----------------
    ("linkedin", "linkedin-content-relevance",
     "https://www.linkedin.com/help/linkedin/answer/a548527/feed-relevance",
     "LinkedIn Help", "current"),
    ("linkedin", "vanderblom-algo-report-2024",
     "https://www.justconnecting.nl/post/linkedin-algorithm-research-report-2024",
     "Richard van der Blom (industry standard)", "2024-2025"),
    ("linkedin", "buffer-linkedin-algorithm",
     "https://buffer.com/library/linkedin-algorithm/",
     "Buffer", "2024-2025"),
    ("linkedin", "hootsuite-linkedin-algorithm",
     "https://blog.hootsuite.com/linkedin-algorithm/",
     "Hootsuite", "2024-2025"),
    ("linkedin", "later-best-times-linkedin",
     "https://later.com/blog/best-time-to-post-on-linkedin/",
     "Later", "2025"),

    # ----------------- X / TWITTER -----------------
    ("x", "x-eng-blog-algorithm",
     "https://blog.twitter.com/engineering/en_us/topics/open-source/2023/twitter-recommendation-algorithm",
     "X Engineering Blog (algorithm open-sourced)", "2023 (canonical)"),
    ("x", "buffer-x-algorithm",
     "https://buffer.com/library/twitter-algorithm/",
     "Buffer", "2024-2025"),
    ("x", "hootsuite-x-algorithm",
     "https://blog.hootsuite.com/twitter-algorithm/",
     "Hootsuite", "2024-2025"),
    ("x", "later-x-algorithm",
     "https://later.com/blog/twitter-algorithm/",
     "Later", "2025"),
    ("x", "sprout-x-strategy",
     "https://sproutsocial.com/insights/twitter-marketing/",
     "Sprout Social", "2024-2025"),

    # ----------------- TIKTOK -----------------
    ("tiktok", "tiktok-newsroom-fyp",
     "https://newsroom.tiktok.com/en-us/how-tiktok-recommends-content",
     "TikTok Newsroom", "current"),
    ("tiktok", "later-tiktok-algorithm",
     "https://later.com/blog/tiktok-algorithm/",
     "Later", "2025"),
    ("tiktok", "hootsuite-tiktok-algorithm",
     "https://blog.hootsuite.com/tiktok-algorithm/",
     "Hootsuite", "2024-2025"),
    ("tiktok", "buffer-tiktok-algorithm",
     "https://buffer.com/library/tiktok-algorithm/",
     "Buffer", "2024-2025"),
    ("tiktok", "later-best-times-tiktok",
     "https://later.com/blog/best-time-to-post-on-tiktok/",
     "Later", "2025"),
]


def log(msg: str):
    stamp = datetime.now().isoformat(timespec="seconds")
    line = f"[{stamp}] {msg}"
    print(line, flush=True)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def find_chrome():
    """Return the topmost Chrome window."""
    for w in Desktop(backend="uia").windows():
        title = w.window_text() or ""
        if "Google Chrome" in title or "- Chrome" in title:
            return w
    return None


def focus_chrome(win) -> bool:
    try:
        win.set_focus()
        time.sleep(0.6)
        return True
    except Exception as e:
        log(f"focus failed: {e}")
        return False


def chrome_hotkey(*keys):
    pyautogui.hotkey(*keys)
    time.sleep(0.4)


def open_url(url: str):
    """Open url in a new tab in the focused Chrome."""
    chrome_hotkey("ctrl", "t")
    time.sleep(0.8)
    # Address bar should be focused. Paste URL.
    pyperclip.copy(url)
    time.sleep(0.2)
    chrome_hotkey("ctrl", "v")
    time.sleep(0.2)
    pyautogui.press("enter")


def wait_for_page(seconds: float):
    time.sleep(seconds)


def copy_page_text() -> str:
    """Ctrl+A then Ctrl+C to grab visible page text, with light cleanup."""
    pyperclip.copy("")  # clear
    time.sleep(0.15)
    chrome_hotkey("ctrl", "a")
    time.sleep(0.5)
    chrome_hotkey("ctrl", "c")
    time.sleep(0.8)
    # click somewhere safe to clear selection
    # (don't click — could navigate. Just escape.)
    pyautogui.press("escape")
    time.sleep(0.15)
    try:
        text = pyperclip.paste() or ""
    except Exception:
        text = ""
    return text


def close_tab():
    chrome_hotkey("ctrl", "w")
    time.sleep(0.4)


def capture_one(platform: str, slug: str, url: str, source_label: str, date_hint: str, wait_sec: float = 10.0):
    log(f"--- {platform}/{slug} :: {url}")
    open_url(url)
    wait_for_page(wait_sec)
    # Scroll down a couple times so JS-rendered content paints + Heath sees motion
    for _ in range(3):
        pyautogui.press("pagedown")
        time.sleep(0.7)
    # Back to top so select-all picks everything
    pyautogui.hotkey("ctrl", "home")
    time.sleep(0.6)
    text = copy_page_text()
    if not text.strip():
        log(f"  EMPTY clipboard — page may still be loading or blocked. Retrying once.")
        wait_for_page(5.0)
        text = copy_page_text()

    cleaned = text.strip()
    out_path = CAPTURES_DIR / f"{platform}__{slug}.txt"
    out_path.write_text(cleaned, encoding="utf-8", errors="ignore")

    entry = {
        "platform": platform,
        "slug": slug,
        "url": url,
        "source_label": source_label,
        "date_hint": date_hint,
        "captured_at": datetime.now().isoformat(timespec="seconds"),
        "chars": len(cleaned),
        "file": str(out_path),
    }
    with open(INDEX_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")
    log(f"  captured {len(cleaned)} chars -> {out_path.name}")

    close_tab()
    # pacing — Heath sees the cursor move; don't speed-blast.
    time.sleep(3.0)


def main():
    log(f"=== Atlas cited-research run starting ===")
    log(f"sources queued: {len(SOURCES)}")

    win = find_chrome()
    if not win:
        log("FATAL: no Chrome window found. Open Chrome first.")
        sys.exit(2)
    log(f"found Chrome: {win.window_text()!r}")
    if not focus_chrome(win):
        log("FATAL: could not focus Chrome.")
        sys.exit(3)

    # pre-flight: open a blank tab so we don't accidentally interact with whatever is open
    log("opening pre-flight blank tab")
    chrome_hotkey("ctrl", "t")
    time.sleep(0.8)

    # work the list
    completed = 0
    for (platform, slug, url, source_label, date_hint) in SOURCES:
        try:
            capture_one(platform, slug, url, source_label, date_hint)
            completed += 1
        except Exception as e:
            log(f"  ERROR on {slug}: {e}")
            # try to close any stray tab
            try:
                close_tab()
            except Exception:
                pass
            continue

    log(f"=== done. {completed}/{len(SOURCES)} sources captured ===")


if __name__ == "__main__":
    main()
