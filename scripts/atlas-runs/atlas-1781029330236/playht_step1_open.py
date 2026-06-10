"""Step 1 only: focus Heath's Chrome, open playht.com/pricing, screenshot.

We need to verify the domain actually serves before doing anything else.
Previous Atlas run found api.play.ht NXDOMAIN; this run we test the marketing
domain playht.com directly through Heath's real Chrome (no Cloudflare-blocked
Playwright stack involved).

Outputs:
  - playht_run.log         (everything)
  - last_screenshot_url    (single-line file with public Supabase URL)
  - last_screenshot.png    (local copy for direct viewing)
"""

from __future__ import annotations

import os
import sys
import time
import logging
from pathlib import Path

_REPO_ROOT = Path("C:/Users/Heath Shepard/Desktop/MeetDossie")
sys.path.insert(0, str(_REPO_ROOT / "scripts" / "desktop-control"))

import cole_desktop as cd  # noqa: E402
import kill_switch as ks  # noqa: E402
from pywinauto import Desktop  # noqa: E402
import pyperclip  # noqa: E402
import requests  # noqa: E402

RUN_DIR = Path(__file__).parent
LOG_PATH = RUN_DIR / "playht_run.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler(LOG_PATH, encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("playht_step1")


def focus_chrome():
    ks.ensure_unlocked()
    log.info("Locating Chrome window …")
    for w in Desktop(backend="uia").windows():
        try:
            title = w.window_text() or ""
        except Exception:
            continue
        if title.endswith("- Google Chrome"):
            log.info("  found: %r", title)
            try:
                w.set_focus()
            except Exception:
                time.sleep(0.4)
                w.set_focus()
            time.sleep(0.6)
            cd.log_action(action_type="focus_chrome", target=str(w.process_id()), result="success")
            return w
    raise RuntimeError("No Chrome window found")


def main():
    log.info("=" * 60)
    log.info("STEP 1 — open playht.com/pricing in Heath's real Chrome")
    log.info("=" * 60)
    ks.start()
    ks.ensure_unlocked()

    focus_chrome()

    # New tab
    cd.hotkey("ctrl", "t")
    time.sleep(0.7)
    # Focus address bar
    cd.hotkey("ctrl", "l")
    time.sleep(0.3)
    cd.type_text("https://playht.com/pricing", interval=0.01)
    time.sleep(0.2)
    cd.press_key("enter")
    log.info("Navigation submitted. Waiting 8s for page render …")
    time.sleep(8.0)

    # Read address bar to detect chrome-error / about:blank
    cd.hotkey("ctrl", "l")
    time.sleep(0.3)
    cd.hotkey("ctrl", "a")
    time.sleep(0.2)
    cd.hotkey("ctrl", "c")
    time.sleep(0.3)
    try:
        addr = pyperclip.paste()
    except Exception as e:
        log.warning("pyperclip read failed: %s", e)
        addr = "<unread>"
    log.info("Address bar contents: %r", addr)
    cd.press_key("escape")
    time.sleep(0.4)

    # Capture screenshot + download a local copy
    shot_url = cd.screenshot("playht-pricing-step1")
    log.info("Screenshot URL: %s", shot_url)
    (RUN_DIR / "last_screenshot_url").write_text(shot_url or "", encoding="utf-8")
    (RUN_DIR / "last_address_bar.txt").write_text(addr, encoding="utf-8")

    if shot_url:
        try:
            r = requests.get(shot_url, timeout=20)
            if r.ok:
                (RUN_DIR / "last_screenshot.png").write_bytes(r.content)
                log.info("Local screenshot saved: last_screenshot.png (%d bytes)", len(r.content))
        except Exception as e:
            log.warning("screenshot download failed: %s", e)

    # Final summary line for parent
    print(f"STEP1_DONE addr={addr!r} shot={shot_url}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
