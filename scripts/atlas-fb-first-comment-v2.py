"""atlas-fb-first-comment-v2.py

DO NOT delete - required by scheduled task "Dossie First Comment Auto-Attach"
at 18:00, 20:00, 03:00 daily. Called by scripts/atlas-fb-first-comments-blitz-v2.js.

Drive Heath's already-open Chrome to attach a FIRST COMMENT to a freshly
posted Founding-Files Facebook group post.

Strategy (rewritten 2026-06-10 after the prior file was lost):
  1. Pick the biggest visible non-DossieBot Chrome window.
  2. Open a NEW tab and navigate to the group's chronological feed
     (`?sorting_setting=CHRONOLOGICAL`). This is far more reliable than FB's
     internal search (`/search/?q=`) for finding our own just-posted content -
     the prior v2 logs show search returning 0 matches in 100% of runs.
  3. Press Page Down repeatedly while polling UIA for a TextControl/LinkControl
     whose Name contains the needle. Each iteration walks up to find a Group
     container that looks like a post article (400-1000 wide, 150-2000 tall).
  4. Once located, find the Comment button (Name in {"Comment","Comments"})
     whose center sits inside or just below the post rect. Click it.
  5. Find the inline comment composer ("Write a comment...", "Comment as Heath
     Shepard", or anything name-contains "Comment as"). Click + verify focus
     with a clipboard probe.
  6. Paste the comment body, verify via select-all+copy round-trip, then submit
     with Enter (FB inline composers submit on plain Enter; Shift+Enter inserts
     newline). Fallback: Ctrl+Enter.
  7. Verify by select-all+copy: if composer is empty (< 30 chars), success.

CLI (called by atlas-fb-first-comments-blitz-v2.js):
  python scripts/atlas-fb-first-comment-v2.py \
    --group-url https://www.facebook.com/groups/<slug>/ \
    --needle "<unique substring from post_body>" \
    --comment-file <abs path to UTF-8 text file with comment body> \
    --post-id <uuid>  \
    --label <human label>

Output (final line, parsed by the JS via regex `ATLAS_RESULT_JSON:(\{.*\})`):
  ATLAS_RESULT_JSON:{"outcome": "<code>", "run_dir": "<abs path>", ...}

Outcome codes (kept identical to the prior contract so the JS retry logic
in atlas-fb-first-comments-blitz-v2.js keeps working):
  posted                  - comment submitted, composer reset
  needle_not_found        - couldn't locate the post via UIA after full scroll
  comment_button_missing  - no Comment button near the post rect
  composer_unclickable    - composer found but clipboard probe didn't focus it
  paste_failed            - composer focused but text didn't paste
  submit_failed           - typed but Enter/Ctrl+Enter didn't post
  chrome_missing          - no usable Chrome window
"""

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import pyautogui
import pygetwindow as gw
from mss import mss

try:
    import uiautomation as uia
    UIA_AVAILABLE = True
except Exception:
    UIA_AVAILABLE = False

REPO_ROOT = Path(__file__).resolve().parents[1]
RUNS_ROOT = REPO_ROOT / "scripts" / "atlas-runs"

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.12


def log(msg):
    print(f"[atlas-fb-first-comment-v2] {msg}", flush=True)


def screenshot(path):
    try:
        with mss() as sct:
            sct.shot(output=str(path))
    except Exception as e:
        log(f"screenshot failed: {e}")


def set_clipboard(text):
    proc = subprocess.run(
        ["powershell", "-NoProfile", "-Command", "$input | Set-Clipboard"],
        input=text, text=True, encoding="utf-8", capture_output=True,
    )
    return proc.returncode == 0


def get_clipboard():
    try:
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-Command", "Get-Clipboard"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        return (proc.stdout or "").strip()
    except Exception:
        return ""


def find_chrome_window():
    """Pick the biggest visible Chrome window that is NOT the DossieBot profile.
    DossieBot windows are typically narrower and titled with the FB group name
    when fb-group-poster.js is mid-flight; we always target Heath's main Chrome.
    """
    all_windows = gw.getAllWindows()
    chrome_wins = []
    for w in all_windows:
        try:
            if not w.title or not w.visible or w.isMinimized:
                continue
        except Exception:
            continue
        if "Google Chrome" in w.title:
            chrome_wins.append(w)
    if not chrome_wins:
        return None
    # Filter out anything that obviously looks like DossieBot or is too small.
    main_wins = [w for w in chrome_wins if w.width >= 800]
    pool = main_wins if main_wins else chrome_wins
    selected = max(pool, key=lambda w: w.width * w.height)
    log(f"selected Chrome: {selected.width}x{selected.height} | {selected.title}")
    return selected


def activate_window(win):
    import ctypes
    try:
        if win.isMinimized:
            win.restore()
        user32 = ctypes.windll.user32
        # Alt-key tickle so SetForegroundWindow is allowed.
        user32.keybd_event(0x12, 0, 0, 0)
        user32.keybd_event(0x12, 0, 2, 0)
        time.sleep(0.05)
        try:
            win.activate()
        except Exception:
            pass
        try:
            hwnd = win._hWnd
            user32.ShowWindow(hwnd, 9)
            user32.SetForegroundWindow(hwnd)
            user32.BringWindowToTop(hwnd)
            user32.SetActiveWindow(hwnd)
        except Exception:
            pass
        time.sleep(0.7)
    except Exception as e:
        log(f"activate warning: {e}")


def navigate_to(url):
    # New tab so we never clobber whatever Heath is doing.
    pyautogui.hotkey("ctrl", "t")
    time.sleep(0.7)
    pyautogui.hotkey("ctrl", "l")
    time.sleep(0.3)
    set_clipboard(url)
    time.sleep(0.2)
    pyautogui.hotkey("ctrl", "v")
    time.sleep(0.25)
    pyautogui.press("enter")


def close_tab():
    pyautogui.hotkey("ctrl", "w")
    time.sleep(0.3)


def _get_chrome_uia_window(win):
    if not UIA_AVAILABLE:
        return None
    try:
        for c in uia.GetRootControl().GetChildren():
            try:
                if c.ClassName != "Chrome_WidgetWin_1":
                    continue
                r = c.BoundingRectangle
                if abs(r.left - win.left) <= 8 and abs(r.top - win.top) <= 8:
                    return c
            except Exception:
                continue
        chromes = [c for c in uia.GetRootControl().GetChildren()
                   if c.ClassName == "Chrome_WidgetWin_1"]
        if chromes:
            return max(
                chromes,
                key=lambda c: (c.BoundingRectangle.width() * c.BoundingRectangle.height()),
            )
    except Exception as e:
        log(f"UIA chrome window lookup failed: {e}")
    return None


def _uia_find_by_name(root, name, control_types=None, max_depth=30):
    matches = []

    def walk(node, depth=0):
        if depth > max_depth:
            return
        try:
            n = (node.Name or "").strip()
            ct = node.ControlTypeName
            if n == name and (control_types is None or ct in control_types):
                matches.append(node)
        except Exception:
            pass
        try:
            for ch in node.GetChildren():
                walk(ch, depth + 1)
        except Exception:
            return

    walk(root)
    return matches


def _uia_find_by_name_contains(root, substr, control_types=None, max_depth=30):
    matches = []
    needle = substr.lower()

    def walk(node, depth=0):
        if depth > max_depth:
            return
        try:
            n = (node.Name or "")
            ct = node.ControlTypeName
            if needle in n.lower() and (control_types is None or ct in control_types):
                matches.append(node)
        except Exception:
            pass
        try:
            for ch in node.GetChildren():
                walk(ch, depth + 1)
        except Exception:
            return

    walk(root)
    return matches


def dismiss_popups(win, run_dir):
    try:
        cwin = _get_chrome_uia_window(win)
        if cwin is not None:
            for label in (
                "Block", "Don't allow", "Not now", "No thanks",
                "Decline optional cookies", "Allow all cookies", "Allow",
            ):
                btns = _uia_find_by_name(cwin, label, control_types=("ButtonControl",))
                for b in btns:
                    try:
                        r = b.BoundingRectangle
                        if r.width() <= 0 or r.height() <= 0:
                            continue
                        cx_btn = (r.left + r.right) // 2
                        cy_btn = (r.top + r.bottom) // 2
                        if not (win.left <= cx_btn <= win.left + win.width):
                            continue
                        if not (win.top <= cy_btn <= win.top + win.height):
                            continue
                        log(f"dismiss popup '{label}' at ({cx_btn},{cy_btn})")
                        pyautogui.click(cx_btn, cy_btn)
                        time.sleep(0.6)
                    except Exception:
                        continue
        pyautogui.press("escape")
        time.sleep(0.3)
    except Exception as e:
        log(f"dismiss_popups: {e}")


def wait_for_fb_load(win, run_dir, seconds=10):
    time.sleep(seconds)
    p = run_dir / "02-loaded.png"
    screenshot(p)
    dismiss_popups(win, run_dir)
    screenshot(run_dir / "02b-after-dismiss.png")
    return str(p)


def find_post_rect_via_uia(win, needle):
    """Locate the post that contains the needle. Returns
    (left, top, right, bottom) of the post container rect, or None.

    Two-stage search:
      a. Find any UIA node whose Name contains the needle (case-insensitive),
         filtered to TextControl / LinkControl / GroupControl.
      b. Walk up parents until we find one in the typical FB post container
         size range. This is the post article.

    All coordinates are screen-absolute. We exclude anything in the top 100px
    of the window (URL/tab bar).
    """
    if not UIA_AVAILABLE:
        return None
    try:
        cwin = _get_chrome_uia_window(win)
        if cwin is None:
            return None
        # Try progressively shorter substrings of the needle (FB sometimes
        # injects soft-hyphens or zero-width chars that break exact match).
        candidates_substrs = []
        if needle:
            candidates_substrs.append(needle)
            if len(needle) > 40:
                candidates_substrs.append(needle[:40])
            if len(needle) > 25:
                candidates_substrs.append(needle[:25])
        viable = 0
        total = 0
        for substr in candidates_substrs:
            matches = _uia_find_by_name_contains(
                cwin, substr,
                control_types=("TextControl", "LinkControl", "GroupControl"),
            )
            total += len(matches)
            for m in matches:
                try:
                    r = m.BoundingRectangle
                    if r.width() <= 0 or r.height() <= 0:
                        continue
                    cx = (r.left + r.right) // 2
                    cy = (r.top + r.bottom) // 2
                    if not (win.left <= cx <= win.left + win.width):
                        continue
                    if not (win.top + 100 <= cy <= win.top + win.height - 20):
                        continue
                    viable += 1
                    # Walk up parents to find a real container.
                    node = m
                    for _ in range(12):
                        try:
                            parent = node.GetParentControl()
                            if parent is None:
                                break
                            pr = parent.BoundingRectangle
                            pw = pr.width()
                            ph = pr.height()
                            if 400 <= pw <= 1100 and 150 <= ph <= 2400:
                                log(f"post container ({pr.left},{pr.top},{pr.right},{pr.bottom}) via '{substr[:30]}'")
                                return (pr.left, pr.top, pr.right, pr.bottom)
                            node = parent
                        except Exception:
                            break
                except Exception:
                    continue
        log(f"needle '{needle[:40]}' -> {total} matches, {viable} viable")
        return None
    except Exception as e:
        log(f"find_post_rect_via_uia failed: {e}")
        return None


def scroll_and_locate(win, run_dir, needle, max_scrolls=30):
    """Click into the feed then PageDown while polling UIA for the post."""
    # Click into the page so PageDown scrolls the feed, not the URL bar.
    cx_click = win.left + win.width // 2
    cy_click = win.top + int(win.height * 0.55)
    pyautogui.click(cx_click, cy_click)
    time.sleep(0.5)

    # First check before scrolling - the post might already be visible
    # (a freshly posted Founding-Files post lands at the top of CHRONOLOGICAL).
    rect = find_post_rect_via_uia(win, needle)
    if rect:
        screenshot(run_dir / "03-found-no-scroll.png")
        return rect

    for i in range(1, max_scrolls + 1):
        pyautogui.press("pagedown")
        time.sleep(0.55)
        # Poll every 2 scrolls to keep run time reasonable.
        if i % 2 == 0:
            rect = find_post_rect_via_uia(win, needle)
            if rect:
                screenshot(run_dir / f"03-found-scroll-{i}.png")
                return rect
    screenshot(run_dir / "03-scroll-exhausted.png")
    return None


def click_comment_button(win, run_dir, post_rect):
    """Click the Comment button under the located post.

    We look for ButtonControl/LinkControl/GroupControl with Name == 'Comment'
    or 'Comments'. The right one sits inside or just below the post rect.
    """
    if not UIA_AVAILABLE:
        return None
    cwin = _get_chrome_uia_window(win)
    if cwin is None:
        return None
    pl, pt, pr, pb = post_rect
    candidates = []
    for label in ("Comment", "Leave a comment", "Comments"):
        for ct in ("ButtonControl", "GroupControl", "LinkControl"):
            for m in _uia_find_by_name(cwin, label, control_types=(ct,)):
                try:
                    r = m.BoundingRectangle
                    if r.width() <= 0 or r.height() <= 0:
                        continue
                    cx = (r.left + r.right) // 2
                    cy = (r.top + r.bottom) // 2
                    horiz_ok = pl - 50 <= cx <= pr + 50
                    vert_ok = pt - 20 <= cy <= pb + 400
                    if horiz_ok and vert_ok:
                        dist = abs(cy - pb)
                        candidates.append((dist, cx, cy, label, ct))
                except Exception:
                    continue
    if not candidates:
        log("no Comment button candidates near post rect")
        return None
    candidates.sort(key=lambda t: t[0])
    dist, cx, cy, label, ct = candidates[0]
    log(f"Comment button '{label}' ({ct}) at ({cx},{cy}) dist={dist}")
    pyautogui.click(cx, cy)
    time.sleep(2.0)
    screenshot(run_dir / "04-after-comment-click.png")
    return (cx, cy)


def find_comment_composer(win, run_dir):
    """Find the inline comment composer after clicking Comment."""
    if not UIA_AVAILABLE:
        return None
    cwin = _get_chrome_uia_window(win)
    if cwin is None:
        return None
    labels = [
        "Write a comment...",
        "Write a comment",
        "Write a public comment...",
        "Write a public comment",
        "Add a comment",
        "Comment as Heath Shepard",
    ]
    for label in labels:
        for ct in (
            "EditControl", "GroupControl", "ButtonControl",
            "TextControl", "DocumentControl",
        ):
            for m in _uia_find_by_name(cwin, label, control_types=(ct,)):
                try:
                    r = m.BoundingRectangle
                    if r.width() <= 0 or r.height() <= 0:
                        continue
                    cx = (r.left + r.right) // 2
                    cy = (r.top + r.bottom) // 2
                    if not (win.left <= cx <= win.left + win.width):
                        continue
                    if not (win.top + 100 <= cy <= win.top + win.height - 50):
                        continue
                    log(f"composer '{label}' ({ct}) at ({cx},{cy})")
                    return (cx, cy, label, ct)
                except Exception:
                    continue
    # Fallback: name-contains "Comment as"
    for m in _uia_find_by_name_contains(
        cwin, "Comment as",
        control_types=("EditControl", "GroupControl", "ButtonControl", "TextControl"),
    ):
        try:
            r = m.BoundingRectangle
            if r.width() <= 0 or r.height() <= 0:
                continue
            cx = (r.left + r.right) // 2
            cy = (r.top + r.bottom) // 2
            if not (win.left <= cx <= win.left + win.width):
                continue
            if not (win.top + 100 <= cy <= win.top + win.height - 50):
                continue
            log(f"composer contains 'Comment as' at ({cx},{cy})")
            return (cx, cy, "Comment as*", m.ControlTypeName)
        except Exception:
            continue
    return None


def click_composer_and_verify(win, run_dir):
    hit = find_comment_composer(win, run_dir)
    if hit is None:
        return None
    cx, cy, label, ct = hit
    log(f"click composer at ({cx},{cy}) [{label}/{ct}]")
    pyautogui.click(cx, cy)
    time.sleep(1.5)
    screenshot(run_dir / "05-after-composer-click.png")
    # Probe focus
    set_clipboard("ATLASPROBE")
    time.sleep(0.2)
    pyautogui.hotkey("ctrl", "v")
    time.sleep(0.7)
    pyautogui.hotkey("ctrl", "a")
    time.sleep(0.2)
    pyautogui.hotkey("ctrl", "c")
    time.sleep(0.3)
    clip = get_clipboard()
    if "ATLASPROBE" in clip:
        log("composer focused (probe round-tripped)")
        pyautogui.hotkey("ctrl", "a")
        time.sleep(0.1)
        pyautogui.press("delete")
        time.sleep(0.3)
        return {"x": cx, "y": cy, "label": label}
    log(f"composer click did not focus (clip[:60]={clip[:60]!r})")
    return None


def paste_comment_body(body, run_dir):
    set_clipboard(body)
    time.sleep(0.3)
    pyautogui.hotkey("ctrl", "v")
    time.sleep(1.8)
    screenshot(run_dir / "06-body-pasted.png")
    pyautogui.hotkey("ctrl", "a")
    time.sleep(0.2)
    pyautogui.hotkey("ctrl", "c")
    time.sleep(0.3)
    clip = get_clipboard()
    needle = "".join(body.split())[:30].lower()
    haystack = "".join(clip.split()).lower()
    ok = needle in haystack
    if ok:
        pyautogui.press("end")
        time.sleep(0.15)
    return ok, clip[:120]


def submit_comment(win, run_dir):
    log("submit via Enter")
    pyautogui.press("enter")
    time.sleep(3.5)
    screenshot(run_dir / "07-after-enter.png")
    pyautogui.hotkey("ctrl", "a")
    time.sleep(0.2)
    pyautogui.hotkey("ctrl", "c")
    time.sleep(0.3)
    clip = get_clipboard()
    log(f"post-submit clip len={len(clip)} preview={clip[:60]!r}")
    if len(clip) < 30:
        return True, "enter"
    log("Enter didn't clear composer - trying Ctrl+Enter")
    pyautogui.hotkey("ctrl", "enter")
    time.sleep(3.5)
    screenshot(run_dir / "07b-after-ctrl-enter.png")
    pyautogui.hotkey("ctrl", "a")
    time.sleep(0.2)
    pyautogui.hotkey("ctrl", "c")
    time.sleep(0.3)
    clip = get_clipboard()
    if len(clip) < 30:
        return True, "ctrl_enter"
    return False, "neither_submitted"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--group-url", required=True)
    ap.add_argument("--needle", required=True,
                    help="Unique substring from target post body")
    ap.add_argument("--comment-file", required=True)
    ap.add_argument("--post-id", required=True)
    ap.add_argument("--label", default="first-comment")
    args = ap.parse_args()

    body = Path(args.comment_file).read_text(encoding="utf-8")

    run_dir = RUNS_ROOT / f"fb-fc-v2-{int(time.time())}-{args.label}"
    run_dir.mkdir(parents=True, exist_ok=True)

    result = {
        "ts": datetime.now().isoformat(),
        "group_url": args.group_url,
        "needle": args.needle,
        "post_id": args.post_id,
        "label": args.label,
        "run_dir": str(run_dir),
        "steps": [],
        "outcome": None,
        "reason": None,
        "comment_preview": body[:120],
    }

    def finish(outcome, reason=None):
        result["outcome"] = outcome
        result["reason"] = reason
        try:
            (run_dir / "result.json").write_text(json.dumps(result, indent=2))
        except Exception:
            pass
        print("ATLAS_RESULT_JSON:" + json.dumps(result))
        sys.exit(0)

    win = find_chrome_window()
    if not win:
        finish("chrome_missing", "no visible Chrome window")
    result["window"] = {
        "title": win.title,
        "rect": [win.left, win.top, win.width, win.height],
    }
    activate_window(win)
    screenshot(run_dir / "01-before.png")

    # Chronological feed - much more reliable than FB search for finding our
    # own freshly-posted content.
    group_url = args.group_url.rstrip("/")
    chrono_url = f"{group_url}/?sorting_setting=CHRONOLOGICAL"
    log(f"navigating: {chrono_url}")
    navigate_to(chrono_url)
    result["steps"].append("nav_chronological")

    wait_for_fb_load(win, run_dir, seconds=10)
    result["steps"].append("loaded")

    post_rect = scroll_and_locate(win, run_dir, args.needle, max_scrolls=30)
    if not post_rect:
        log("needle not found - closing tab")
        close_tab()
        finish("needle_not_found",
               f"could not locate post containing '{args.needle}' after scrolls")
    result["steps"].append(f"post_rect={post_rect}")

    btn_hit = click_comment_button(win, run_dir, post_rect)
    if not btn_hit:
        log("comment button missing - closing tab")
        close_tab()
        finish("comment_button_missing", "no Comment button near target post")
    result["steps"].append(f"clicked_comment_btn={btn_hit}")

    composer_hit = click_composer_and_verify(win, run_dir)
    if not composer_hit:
        log("composer unclickable - closing tab")
        pyautogui.press("escape")
        time.sleep(0.3)
        close_tab()
        finish("composer_unclickable", "composer did not accept clipboard probe")
    result["steps"].append(f"composer_focused={composer_hit}")

    ok, sample = paste_comment_body(body, run_dir)
    if not ok:
        log(f"paste failed (sample={sample!r}) - closing tab")
        pyautogui.press("escape")
        time.sleep(0.5)
        close_tab()
        finish("paste_failed", f"body not detected after paste, sample={sample!r}")
    result["steps"].append("body_pasted")

    submitted, how = submit_comment(win, run_dir)
    if not submitted:
        log("submit failed - closing tab")
        pyautogui.press("escape")
        time.sleep(0.5)
        close_tab()
        finish("submit_failed", f"submit attempts left content in composer ({how})")
    result["steps"].append(f"submitted_via={how}")

    time.sleep(2)
    screenshot(run_dir / "08-final.png")
    try:
        win.activate()
        time.sleep(0.4)
    except Exception:
        pass
    close_tab()
    result["steps"].append("closed_tab")
    finish("posted")


if __name__ == "__main__":
    main()
