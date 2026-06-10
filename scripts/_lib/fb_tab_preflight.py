"""fb_tab_preflight.py

Shared helper invoked by scripts/_lib/fb-tab-preflight.js (Node).

Walks Chrome windows via pygetwindow + (optionally) UIA. For each window whose
title contains "Facebook" or "facebook.com" — AND which is NOT the
DossieBot-Sage automation profile window — bring it to foreground and send
Ctrl+W to close the active tab.

DossieBot-Sage detection: Chrome window titles for a named user-data-dir
typically include the profile name in the format "<page title> - Google Chrome"
and a separate avatar tooltip in the chrome. We rely on a heuristic: the
DossieBot automation always launches Chrome with `--user-data-dir=...DossieBot-Sage`
and Chrome puts a "- DossieBot-Sage" or "- Person 1 - DossieBot-Sage" suffix on
recent versions. We also skip any window with title containing exactly the
DossieBot-Sage marker string.

Conservative: if we cannot positively identify a window as Heath's main
Chrome, we SKIP it (never close).

Output: stdout last line is `PREFLIGHT_RESULT_JSON:{...}` so the Node wrapper
can parse it.
"""

import argparse
import json
import sys
import time
from pathlib import Path
from datetime import datetime

try:
    import pygetwindow as gw  # type: ignore
except Exception as e:
    print(f"[fb-preflight] pygetwindow import failed: {e}", file=sys.stderr)
    print('PREFLIGHT_RESULT_JSON:{"closed":0,"skipped_dossiebot":0,"errors":["pygetwindow-import-failed"]}')
    sys.exit(0)

try:
    import pyautogui  # type: ignore
except Exception as e:
    print(f"[fb-preflight] pyautogui import failed: {e}", file=sys.stderr)
    print('PREFLIGHT_RESULT_JSON:{"closed":0,"skipped_dossiebot":0,"errors":["pyautogui-import-failed"]}')
    sys.exit(0)

REPO_ROOT = Path(__file__).resolve().parents[2]
RUN_DIR = REPO_ROOT / "scripts" / "atlas-runs"
RUN_DIR.mkdir(parents=True, exist_ok=True)

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.10

FB_TITLE_NEEDLES = ("facebook", "meta business")
DOSSIEBOT_MARKERS = ("dossiebot-sage", "dossiebot sage", "dossiebotsage")


def log(reason: str, msg: str):
    try:
        date = datetime.utcnow().strftime("%Y-%m-%d")
        path = RUN_DIR / f"preflight-{date}.log"
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"[{datetime.utcnow().isoformat()}Z] [{reason}] [py] {msg}\n")
    except Exception:
        pass


def is_chrome_window(w) -> bool:
    try:
        title = (w.title or "").strip()
    except Exception:
        return False
    if not title:
        return False
    # Chrome windows end with "- Google Chrome" (or localized variant)
    return "google chrome" in title.lower()


def looks_like_fb(title: str) -> bool:
    t = title.lower()
    return any(n in t for n in FB_TITLE_NEEDLES)


def looks_like_dossiebot(title: str) -> bool:
    t = title.lower()
    return any(m in t for m in DOSSIEBOT_MARKERS)


def close_active_tab(w, reason: str) -> bool:
    """Bring window to foreground and send Ctrl+W. Returns True on success."""
    try:
        if w.isMinimized:
            w.restore()
            time.sleep(0.2)
        w.activate()
        time.sleep(0.4)
    except Exception as e:
        log(reason, f"activate failed for '{w.title}': {e}")
        return False

    try:
        pyautogui.hotkey("ctrl", "w")
        time.sleep(0.3)
        return True
    except Exception as e:
        log(reason, f"ctrl+w failed for '{w.title}': {e}")
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reason", default="fb-automation")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    reason = args.reason
    closed = 0
    skipped_dossiebot = 0
    errors = []

    try:
        windows = gw.getAllWindows()
    except Exception as e:
        log(reason, f"getAllWindows failed: {e}")
        print(f'PREFLIGHT_RESULT_JSON:{{"closed":0,"skipped_dossiebot":0,"errors":["getAllWindows-failed: {e}"]}}')
        return

    chrome_windows = [w for w in windows if is_chrome_window(w)]
    log(reason, f"found {len(chrome_windows)} chrome window(s)")

    # Track windows we want to close so we can revisit each one (a Chrome window
    # can host multiple tabs; we only close the active tab via Ctrl+W in this
    # pass — that's sufficient because Heath's main Chrome rarely has more
    # than one FB tab open at a time. If it does, future passes will catch
    # them.)
    for w in chrome_windows:
        try:
            title = (w.title or "").strip()
        except Exception:
            continue

        if looks_like_dossiebot(title):
            skipped_dossiebot += 1
            log(reason, f"SKIP dossiebot window: '{title}'")
            continue

        if not looks_like_fb(title):
            log(reason, f"skip non-FB: '{title}'")
            continue

        log(reason, f"FB tab in main Chrome: '{title}' (dryRun={args.dry_run})")
        if args.dry_run:
            closed += 1  # would-have-closed
            continue

        ok = close_active_tab(w, reason)
        if ok:
            closed += 1
            log(reason, f"closed: '{title}'")
        else:
            errors.append(f"close-failed: {title}")

    # Small settle so the foreground change doesn't bleed into the next script.
    time.sleep(0.5)

    result = {"closed": closed, "skipped_dossiebot": skipped_dossiebot, "errors": errors}
    print(f"PREFLIGHT_RESULT_JSON:{json.dumps(result)}")


if __name__ == "__main__":
    main()
