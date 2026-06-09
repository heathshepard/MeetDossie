"""LinkedIn scanner -- drives Heath's real Chrome via PyAutoGUI.

Scans LinkedIn keyword search ``content`` results for TC-pain mentions.
The search URL is:
    https://www.linkedin.com/search/results/content/?keywords=<query>&sortBy=date_posted

LinkedIn requires login to view results. Heath is signed in on his real
Chrome, so the address-bar nav + clipboard copy approach works.

Post boundary heuristic: every LinkedIn post in a search-result list ends
with a "Like Comment Repost Send" action row -- same idea as FB groups,
different label.
"""

from __future__ import annotations

import logging
import re
import time
import urllib.parse
import uuid
from typing import List

from . import chrome
from . import sb
from .relevance import score_text, MIN_SCORE

log = logging.getLogger("unified_scanner.linkedin")

QUERIES = (
    "transaction coordinator texas",
    "TC quit",
    "real estate deadline stress",
    "broker compliance Texas",
    "texas realtor tools",
)

_POST_DIVIDER_RX = re.compile(
    r"\n\s*Like\s*\n\s*Comment\s*\n\s*Repost\s*\n\s*Send\s*\n",
    re.IGNORECASE,
)

_PERMALINK_RX = re.compile(
    r"https?://(?:www\.)?linkedin\.com/(?:posts|feed/update)/[\w:%-]+",
    re.IGNORECASE,
)


def _split_posts(text: str) -> List[str]:
    if not text:
        return []
    normalized = text.replace("\r\n", "\n")
    chunks = _POST_DIVIDER_RX.split(normalized)
    out = []
    for c in chunks:
        c = c.strip()
        if len(c) < 80:
            continue
        out.append(c[-2000:])
    return out


def _extract_permalink(chunk: str) -> str:
    m = _PERMALINK_RX.search(chunk)
    return m.group(0) if m else ""


def _scan_query(query: str, scanner_run_id: str) -> int:
    encoded = urllib.parse.quote(query)
    url = (
        f"https://www.linkedin.com/search/results/content/"
        f"?keywords={encoded}&sortBy=%22date_posted%22"
    )
    log.info("scanning LinkedIn: %s", query)
    if chrome.kill_switch_check():
        return 0

    try:
        chrome.goto_url(url, settle_seconds=6.5)
    except Exception as e:
        log.warning("LinkedIn nav failed for %s: %s", query, e)
        sb.log_desktop_action("scanner_nav_fail",
                              target=f"li:{query}", result=str(e))
        return 0

    chrome.scroll(-1200)
    time.sleep(1.5)
    chrome.scroll(-1200)
    time.sleep(1.5)

    raw = chrome.copy_visible_text()
    if not raw or len(raw) < 200:
        log.info("LinkedIn %s returned %d chars (login wall or rate-limit)",
                 query, len(raw or ""))
        sb.log_desktop_action(
            "scanner_empty",
            target=f"li:{query}",
            result=f"chars={len(raw or '')}",
        )
        return 0

    chunks = _split_posts(raw)
    log.info("LinkedIn %s -- %d chunks parsed", query, len(chunks))

    inserted = 0
    for chunk in chunks:
        score, matched = score_text(chunk)
        if score < MIN_SCORE:
            continue
        permalink = _extract_permalink(chunk) or f"{url}#chunk-{abs(hash(chunk)) % 1_000_000}"
        author = ""
        for line in chunk.split("\n"):
            line = line.strip()
            if 2 <= len(line) <= 80 and "•" not in line and "ago" not in line.lower():
                author = line[:80]
                break

        row = sb.insert_candidate(
            platform="linkedin",
            post_url=permalink,
            post_text=chunk,
            author_handle=author,
            relevance_score=float(score),
            matched_keywords=matched,
            scanner_run_id=scanner_run_id,
        )
        if row:
            inserted += 1
            log.info("queued LinkedIn candidate (score=%d): %s",
                     score, chunk.replace("\n", " ")[:80])
    return inserted


def scan(scanner_run_id: str = "", max_queries: int = 3) -> int:
    if not scanner_run_id:
        scanner_run_id = f"li-{uuid.uuid4().hex[:8]}"
    total = 0
    for q in QUERIES[:max_queries]:
        if chrome.kill_switch_check():
            break
        try:
            total += _scan_query(q, scanner_run_id)
        except Exception as e:
            log.warning("LinkedIn query %s failed: %s", q, e)
            sb.log_desktop_action("scanner_exception",
                                  target=f"li:{q}", result=str(e))
        time.sleep(2.5)
    return total


if __name__ == "__main__":
    import json
    logging.basicConfig(level=logging.INFO)
    inserted = scan(scanner_run_id=f"li-cli-{int(time.time())}")
    print(json.dumps({"platform": "linkedin", "inserted": inserted}))
