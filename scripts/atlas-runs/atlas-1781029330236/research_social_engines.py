"""Deep research run: how do real SaaS founders / agencies do
Reddit + Facebook Groups + Instagram engagement automation in 2025-2026?

Heath watches this happen on his real Chrome (no fresh Playwright).
Each step opens a new tab, navigates, scrolls slowly so Heath can see the page,
captures a screenshot, then moves on.

We hit:
  - Google searches for the key queries (so Heath sees the SERP)
  - Top 2-3 actual articles / GitHub repos / Reddit threads per query
  - Pricing pages for the paid SaaS competitors

Output:
  - research_run.log       (every action with timestamps)
  - findings.json          (structured: per platform -> queries -> URLs visited + notes)
  - per-page screenshots stored on Supabase desktop-screenshots bucket

Atlas reviews findings.json + Heath's intuition after to compile the matrix doc.
"""

from __future__ import annotations

import json
import logging
import sys
import time
from pathlib import Path
from typing import Optional

_REPO_ROOT = Path("C:/Users/Heath Shepard/Desktop/MeetDossie")
sys.path.insert(0, str(_REPO_ROOT / "scripts" / "desktop-control"))

import cole_desktop as cd  # noqa: E402
import kill_switch as ks  # noqa: E402
from pywinauto import Desktop  # noqa: E402
import pyperclip  # noqa: E402

RUN_DIR = Path(__file__).parent
LOG_PATH = RUN_DIR / "research_run.log"
FINDINGS_PATH = RUN_DIR / "findings.json"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler(LOG_PATH, encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("research")


# ----------------------------------------------------------------------------
# Research plan
# ----------------------------------------------------------------------------
# Per platform: a small set of high-signal Google searches + direct URLs.
# We do NOT visit every article — we visit Google SERPs (Heath sees what's
# being returned) + the single best-looking top result per query. Atlas
# reads the visible SERP titles via OCR-of-screenshot AFTER, or just from
# Heath's own observation while watching.
#
# We also hit known-canonical pricing / docs pages directly so we have ground
# truth on the paid SaaS market.

PLAN = {
    "reddit": {
        "google_queries": [
            "reddit api script app personal account approved 2025",
            "PRAW reddit bot account banned shadowban 2025",
            "reddit cookie session automation snoo legal",
            "reddit JSON .json endpoint scraping rate limit 2025",
            "best reddit marketing automation tool SaaS founders",
            "reddit OAuth developer platform responsible builder policy",
        ],
        "direct_urls": [
            ("https://www.reddit.com/r/redditdev/", "r/redditdev landing"),
            ("https://www.reddit.com/wiki/api", "Reddit API wiki"),
            ("https://github.com/praw-dev/praw", "PRAW github"),
            ("https://www.lately.ai/", "Lately AI - reddit included"),
            ("https://hootsuite.com/platform/reddit", "Hootsuite reddit"),
            ("https://www.postoplan.com/social-networks/reddit", "Postoplan reddit"),
        ],
    },
    "facebook_groups": {
        "google_queries": [
            "facebook group automation 2025 detection ban",
            "facebook graph api groups deprecated 2024",
            "post to facebook group automation tool SaaS 2025",
            "phantombuster facebook groups pricing 2025",
            "browse ai facebook group scraping",
            "selenium playwright facebook group post detection bypass 2025",
        ],
        "direct_urls": [
            ("https://phantombuster.com/", "Phantombuster"),
            ("https://www.browse.ai/", "Browse AI"),
            ("https://apify.com/store?search=facebook+group", "Apify FB group actors"),
            ("https://www.postoplan.com/social-networks/facebook-groups", "Postoplan FB groups"),
            ("https://buffer.com/", "Buffer"),
            ("https://later.com/", "Later"),
        ],
    },
    "instagram": {
        "google_queries": [
            "instagram graph api comments engagement 2025 limits",
            "instagram private API instagrapi banned 2025",
            "instagram automation tool that doesnt get banned 2025",
            "instagram cookie automation session id detection",
            "phantombuster instagram pricing engagement",
            "tailwind manychat instagram automation comparison",
        ],
        "direct_urls": [
            ("https://github.com/subzeroid/instagrapi", "Instagrapi GitHub"),
            ("https://developers.facebook.com/docs/instagram-api/", "IG Graph API docs"),
            ("https://www.tailwindapp.com/", "Tailwind"),
            ("https://manychat.com/", "ManyChat"),
            ("https://phantombuster.com/automations/instagram", "Phantombuster IG"),
            ("https://www.metricool.com/instagram-scheduler/", "Metricool IG"),
        ],
    },
}

# ----------------------------------------------------------------------------
# Chrome driving primitives
# ----------------------------------------------------------------------------

def focus_chrome():
    ks.ensure_unlocked()
    for w in Desktop(backend="uia").windows():
        try:
            title = w.window_text() or ""
        except Exception:
            continue
        if title.endswith("- Google Chrome"):
            log.info("Chrome found: %r", title)
            try:
                w.set_focus()
            except Exception:
                time.sleep(0.4)
                w.set_focus()
            time.sleep(0.6)
            return w
    raise RuntimeError("No Chrome window found")


def open_url_in_new_tab(url: str):
    cd.hotkey("ctrl", "t")
    time.sleep(0.7)
    cd.hotkey("ctrl", "l")
    time.sleep(0.3)
    cd.type_text(url, interval=0.005)
    time.sleep(0.2)
    cd.press_key("enter")


def read_address_bar() -> str:
    cd.hotkey("ctrl", "l")
    time.sleep(0.3)
    cd.hotkey("ctrl", "a")
    time.sleep(0.2)
    cd.hotkey("ctrl", "c")
    time.sleep(0.3)
    try:
        addr = pyperclip.paste() or ""
    except Exception:
        addr = ""
    cd.press_key("escape")
    time.sleep(0.2)
    return addr


def scroll_page_for_viewing(scroll_count: int = 4, dwell: float = 1.5):
    """Scroll the page slowly so Heath can read what we found."""
    for _ in range(scroll_count):
        try:
            import pyautogui
            pyautogui.scroll(-500)  # negative = scroll down
        except Exception:
            pass
        time.sleep(dwell)


def google_search(query: str) -> str:
    """Open a new tab, navigate to google.com/search?q=, scroll SERP, screenshot."""
    encoded = query.replace(" ", "+")
    url = f"https://www.google.com/search?q={encoded}"
    open_url_in_new_tab(url)
    time.sleep(6.0)  # let SERP render
    addr = read_address_bar()
    scroll_page_for_viewing(scroll_count=3, dwell=1.2)
    safe_name = "google-" + query.replace(" ", "-").replace("'", "")[:60]
    shot_url = cd.screenshot(safe_name) or ""
    log.info("  query=%r addr=%r shot=%s", query, addr, shot_url)
    return shot_url


def visit_direct(url: str, label: str) -> str:
    open_url_in_new_tab(url)
    time.sleep(7.0)  # generous render time, some of these load heavy JS
    addr = read_address_bar()
    scroll_page_for_viewing(scroll_count=4, dwell=1.5)
    safe_name = "site-" + label.replace(" ", "-").replace("/", "-")[:60]
    shot_url = cd.screenshot(safe_name) or ""
    log.info("  visit=%r addr=%r shot=%s", url, addr, shot_url)
    return shot_url


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------

def main():
    log.info("=" * 60)
    log.info("Social engagement engine — deep research run")
    log.info("=" * 60)

    ks.start()
    ks.ensure_unlocked()
    focus_chrome()

    findings = {
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "platforms": {},
    }

    for platform, plan in PLAN.items():
        log.info("")
        log.info("### PLATFORM: %s ###", platform)
        findings["platforms"][platform] = {
            "google_queries": [],
            "direct_visits": [],
        }

        for q in plan["google_queries"]:
            log.info(" Q: %s", q)
            try:
                shot = google_search(q)
                addr = read_address_bar()
            except Exception as e:
                log.exception(" query failed: %s", e)
                shot, addr = "", ""
            findings["platforms"][platform]["google_queries"].append({
                "query": q,
                "screenshot": shot,
                "final_url": addr,
            })

        for url, label in plan["direct_urls"]:
            log.info(" V: %s (%s)", url, label)
            try:
                shot = visit_direct(url, label)
                addr = read_address_bar()
            except Exception as e:
                log.exception(" visit failed: %s", e)
                shot, addr = "", ""
            findings["platforms"][platform]["direct_visits"].append({
                "url": url,
                "label": label,
                "screenshot": shot,
                "final_url": addr,
            })

        # Save incrementally
        FINDINGS_PATH.write_text(json.dumps(findings, indent=2), encoding="utf-8")

    findings["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    FINDINGS_PATH.write_text(json.dumps(findings, indent=2), encoding="utf-8")
    log.info("DONE — findings at %s", FINDINGS_PATH)
    return 0


if __name__ == "__main__":
    sys.exit(main())
