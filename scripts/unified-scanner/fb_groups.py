"""Facebook groups scanner -- drives Heath's real Chrome via PyAutoGUI.

For each active row in ``group_registry`` (skip=false):
1. Navigate Chrome's address bar to the group URL
2. Wait for the feed to render
3. ``Ctrl+A; Ctrl+C`` to dump visible text to clipboard
4. Split into rough post blocks by author-name heuristics
5. Score each block; upsert qualifying candidates

We don't try to extract clean (author, body, permalink) tuples from the
text dump -- Facebook's DOM-to-text serialization is fragile and we don't
need perfection here. Sage drafts off the post_text we capture, and the
post_url we store is the group URL itself (the candidate is "this group's
feed contains a relevant thread today"). The PyAutoGUI poster then opens
that URL again and Heath has manually approved the draft, so he can
eyeball-place the comment.

For *individual post* permalinks (e.g. a top thread Heath wants to comment
on), the scanner also tries to detect ``/permalink/<id>`` and ``/posts/<id>``
fragments in the captured text and prefer those when found.
"""

from __future__ import annotations

import logging
import re
import time
import uuid
from typing import List, Tuple

from . import chrome
from . import sb
from .relevance import score_text, MIN_SCORE

log = logging.getLogger("unified_scanner.fb_groups")

# Some boilerplate FB strings to strip from the text dump so they don't trip
# scoring (e.g. "transaction coordinator" never appears in FB chrome, but
# things like "Like Comment Share" do show up between every post and we don't
# want them to bleed posts together).
_BOILERPLATE_TOKENS = (
    "Like\nComment\nShare",
    "All reactions:",
    "Most relevant",
    "Top comments",
    "View more comments",
    "See more",
    "Edited",
)

_PERMALINK_RX = re.compile(
    r"https?://(?:www\.)?facebook\.com/groups/[^\s/]+/(?:permalink|posts)/\d+",
    re.IGNORECASE,
)

# Heuristic: post boundaries on FB groups are blank-line separated, with the
# author name on its own short line near the start. We split on the visible
# "Like Comment Share" marker which appears once per post.
_POST_DIVIDER_RX = re.compile(r"\n\s*Like\s*\n\s*Comment\s*\n\s*Share\s*\n", re.IGNORECASE)


def _split_posts(raw_text: str) -> List[str]:
    if not raw_text:
        return []
    # Normalize whitespace lightly so divider regex matches.
    normalized = raw_text.replace("\r\n", "\n")
    chunks = _POST_DIVIDER_RX.split(normalized)
    # Each chunk is "one post + leading boilerplate"; trim and drop empties.
    out = []
    for c in chunks:
        c = c.strip()
        if len(c) < 60:
            continue
        # Keep only the last ~1500 chars so we focus on the post body, not the
        # entire scrollback above it.
        out.append(c[-1500:])
    return out


def _extract_permalink(chunk: str) -> str:
    m = _PERMALINK_RX.search(chunk)
    return m.group(0) if m else ""


def _scan_group(group_name: str, group_url: str, scanner_run_id: str) -> int:
    log.info("scanning FB group: %s -- %s", group_name, group_url)
    if chrome.kill_switch_check():
        log.warning("Kill switch active -- aborting FB scan")
        return 0

    try:
        chrome.goto_url(group_url, settle_seconds=6.0)
    except Exception as e:
        log.warning("FB nav failed for %s: %s", group_name, e)
        sb.log_desktop_action("scanner_nav_fail",
                              target=f"fb:{group_url}", result=str(e))
        return 0

    # Scroll once to load more posts beyond the fold.
    chrome.scroll(-1200)
    time.sleep(1.5)
    chrome.scroll(-1200)
    time.sleep(1.5)

    raw = chrome.copy_visible_text()
    if not raw or len(raw) < 200:
        log.info("FB scan: %s returned %d chars (likely empty or login wall)",
                 group_name, len(raw or ""))
        sb.log_desktop_action(
            "scanner_empty",
            target=f"fb:{group_url}",
            result=f"chars={len(raw or '')}",
        )
        return 0

    posts = _split_posts(raw)
    log.info("FB scan: %s -- %d post chunks parsed", group_name, len(posts))

    inserted = 0
    for chunk in posts:
        score, matched = score_text(chunk)
        if score < MIN_SCORE:
            continue
        permalink = _extract_permalink(chunk) or group_url
        author = ""
        # Best-effort: first non-empty line of the chunk is usually the author
        for line in chunk.split("\n"):
            line = line.strip()
            if not line or len(line) > 80:
                continue
            # Skip lines that are just timestamps or boilerplate.
            if any(t.lower() in line.lower() for t in
                   ("ago", "yesterday", "today", "min", "hr", "now", "shared")):
                continue
            author = line[:80]
            break

        row = sb.insert_candidate(
            platform="facebook",
            post_url=permalink,
            post_text=chunk,
            author_handle=author,
            relevance_score=float(score),
            matched_keywords=matched,
            scanner_run_id=scanner_run_id,
        )
        if row:
            inserted += 1
            log.info("queued FB candidate (score=%d): %s",
                     score, chunk.replace("\n", " ")[:80])
    return inserted


def scan(scanner_run_id: str = "", max_groups: int = 6) -> int:
    """Scan up to ``max_groups`` active groups from ``group_registry``.

    We cap to keep one scan run under ~5 minutes of Chrome driving --
    Heath doesn't want the scanner monopolizing his desktop for an hour.
    The next run picks up where the previous left off via the
    ``last_scanned_at`` ordering once that column exists; for now we just
    sort by group_name and rely on the polite cap.
    """
    if not scanner_run_id:
        scanner_run_id = f"fb-{uuid.uuid4().hex[:8]}"

    groups = sb.fetch_active_groups()
    if not groups:
        log.info("No active FB groups in group_registry -- nothing to scan")
        return 0

    # If a group requires_heath_review, we still scan it -- the review gate
    # is on POSTING, not on candidate generation.
    sample = groups[:max_groups]

    total = 0
    for g in sample:
        if chrome.kill_switch_check():
            log.warning("Kill switch activated mid-scan -- stopping FB scan")
            break
        try:
            total += _scan_group(g["group_name"], g["group_url"], scanner_run_id)
        except Exception as e:
            log.warning("FB group %s failed: %s", g.get("group_name"), e)
            sb.log_desktop_action("scanner_exception",
                                  target=f"fb:{g.get('group_name','')}",
                                  result=str(e))
        time.sleep(2.5)  # polite gap between groups
    return total


if __name__ == "__main__":
    import json
    logging.basicConfig(level=logging.INFO)
    inserted = scan(scanner_run_id=f"fb-cli-{int(time.time())}")
    print(json.dumps({"platform": "facebook", "inserted": inserted}))
