"""Twitter / X scanner -- subprocess wrapper around twitter-fetch-search.js.

Mirrors the Reddit module's pattern: the heavy lifting (Playwright + persistent
Chrome profile + auth check) lives in Node where we already have a battle-tested
implementation. This module just iterates the keyword list, calls the Node
script, scores results via the shared ``relevance`` rubric, and upserts to the
unified ``engagement_candidates`` queue.

Why subprocess instead of PyAutoGUI on Heath's real Chrome:
- Twitter/X aggressively detects clipboard scrapes and visible tabbing from a
  human-driven Chrome window -- the search results UI flickers/reloads as you
  scroll and the Ctrl+A copy frequently catches half-rendered DOM.
- The DossieBot persistent Chrome profile already holds a valid Twitter session
  (see ``scripts/twitter-session-keepalive.js``). Headless Playwright against
  that profile is the stable scrape path the existing twitter-keyword-scanner.js
  proved out.

Why this module exists separately from twitter-keyword-scanner.js:
- That script writes to its own ``twitter_engagements`` table and runs its own
  veto-mode Telegram loop.
- This module routes Twitter into the SAME ``engagement_candidates`` queue as
  FB/IG/LI/Reddit so Sage drafts + the unified approval flow + the unified
  cap-enforcement layer all apply uniformly.
"""

from __future__ import annotations

import json
import logging
import subprocess
import time
import uuid
from pathlib import Path

from . import sb
from .relevance import score_text, MIN_SCORE

log = logging.getLogger("unified_scanner.twitter")

_REPO_ROOT = Path(__file__).resolve().parents[2]
_FETCH_SCRIPT = _REPO_ROOT / "scripts" / "twitter-fetch-search.js"

# Heath wants TX-RE pain coverage. These keywords mirror the standalone
# twitter-keyword-scanner.js list, scoped tighter to avoid burning quota on
# noise. The relevance scorer culls anything that doesn't hit MIN_SCORE.
KEYWORDS = (
    "transaction coordinator Texas",
    "TREC deadline",
    "option period TREC",
    "TC quit",
    "what TC software",
    "real estate paperwork Texas",
    "zipforms TX",
    "dotloop TX",
    "skyslope TX",
    "transaction coordinator software",
    "real estate agent burnout Texas",
    "texas realtor TC",
)

LIMIT_PER_KEYWORD = 18


def _run_fetch(keyword: str, limit: int = LIMIT_PER_KEYWORD) -> dict:
    if not _FETCH_SCRIPT.exists():
        log.warning("twitter-fetch-search.js not at %s", _FETCH_SCRIPT)
        return {}

    try:
        result = subprocess.run(
            [
                "node",
                str(_FETCH_SCRIPT),
                f"--keyword={keyword}",
                f"--limit={limit}",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=90,
            cwd=str(_REPO_ROOT),
        )
    except subprocess.TimeoutExpired:
        log.warning("twitter-fetch-search.js timed out for %s", keyword)
        return {}
    except Exception as e:
        log.warning("twitter-fetch-search.js spawn failed: %s", e)
        return {}

    if not (result.stdout or "").strip():
        log.warning(
            "twitter-fetch-search.js returned empty stdout for %s (stderr: %s)",
            keyword, (result.stderr or "")[:300],
        )
        return {}

    try:
        return json.loads(result.stdout)
    except Exception as e:
        log.warning("twitter-fetch-search.js json parse failed for %s: %s", keyword, e)
        return {}


def scan(scanner_run_id: str = "", max_keywords: int = 6) -> int:
    """Iterate ``KEYWORDS[:max_keywords]``, score, upsert candidates."""
    if not scanner_run_id:
        scanner_run_id = f"tw-{uuid.uuid4().hex[:8]}"

    total = 0
    for kw in KEYWORDS[:max_keywords]:
        out = _run_fetch(kw)
        posts = (out or {}).get("posts") or []
        log.info("twitter '%s' -- %d posts fetched", kw, len(posts))

        for post in posts:
            text = post.get("text") or ""
            score, matched = score_text(text)
            if score < MIN_SCORE:
                continue

            row = sb.insert_candidate(
                platform="twitter",
                post_url=post.get("tweet_url") or "",
                post_text=text[:8000],
                author_handle=(post.get("author") or "")[:200],
                posted_at=post.get("posted_at"),
                relevance_score=float(score),
                matched_keywords=matched,
                scanner_run_id=scanner_run_id,
            )
            if row:
                total += 1
                log.info(
                    "queued twitter candidate (score=%d): %s",
                    score, text.replace("\n", " ")[:80],
                )

        # polite gap between keyword runs so we don't burn through quota
        time.sleep(2.0)

    return total


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    n = scan(scanner_run_id=f"tw-cli-{int(time.time())}")
    print(json.dumps({"platform": "twitter", "inserted": n}))
