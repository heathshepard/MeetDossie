"""Post approved comments back to each platform via Heath's real Chrome.

Pulls ``status='approved'`` rows from ``engagement_candidates`` and, for
each, navigates Heath's Chrome to the ``post_url`` and types the
``comment_draft`` into the platform's comment box.

Why PyAutoGUI instead of platform APIs:
- FB / IG / LinkedIn have no first-class write API for the audience Heath
  cares about (group comments, hashtag-feed replies).
- A fresh Playwright Chromium would trigger bot detection (proven on the
  Reddit OAuth attempt -- Reddit silently rejects new script apps from
  fresh browsers).
- Heath's real Chrome already holds verified, "trusted device" sessions.

Per-platform comment-box coordinates are computed at runtime by tabbing
through the focused composer. We do NOT hardcode pixel positions because
Heath's monitor layout changes.

The poster honors the kill switch (Telegram STOP) and writes every action
to ``desktop_actions``.
"""

from __future__ import annotations

import json
import logging
import sys
import time
import uuid
from pathlib import Path
from typing import Optional

from . import caps
from . import chrome
from . import sb

log = logging.getLogger("unified_scanner.post")

# A safety cap so we never auto-post 50 things in one run if the queue
# grows out of band. Heath approves them one by one; the cap is a belt.
MAX_POSTS_PER_RUN = 5

# Per-platform delay AFTER posting one comment before moving to the next.
COOLDOWN_SECONDS = 25


# ----------------------------------------------------------------------------
# Per-platform comment posting flows
# ----------------------------------------------------------------------------

def _focus_comment_box_with_tab(passes: int = 4) -> None:
    """Tab through the page until the comment composer takes focus.

    The DOM order on FB/IG/LinkedIn varies, but the comment composer is
    almost always within the first ~6 tab stops from the post region.
    After each Tab we wait briefly and let Chrome's focus ring move.
    """
    for _ in range(passes):
        chrome.press_key("tab")
        time.sleep(0.18)


def _post_reddit_comment(post_url: str, comment_text: str) -> Optional[str]:
    """Reddit: reuse the proven Node poster driving the DossieBot Chrome profile.

    MIGRATION NOTE (2026-06-11): switched from reddit-comment-cookie.js
    (deleted; cookie-bearer approach) to reddit-comment-playwright.js, which
    drives Heath's persistent DossieBot Chrome profile.
    """
    import subprocess

    repo_root = Path(__file__).resolve().parents[2]
    node_script = repo_root / "scripts" / "reddit-comment-playwright.js"
    if not node_script.exists():
        log.warning("reddit-comment-playwright.js not present at %s", node_script)
        return None

    try:
        result = subprocess.run(
            ["node", str(node_script),
             f"--url={post_url}",
             f"--text={comment_text}"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
            cwd=str(repo_root),
        )
    except Exception as e:
        log.warning("reddit-comment-playwright.js exception: %s", e)
        return None

    out = (result.stdout or "").strip()
    if not out:
        log.warning("reddit-comment-playwright.js empty stdout: %s",
                    result.stderr[:300])
        return None
    try:
        payload = json.loads(out)
    except Exception:
        log.warning("reddit-comment-playwright.js bad json: %s", out[:300])
        return None
    if not payload.get("ok"):
        log.warning("reddit-comment-playwright.js failed: %s", payload)
        return None
    return payload.get("url") or payload.get("permalink")


def _post_generic_via_chrome(platform: str, post_url: str, comment_text: str) -> Optional[str]:
    """Navigate the real Chrome to ``post_url`` and type the comment.

    Returns a best-effort permalink to the new comment (currently same as
    post_url; we don't try to scrape the new comment id back out -- the
    audit row in desktop_actions captures before/after screenshots so Heath
    can verify visually).
    """
    if chrome.kill_switch_check():
        log.warning("Kill switch active -- aborting %s post", platform)
        return None

    chrome.goto_url(post_url, settle_seconds=6.0)

    # Scroll near the comment area. Most posts have the composer near the
    # bottom of the visible content area.
    chrome.scroll(-600)
    time.sleep(1.0)

    # FB: click the "Write a comment" placeholder. IG: click the comment
    # input. LinkedIn: click the "Add a comment" input. Without DOM access
    # we tab into focus instead of clicking pixel coords. Tabbing keeps the
    # script monitor-resolution-independent.
    _focus_comment_box_with_tab(passes=5)

    # Type the comment. Use paste_text so unicode survives.
    chrome.paste_text(comment_text)
    time.sleep(1.0)

    # Submit. FB / IG / LinkedIn all bind Ctrl+Enter to submit the comment
    # composer. Reddit (new) uses Ctrl+Enter too. This is the most reliable
    # platform-agnostic way to submit without hunting for a Post button.
    import pyautogui
    pyautogui.hotkey("ctrl", "enter")
    time.sleep(3.5)

    return post_url


def _post_one(row: dict) -> bool:
    platform = row["platform"]
    post_url = row["post_url"]
    draft = row.get("comment_draft") or ""
    if not draft:
        log.warning("row %s has no draft -- marking failed", row["id"])
        sb.update_candidate(row["id"], {
            "status": "failed",
            "last_error": "no comment_draft",
        })
        return False

    sb.update_candidate(row["id"], {"status": "posting"})

    permalink = None
    try:
        if platform == "reddit":
            permalink = _post_reddit_comment(post_url, draft)
        else:
            permalink = _post_generic_via_chrome(platform, post_url, draft)
    except Exception as e:
        log.exception("post failed for row %s", row["id"])
        sb.update_candidate(row["id"], {
            "status": "failed",
            "last_error": str(e)[:500],
            "post_attempt_count": (row.get("post_attempt_count") or 0) + 1,
        })
        sb.log_desktop_action("comment_post_fail",
                              target=f"{platform}:{post_url}",
                              text_typed=draft,
                              result=str(e))
        return False

    if not permalink:
        sb.update_candidate(row["id"], {
            "status": "failed",
            "last_error": "post returned no permalink",
            "post_attempt_count": (row.get("post_attempt_count") or 0) + 1,
        })
        sb.log_desktop_action("comment_post_fail",
                              target=f"{platform}:{post_url}",
                              text_typed=draft,
                              result="no permalink")
        return False

    from datetime import datetime, timezone
    posted_at_iso = datetime.now(timezone.utc).isoformat()
    sb.update_candidate(row["id"], {
        "status": "posted",
        "posted_comment_url": permalink,
        "posted_at": posted_at_iso,
    })
    sb.log_desktop_action("comment_post_ok",
                          target=f"{platform}:{post_url}",
                          text_typed=draft,
                          result=f"permalink={permalink}",
                          approved_by="heath")

    # SV-FB-VETO-001: notify Heath when veto-mode auto-post lands.
    # Always fires (the cron daily cap upstream guarantees max 5/day).
    try:
        group_label = (
            row.get("group_name")
            or _group_from_post_url(post_url)
            or platform
        )
        sb.telegram_alert(
            f"POSTED in {group_label}\n{permalink}"
        )
    except Exception as e:
        log.debug("telegram POSTED notify failed: %s", e)

    log.info("posted %s comment -> %s", platform, permalink)
    return True


def _group_from_post_url(post_url: str) -> Optional[str]:
    """Best-effort: pull the slug after /groups/ from a FB URL."""
    if not post_url:
        return None
    import re
    m = re.search(r"/groups/([^/?#]+)", post_url)
    if m:
        return f"groups/{m.group(1)}"
    return None


def run(max_posts: int = MAX_POSTS_PER_RUN) -> int:
    """Pull approved candidates and post them. Returns posted count.

    Honors Heath's caps (5/day total, 2/day per platform, 1 author / 7d).
    We pull more candidates than ``max_posts`` so the cap filter can skip
    deferred rows and still fill the daily budget from other platforms /
    other authors in the same run.
    """
    # Heath's cap state is loaded once and mutated as we post -- so two
    # approved Twitter rows in one run don't both fire if the daily Twitter
    # budget is 1 remaining.
    cap_state = caps.load_state()
    log.info("cap state at run start: %s", cap_state.snapshot())

    fetch_limit = max(max_posts * 5, 25)
    approved = sb.fetch_candidates("approved", limit=fetch_limit)
    if not approved:
        log.info("no approved candidates -- nothing to post")
        return 0

    posted = 0
    deferred = {"total_daily_cap": 0, "platform_daily_cap": 0,
                "author_7d_cooldown": 0, "min_gap_not_elapsed": 0}

    for row in approved:
        if chrome.kill_switch_check():
            log.warning("Kill switch active -- stopping poster")
            break
        if posted >= max_posts:
            break
        if cap_state.total_remaining <= 0:
            log.info("total daily cap exhausted -- stopping poster")
            break

        # POST-SHADOWBAN 2026-07-01: min-gap between comments per platform.
        # Check BEFORE consuming a cap slot so a deferred row doesn't burn
        # a daily budget entry.
        platform = row.get("platform") or ""
        elapsed, age_min = caps.min_gap_elapsed(platform)
        if not elapsed:
            deferred["min_gap_not_elapsed"] = deferred["min_gap_not_elapsed"] + 1
            sb.update_candidate(row["id"], {
                "last_error": f"deferred_min_gap:{platform}:{age_min:.1f}min_ago",
            })
            log.info("deferred row %s: min_gap not elapsed (%.1f min ago)",
                     row.get("id"), age_min or 0.0)
            continue

        allow, reason = cap_state.try_consume(row)
        if not allow:
            deferred[reason] = deferred.get(reason, 0) + 1
            sb.update_candidate(row["id"], {
                "last_error": f"deferred_by_cap:{reason}",
            })
            log.info("deferred row %s: %s", row.get("id"), reason)
            continue

        ok = _post_one(row)
        if ok:
            posted += 1
        else:
            # Refund the cap budget so a failed post doesn't burn a slot.
            cap_state.total_remaining += 1
            platform = row.get("platform") or ""
            cap_state.per_platform_remaining[platform] = (
                cap_state.per_platform_remaining.get(platform, 0) + 1
            )
        time.sleep(COOLDOWN_SECONDS)

    log.info(
        "poster done: posted=%d deferred=%s final_cap_state=%s",
        posted, deferred, cap_state.snapshot(),
    )
    return posted


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    n = run()
    print(json.dumps({"posted": n}))
