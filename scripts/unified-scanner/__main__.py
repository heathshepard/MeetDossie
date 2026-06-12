"""Unified social-engagement scanner -- orchestrator.

Usage:
    python -m unified-scanner                     # scan all 5 platforms
    python -m unified-scanner --only=reddit       # one platform
    python -m unified-scanner --only=reddit,fb,tw # comma list
    python -m unified-scanner --post              # run the poster
    python -m unified-scanner --summary           # just print + send claudy summary

Heath needs Chrome already open + logged into FB/IG/LinkedIn (Reddit + Twitter
both use headless Playwright against captured sessions / the DossieBot
persistent profile, so they're safe even if Heath's Chrome is closed). The
scanner cycles through the platforms sequentially so only one tab is being
driven at any moment -- if PyAutoGUI loses focus we don't corrupt multiple
sessions.

Telegram summary is sent via Claudy bot at the end of every run.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
import uuid
from pathlib import Path

# Make this directory importable both as ``python -m unified-scanner`` and as
# ``python __main__.py`` from any cwd.
_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR.parent) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR.parent))

# When invoked as `python -m unified-scanner`, the package name is
# ``unified-scanner`` (hyphen). Python imports treat the hyphen fine for
# packages found via __main__, but explicit relative imports need a parent
# package name -- so we route through the directory name.
PKG = "unified-scanner"

# Direct module imports keep things simple regardless of how we were invoked.
from importlib import import_module

reddit_mod = import_module(f"{PKG}.reddit")
fb_mod = import_module(f"{PKG}.fb_groups")
ig_mod = import_module(f"{PKG}.instagram")
li_mod = import_module(f"{PKG}.linkedin")
tw_mod = import_module(f"{PKG}.twitter")
post_mod = import_module(f"{PKG}.post_via_chrome")
sb = import_module(f"{PKG}.sb")
chrome = import_module(f"{PKG}.chrome")


PLATFORM_ALIASES = {
    "reddit": "reddit",
    "fb": "facebook",
    "facebook": "facebook",
    "ig": "instagram",
    "instagram": "instagram",
    "li": "linkedin",
    "linkedin": "linkedin",
    "tw": "twitter",
    "twitter": "twitter",
    "x": "twitter",
}

PLATFORM_FNS = {
    "reddit":    reddit_mod.scan,
    "facebook":  fb_mod.scan,
    "instagram": ig_mod.scan,
    "linkedin":  li_mod.scan,
    "twitter":   tw_mod.scan,
}


def _parse_only(raw: str) -> list:
    if not raw:
        return list(PLATFORM_FNS.keys())
    out = []
    for token in raw.split(","):
        key = token.strip().lower()
        if not key:
            continue
        canonical = PLATFORM_ALIASES.get(key)
        if canonical and canonical not in out:
            out.append(canonical)
    return out or list(PLATFORM_FNS.keys())


def _send_summary(counts: dict) -> None:
    parts = []
    for plat in ("facebook", "instagram", "linkedin", "reddit", "twitter"):
        n = counts.get(plat, 0)
        if plat in counts:
            parts.append(f"{n} {plat[:2].upper()}")
    if not parts:
        return
    total = sum(counts.values())
    text = (
        f"Unified scanner live. Found {' / '.join(parts)} candidates. "
        f"Drafts awaiting your taps in DossieMarketingBot."
        if total > 0
        else f"Unified scanner ran. No new candidates this pass ({' / '.join(parts)})."
    )
    sb.telegram_alert(text)


def run_scan(only: list) -> dict:
    run_id = f"scan-{uuid.uuid4().hex[:10]}"
    counts: dict = {}
    log = logging.getLogger("unified_scanner")
    log.info("Scanner run %s starting platforms: %s", run_id, only)

    # Headless-Playwright platforms first (no PyAutoGUI window-focus risk):
    # Reddit + Twitter both run under captured/persistent sessions and don't
    # need Heath's real Chrome. Then FB/IG/LinkedIn drive the real Chrome.
    _PRIORITY = {"reddit": 0, "twitter": 0}
    order = sorted(only, key=lambda p: (_PRIORITY.get(p, 1), p))

    for platform in order:
        fn = PLATFORM_FNS.get(platform)
        if not fn:
            continue
        try:
            counts[platform] = fn(scanner_run_id=run_id)
        except Exception as e:
            log.exception("Platform %s scan crashed", platform)
            counts[platform] = 0
            sb.log_desktop_action("scanner_crash",
                                  target=platform,
                                  result=str(e))
        # Brief pause so the desktop settles between platforms
        time.sleep(2.0)
    return counts


def main(argv=None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    log = logging.getLogger("unified_scanner.main")

    parser = argparse.ArgumentParser(prog="unified-scanner")
    parser.add_argument("--only", default="",
                        help="Comma list of platforms (reddit,fb,ig,li). Default: all.")
    parser.add_argument("--post", action="store_true",
                        help="Run the poster instead of the scanner.")
    parser.add_argument("--max-posts", type=int, default=5,
                        help="Cap on posts per --post invocation (default 5).")
    parser.add_argument("--summary", action="store_true",
                        help="Only emit a Telegram summary of current queue state.")
    parser.add_argument("--no-telegram", action="store_true",
                        help="Skip Telegram summary at end of run.")
    args = parser.parse_args(argv)

    if args.summary:
        # Read current queue state and Telegram it; useful for cron health.
        pending = sb.fetch_candidates("pending", limit=200)
        drafted = sb.fetch_candidates("drafted", limit=200)
        sent = sb.fetch_candidates("sent_for_approval", limit=200)
        approved = sb.fetch_candidates("approved", limit=200)
        posted = sb.fetch_candidates("posted", limit=200)
        sb.telegram_alert(
            "Engagement queue: "
            f"{len(pending)} pending, {len(drafted)} drafted, "
            f"{len(sent)} awaiting your tap, {len(approved)} approved, "
            f"{len(posted)} already posted."
        )
        return 0

    if args.post:
        n = post_mod.run(max_posts=args.max_posts)
        log.info("Poster done: %d posted", n)
        if not args.no_telegram and n > 0:
            sb.telegram_alert(f"Unified poster: posted {n} comments via real Chrome.")
        print(json.dumps({"mode": "post", "posted": n}))
        return 0

    only = _parse_only(args.only)
    counts = run_scan(only)
    log.info("Scan complete: %s", counts)
    if not args.no_telegram:
        _send_summary(counts)
    print(json.dumps({"mode": "scan", "counts": counts}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
