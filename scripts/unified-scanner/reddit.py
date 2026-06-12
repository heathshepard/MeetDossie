"""Reddit scanner -- subprocess wrapper around reddit-fetch-new.js.

We don't need PyAutoGUI for Reddit. The Node script at
``scripts/reddit-fetch-new.js`` pulls /new from r/realtors and
r/realestate using Heath's persistent DossieBot Chrome profile.

MIGRATION NOTE (2026-06-11): The previous cookie-session-file gate
(``scripts/sessions/reddit.json``) is removed. The persistent profile is
the only path. Session warmth is maintained by
``scripts/reddit-session-keepalive.js`` every 3 days via Windows Task
Scheduler.

This module:
1. Shells out to ``node scripts/reddit-fetch-new.js`` for each subreddit
2. Parses the JSON stdout
3. Scores each post via ``relevance.score_text``
4. Upserts qualifying candidates to ``engagement_candidates``
"""

from __future__ import annotations

import json
import logging
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import List

from .relevance import score_text, MIN_SCORE
from . import sb

log = logging.getLogger("unified_scanner.reddit")

_REPO_ROOT = Path(__file__).resolve().parents[2]
_FETCH_SCRIPT = _REPO_ROOT / "scripts" / "reddit-fetch-new.js"

SUBREDDITS = (
    "realtors",
    "realestate",
    "RealEstate",
    "RealEstateAgents",
    "RealEstateTechnology",
    "realestateinvesting",
    "Texas",
)
LIMIT_PER_SUB = 25


def _run_fetch(subreddit: str, limit: int = LIMIT_PER_SUB) -> dict:
    if not _FETCH_SCRIPT.exists():
        log.warning("reddit-fetch-new.js not at %s", _FETCH_SCRIPT)
        return {}

    try:
        # node script writes JSON to stdout, logs to stderr.
        # Force UTF-8 decoding -- Windows defaults to cp1252 which chokes
        # on the curly quotes Reddit returns in post titles.
        result = subprocess.run(
            [
                "node",
                str(_FETCH_SCRIPT),
                f"--subreddit={subreddit}",
                f"--limit={limit}",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=45,
            cwd=str(_REPO_ROOT),
        )
    except subprocess.TimeoutExpired:
        log.warning("reddit-fetch-new.js timed out for r/%s", subreddit)
        return {}
    except Exception as e:
        log.warning("reddit-fetch-new.js spawn failed: %s", e)
        return {}

    if not (result.stdout or "").strip():
        log.warning("reddit-fetch-new.js returned empty stdout for r/%s (stderr: %s)",
                    subreddit, result.stderr[:300])
        return {}

    try:
        return json.loads(result.stdout)
    except Exception as e:
        log.warning("reddit-fetch-new.js json parse failed for r/%s: %s", subreddit, e)
        return {}


def _post_url(post: dict) -> str:
    permalink = post.get("permalink") or ""
    if permalink.startswith("/"):
        return f"https://www.reddit.com{permalink}"
    if permalink.startswith("http"):
        return permalink
    return f"https://www.reddit.com/r/{post.get('subreddit','')}/comments/{post.get('id','')}"


def scan(scanner_run_id: str = "") -> int:
    """Returns the number of candidates inserted/upserted."""
    count = 0
    for sub in SUBREDDITS:
        out = _run_fetch(sub)
        feed = out.get(sub) or out.get(sub.lower()) or {}
        posts = feed.get("posts") or []
        log.info("r/%s -- %d posts fetched", sub, len(posts))

        for post in posts:
            title = post.get("title") or ""
            body = post.get("selftext") or ""
            full_text = f"{title}\n\n{body}".strip()
            score, matched = score_text(full_text)
            if score < MIN_SCORE:
                continue

            posted_at = None
            if post.get("created_utc"):
                try:
                    posted_at = datetime.fromtimestamp(
                        float(post["created_utc"]), tz=timezone.utc,
                    ).isoformat()
                except Exception:
                    posted_at = None

            row = sb.insert_candidate(
                platform="reddit",
                post_url=_post_url(post),
                post_text=full_text[:8000],
                author_handle=post.get("author") or "",
                posted_at=posted_at,
                relevance_score=float(score),
                matched_keywords=matched,
                scanner_run_id=scanner_run_id,
            )
            if row:
                count += 1
                log.info("queued reddit candidate: %s (score=%d)",
                         (title or "")[:80], score)
        # polite delay between subs so we don't trip rate limits
        time.sleep(1.0)

    return count


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    inserted = scan(scanner_run_id=f"reddit-cli-{int(time.time())}")
    print(json.dumps({"platform": "reddit", "inserted": inserted}))
