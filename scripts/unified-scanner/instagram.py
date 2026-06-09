"""Instagram scanner -- drives Heath's real Chrome via PyAutoGUI.

We scan the hashtag *Recent* feed for a curated list of Texas-TC-adjacent
tags. Instagram doesn't have a public search query endpoint that survives
without auth, but the hashtag URL is a stable deep link Heath is logged in
to. Same scrape pattern as fb_groups: address-bar nav, scroll twice, copy
all, regex split.

Caption posts on IG don't have the "Like Comment Share" divider that FB
groups do -- instead, every post in the grid view shows the username +
caption excerpt. We split heuristically on the timestamp markers IG renders
("1d", "2h", "23m") which appear once per tile.
"""

from __future__ import annotations

import logging
import re
import time
import uuid
from typing import List

from . import chrome
from . import sb
from .relevance import score_text, MIN_SCORE

log = logging.getLogger("unified_scanner.instagram")

HASHTAGS = (
    "texasrealtor",
    "texasrealestate",
    "transactioncoordinator",
    "txrealtor",
    "trec",
    "sanantoniorealtor",
    "houstonrealtor",
    "austinrealtor",
)

# Post tile boundary heuristic: a relative timestamp on its own line.
_TIME_DIVIDER_RX = re.compile(
    r"\n\s*(?:\d{1,3}\s*[smhd]|yesterday|just now|\d{1,3}\s*(?:second|minute|hour|day|week)s?\s*ago)\s*\n",
    re.IGNORECASE,
)

# Permalink fragments for IG posts -- /p/<shortcode>/ or /reel/<shortcode>/
_PERMALINK_RX = re.compile(
    r"https?://(?:www\.)?instagram\.com/(?:p|reel)/[A-Za-z0-9_-]+/?",
    re.IGNORECASE,
)


def _split_posts(text: str) -> List[str]:
    if not text:
        return []
    normalized = text.replace("\r\n", "\n")
    chunks = _TIME_DIVIDER_RX.split(normalized)
    out = []
    for c in chunks:
        c = c.strip()
        if len(c) < 50:
            continue
        out.append(c[-1500:])
    return out


def _extract_permalink(chunk: str) -> str:
    m = _PERMALINK_RX.search(chunk)
    return m.group(0).rstrip("/") + "/" if m else ""


def _scan_hashtag(tag: str, scanner_run_id: str) -> int:
    url = f"https://www.instagram.com/explore/tags/{tag}/"
    log.info("scanning IG #%s -- %s", tag, url)
    if chrome.kill_switch_check():
        return 0

    try:
        chrome.goto_url(url, settle_seconds=5.5)
    except Exception as e:
        log.warning("IG nav failed for #%s: %s", tag, e)
        sb.log_desktop_action("scanner_nav_fail", target=f"ig:{tag}", result=str(e))
        return 0

    chrome.scroll(-1000)
    time.sleep(1.5)
    chrome.scroll(-1000)
    time.sleep(1.5)

    raw = chrome.copy_visible_text()
    if not raw or len(raw) < 200:
        log.info("IG #%s returned %d chars (likely login wall or rate-limit)",
                 tag, len(raw or ""))
        sb.log_desktop_action(
            "scanner_empty",
            target=f"ig:{tag}",
            result=f"chars={len(raw or '')}",
        )
        return 0

    chunks = _split_posts(raw)
    log.info("IG #%s -- %d chunks parsed", tag, len(chunks))

    inserted = 0
    for chunk in chunks:
        score, matched = score_text(chunk)
        if score < MIN_SCORE:
            continue
        permalink = _extract_permalink(chunk) or f"{url}#chunk-{abs(hash(chunk)) % 1_000_000}"
        # First short line is usually the @username
        author = ""
        for line in chunk.split("\n"):
            line = line.strip()
            if not line or len(line) > 50:
                continue
            if line.startswith("@") or (line and not line[0].isdigit()):
                author = line[:50]
                break

        row = sb.insert_candidate(
            platform="instagram",
            post_url=permalink,
            post_text=chunk,
            author_handle=author,
            relevance_score=float(score),
            matched_keywords=matched,
            scanner_run_id=scanner_run_id,
        )
        if row:
            inserted += 1
            log.info("queued IG candidate #%s (score=%d): %s",
                     tag, score, chunk.replace("\n", " ")[:80])
    return inserted


def scan(scanner_run_id: str = "", max_tags: int = 4) -> int:
    if not scanner_run_id:
        scanner_run_id = f"ig-{uuid.uuid4().hex[:8]}"
    total = 0
    for tag in HASHTAGS[:max_tags]:
        if chrome.kill_switch_check():
            break
        try:
            total += _scan_hashtag(tag, scanner_run_id)
        except Exception as e:
            log.warning("IG hashtag %s failed: %s", tag, e)
            sb.log_desktop_action("scanner_exception",
                                  target=f"ig:{tag}", result=str(e))
        time.sleep(2.5)
    return total


if __name__ == "__main__":
    import json
    logging.basicConfig(level=logging.INFO)
    inserted = scan(scanner_run_id=f"ig-cli-{int(time.time())}")
    print(json.dumps({"platform": "instagram", "inserted": inserted}))
