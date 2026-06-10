"""atlas-fb-comment-pyautogui.py

Drive Heath's already-open Chrome to COMMENT on a specific FB group post.

Differs from atlas-fb-post-pyautogui.py:
- We don't open the group composer; we find a specific post by author + body
  signature in the feed, click its Comment affordance, type comment, submit.
- Find-in-page (Ctrl+F) is the most reliable way to scroll the Chrome
  viewport to the target post when the post has unique text. We use a short
  unique needle from the post body (Hellickson "Comfort is the enemy of
  leadership" is the most recent Hellickson post visible in the latest
  mobile scrape, but Sage targeted "Today I learned" — we use that needle).
- After Ctrl+F lands, close the find bar (Esc), then use UIA to find the
  Comment button under the matched post region.

Usage:
  python scripts/atlas-fb-comment-pyautogui.py \
    --group-url https://www.facebook.com/groups/ClubWealth/ \
    --needle "Today I learned" \
    --author "Michael Hellickson" \
    --comment-file <abs path> \
    --label "club-wealth-hellickson"

Outcome codes:
  posted              — comment submitted, dialog gone / new comment visible
  needle_not_found    — Ctrl+F couldn't find the post body needle
  comment_button_missing — no Comment affordance visible after scrolling
  composer_unclickable — comment composer found but didn't focus
  paste_failed        — composer opened but typing didn't take
  submit_failed       — typed content but submit didn't go through
  chrome_missing      — no usable Chrome window
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
    print(f"[atlas-fb-comment] {msg}", flush=True)


def screenshot(path):
    with mss() as sct:
        sct.shot(output=str(path))


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
    main_wins = [w for w in chrome_wins if w.width >= 1000]
    pool = main_wins if main_wins else chrome_wins
    blanks = [w for w in pool if "about:blank" in (w.title or "").lower()]
    candidates = blanks if blanks else pool
    return max(candidates, key=lambda w: w.width * w.height)


def activate_window(win):
    import ctypes
    try:
        if win.isMinimized:
            win.restore()
        user32 = ctypes.windll.user32
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
            return max(chromes, key=lambda c: (c.BoundingRectangle.width() * c.BoundingRectangle.height()))
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
    def walk(node, depth=0):
        if depth > max_depth:
            return
        try:
            n = (node.Name or "")
            ct = node.ControlTypeName
            if substr in n and (control_types is None or ct in control_types):
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
            for label in ["Block", "Don't allow", "Not now", "No thanks", "Decline optional cookies", "Allow all cookies"]:
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
                        log(f"dismissing popup via UIA: '{label}' at ({cx_btn},{cy_btn})")
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
    p2 = run_dir / "02b-after-dismiss.png"
    screenshot(p2)
    return str(p)


def find_in_page(needle, run_dir):
    """Use Chrome Ctrl+F to scroll to the post containing the needle."""
    log(f"Ctrl+F looking for needle: {needle!r}")
    pyautogui.hotkey("ctrl", "f")
    time.sleep(0.7)
    set_clipboard(needle)
    time.sleep(0.2)
    pyautogui.hotkey("ctrl", "v")
    time.sleep(0.4)
    pyautogui.press("enter")  # jumps to first match + scrolls into view
    time.sleep(2.0)
    screenshot(run_dir / "03-after-find.png")
    # Close the find bar
    pyautogui.press("escape")
    time.sleep(0.5)
    screenshot(run_dir / "03b-find-closed.png")


def find_target_post_via_uia(win, run_dir, author, needle):
    """After Ctrl+F lands the page on the target post, locate the UIA node
    representing the post (or any text inside it). Returns the bounding rect
    of the article/post container, or None.

    Strategy: find text controls whose Name contains the needle. For each,
    walk up parents to find a Group/Pane node that is reasonably sized
    (a post article container is roughly 500-900 wide, 200-1500 tall).
    """
    if not UIA_AVAILABLE:
        return None
    try:
        cwin = _get_chrome_uia_window(win)
        if cwin is None:
            return None
        # Try the needle first; fall back to author
        for query in (needle, author):
            matches = _uia_find_by_name_contains(cwin, query,
                                                 control_types=("TextControl", "GroupControl", "LinkControl"))
            log(f"UIA name-contains '{query}' -> {len(matches)} candidates")
            for m in matches:
                try:
                    r = m.BoundingRectangle
                    if r.width() <= 0 or r.height() <= 0:
                        continue
                    cx = (r.left + r.right) // 2
                    cy = (r.top + r.bottom) // 2
                    # Must be inside chrome window and not in the URL/tab bar
                    if not (win.left <= cx <= win.left + win.width):
                        continue
                    if not (win.top + 100 <= cy <= win.top + win.height):
                        continue
                    # Walk up to find a container
                    node = m
                    for _ in range(10):
                        try:
                            parent = node.GetParentControl()
                            if parent is None:
                                break
                            pr = parent.BoundingRectangle
                            pw = pr.width()
                            ph = pr.height()
                            if 400 <= pw <= 1000 and 150 <= ph <= 2000:
                                log(f"post container rect ({pr.left},{pr.top},{pr.right},{pr.bottom}) via '{query}'")
                                return (pr.left, pr.top, pr.right, pr.bottom)
                            node = parent
                        except Exception:
                            break
                except Exception:
                    continue
        return None
    except Exception as e:
        log(f"find_target_post_via_uia failed: {e}")
        return None


def click_comment_button_under_post(win, run_dir, post_rect, comment_label_hits_max=8):
    """Find and click the Comment button for the given post.

    FB renders Comment as a Button with Name='Comment' (sometimes 'Comments').
    Several may exist on the page (one per visible post). We pick the one
    whose center sits inside or just below the target post_rect.
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
            ms = _uia_find_by_name(cwin, label, control_types=(ct,))
            for m in ms:
                try:
                    r = m.BoundingRectangle
                    if r.width() <= 0 or r.height() <= 0:
                        continue
                    cx = (r.left + r.right) // 2
                    cy = (r.top + r.bottom) // 2
                    # Must be inside post region OR within 400px below it
                    horiz_ok = pl - 50 <= cx <= pr + 50
                    vert_ok = pt - 20 <= cy <= pb + 400
                    if horiz_ok and vert_ok:
                        # Score: closer to post bottom = better
                        dist = abs(cy - pb)
                        candidates.append((dist, cx, cy, label, ct))
                except Exception:
                    continue
    if not candidates:
        log("no Comment button candidates near post rect")
        return None
    candidates.sort(key=lambda t: t[0])
    dist, cx, cy, label, ct = candidates[0]
    log(f"Comment button: '{label}' ({ct}) at ({cx},{cy}) dist={dist}")
    pyautogui.click(cx, cy)
    time.sleep(2.0)
    screenshot(run_dir / "04-after-comment-click.png")
    return (cx, cy)


def find_comment_composer_via_uia(win, run_dir):
    """After clicking Comment, the inline composer (contenteditable) opens.
    Find it via UIA. FB labels it variants of 'Write a comment...' / 'Write
    a public comment...' / 'Add a comment'.
    """
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
    # Also try name-contains for "Comment as"
    for label in labels:
        for ct in ("EditControl", "GroupControl", "ButtonControl", "TextControl", "DocumentControl"):
            ms = _uia_find_by_name(cwin, label, control_types=(ct,))
            for m in ms:
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
                    log(f"comment composer match '{label}' ({ct}) at ({cx},{cy})")
                    return (cx, cy, label, ct)
                except Exception:
                    continue
    # Fallback: name-contains "comment as"
    ms = _uia_find_by_name_contains(cwin, "Comment as",
                                    control_types=("EditControl", "GroupControl", "ButtonControl", "TextControl"))
    for m in ms:
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
            log(f"comment composer name-contains 'Comment as' at ({cx},{cy})")
            return (cx, cy, "Comment as*", m.ControlTypeName)
        except Exception:
            continue
    return None


def click_composer_and_verify(win, run_dir):
    """Click the inline comment composer and verify focus with clipboard probe."""
    hit = find_comment_composer_via_uia(win, run_dir)
    if hit is not None:
        cx, cy, label, ct = hit
        log(f"clicking comment composer at ({cx},{cy}) [{label}/{ct}]")
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
            return {"x": cx, "y": cy, "method": "uia", "label": label}
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
    """Submit the comment. FB comment composers submit on plain Enter
    (Shift+Enter inserts newline). Try Enter; verify by waiting and
    confirming the composer becomes empty (clipboard short again) and
    success indicator if visible.
    """
    log("submitting comment via Enter")
    pyautogui.press("enter")
    time.sleep(3.5)
    screenshot(run_dir / "07-after-enter.png")

    # Verify: select-all + copy. If empty (or very short), the comment posted
    # and the composer reset.
    pyautogui.hotkey("ctrl", "a")
    time.sleep(0.2)
    pyautogui.hotkey("ctrl", "c")
    time.sleep(0.3)
    clip = get_clipboard()
    log(f"post-submit clip len={len(clip)} preview={clip[:60]!r}")
    # Heuristic: if cleared to <30 chars (placeholder text or empty), success.
    if len(clip) < 30:
        return True, "enter"

    # Fallback: try Ctrl+Enter
    log("Enter didn't clear composer — trying Ctrl+Enter")
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
    ap.add_argument("--needle", required=True, help="Unique substring from target post body")
    ap.add_argument("--author", required=True, help="Post author name (fallback search)")
    ap.add_argument("--comment-file", required=True)
    ap.add_argument("--label", default="comment")
    args = ap.parse_args()

    body = Path(args.comment_file).read_text(encoding="utf-8")

    run_dir = RUNS_ROOT / f"fb-comment-{int(time.time())}-{args.label}"
    run_dir.mkdir(parents=True, exist_ok=True)

    result = {
        "ts": datetime.now().isoformat(),
        "group_url": args.group_url,
        "needle": args.needle,
        "author": args.author,
        "label": args.label,
        "run_dir": str(run_dir),
        "screenshots": [],
        "steps": [],
        "outcome": None,
        "reason": None,
        "comment_preview": body[:120],
    }

    def finish(outcome, reason=None):
        result["outcome"] = outcome
        result["reason"] = reason
        (run_dir / "result.json").write_text(json.dumps(result, indent=2))
        print("ATLAS_RESULT_JSON:" + json.dumps(result))
        sys.exit(0)

    win = find_chrome_window()
    if not win:
        finish("chrome_missing", "no visible Chrome window")
    result["window"] = {"title": win.title, "rect": [win.left, win.top, win.width, win.height]}
    activate_window(win)

    screenshot(run_dir / "01-before.png")
    result["screenshots"].append(str(run_dir / "01-before.png"))

    log(f"navigating: {args.group_url}")
    navigate_to(args.group_url)
    result["steps"].append("opened new tab + navigated")

    loaded_path = wait_for_fb_load(win, run_dir, seconds=12)
    result["screenshots"].append(loaded_path)
    result["steps"].append("waited 12s for FB load")

    # Click into the page first so PageDown scrolls the feed (not browser chrome)
    cx_click = win.left + win.width // 2
    cy_click = win.top + int(win.height * 0.5)
    pyautogui.click(cx_click, cy_click)
    time.sleep(0.5)

    # Aggressively scroll first — FB lazy-loads posts. The Hellickson post is
    # 21+ hours old so it's well below the fold. Scroll up to 25 times to
    # accumulate posts in the DOM, then find-in-page.
    post_rect = None
    for scroll_attempt in range(1, 26):
        # Try Page Down for chunky scroll
        pyautogui.press("pagedown")
        time.sleep(0.6)

        # Every 5 scrolls, try Ctrl+F + Author name (more selective than 'Today I learned' which appears in the comment too)
        if scroll_attempt % 3 == 0:
            log(f"scroll iter {scroll_attempt}: searching for '{args.author}'")
            find_in_page(args.author, run_dir)
            post_rect = find_target_post_via_uia(win, run_dir, args.author, args.needle)
            if post_rect:
                log(f"FOUND target post at scroll iter {scroll_attempt}")
                screenshot(run_dir / f"03c-scroll-{scroll_attempt}-found.png")
                break
            # Also try the needle
            find_in_page(args.needle, run_dir)
            post_rect = find_target_post_via_uia(win, run_dir, args.author, args.needle)
            if post_rect:
                log(f"FOUND target post via needle at scroll iter {scroll_attempt}")
                screenshot(run_dir / f"03c-scroll-{scroll_attempt}-found-needle.png")
                break

    result["steps"].append(f"scroll+search loop completed (post_rect={post_rect})")

    if not post_rect:
        log("post needle not found after aggressive scroll — closing tab")
        close_tab()
        finish("needle_not_found", f"could not locate post containing '{args.needle}' or author '{args.author}' after 25 scrolls")

    result["steps"].append(f"post rect found {post_rect}")

    # Click Comment button under post
    btn_hit = click_comment_button_under_post(win, run_dir, post_rect)
    if not btn_hit:
        log("comment button not found — closing tab")
        close_tab()
        finish("comment_button_missing", "no Comment button near target post")
    result["steps"].append(f"clicked Comment button at {btn_hit}")

    # Click composer + verify
    composer_hit = click_composer_and_verify(win, run_dir)
    if not composer_hit:
        log("composer not focused — closing tab")
        pyautogui.press("escape")
        time.sleep(0.3)
        close_tab()
        finish("composer_unclickable", "composer did not accept clipboard probe")
    result["steps"].append(f"composer focused {composer_hit}")

    # Paste comment
    ok, sample = paste_comment_body(body, run_dir)
    if not ok:
        log(f"paste verify failed (sample={sample!r})")
        pyautogui.press("escape")
        time.sleep(0.5)
        close_tab()
        finish("paste_failed", f"body not detected after paste, sample={sample!r}")
    result["steps"].append("body pasted + verified")

    # Submit
    submitted, how = submit_comment(win, run_dir)
    if not submitted:
        log("submit failed")
        # Don't close — leave for human visual confirm. Just escape modals.
        pyautogui.press("escape")
        time.sleep(0.5)
        close_tab()
        finish("submit_failed", f"submit attempts left content in composer ({how})")
    result["steps"].append(f"submitted via: {how}")

    time.sleep(2)
    final = run_dir / "08-final.png"
    screenshot(final)
    result["screenshots"].append(str(final))

    try:
        win.activate()
        time.sleep(0.4)
    except Exception:
        pass
    close_tab()
    result["steps"].append("closed tab")

    finish("posted")


if __name__ == "__main__":
    main()
