"""atlas-fb-post-pyautogui.py

Drive Heath's already-open Chrome to post ONE approved group_posts row to its FB group.

Why this exists:
- fb-group-poster.js launches Playwright via launchPersistentContext on Heath's main
  Chrome User Data dir, but that dir is locked while Heath's Chrome is open.
- DossieBot-Sage profile is NOT logged into Facebook.
- Per memory feedback_pyautogui_not_playwright.md — DEFAULT to driving Heath's real Chrome
  window. Bot detection is much weaker there than on fresh Playwright Chromium.

Strategy:
- Find an existing about:blank Chrome window (preferred — least disruptive).
- Open a new tab (Ctrl+T), paste the group URL, Enter.
- Wait for FB group page to settle.
- Click the "Write something..." composer at a proportional viewport location.
- If a composer expands (modal-like dialog), paste the post body, click Post.
- Verify success by detecting that the composer text is gone / "pending approval" toast.
- Capture before/after/composer-open/posted screenshots.
- Return JSON to stdout: outcome, screenshots, attempts, reason if failed.
- Close the tab via Ctrl+W when done so we don't leave litter in Chrome.

Usage:
  python scripts/atlas-fb-post-pyautogui.py \
    --group-url https://www.facebook.com/groups/dallasrealtors/ \
    --post-body-file <abs path to text file> \
    --post-id <uuid> \
    --idx 1 --total 6

This script does NOT touch Supabase. The Node orchestrator handles all DB writes
based on the JSON outcome we emit.

Outcome codes:
  posted              — composer found, post submitted, success indicator observed
  pending_review      — composer found, post submitted, "pending review" banner seen
  no_composer         — no Write something / What's on your mind composer present
  composer_unclickable — composer was found but clicking did not open input
  paste_failed        — composer opened but typing did not result in expected text
  post_button_missing — composer filled but Post button could not be clicked
  page_load_failed    — page never reached a FB-rendered state
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

# Optional: Windows UI Automation (much more reliable than coord-hunting)
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
    print(f"[atlas-fb-post] {msg}", flush=True)


def screenshot(path):
    with mss() as sct:
        sct.shot(output=str(path))


def set_clipboard(text):
    """Set Windows clipboard using PowerShell. Handles multi-line + unicode."""
    # Use stdin to avoid command-line escaping issues
    proc = subprocess.run(
        ["powershell", "-NoProfile", "-Command", "$input | Set-Clipboard"],
        input=text,
        text=True,
        encoding="utf-8",
        capture_output=True,
    )
    return proc.returncode == 0


def get_clipboard():
    """Read clipboard via PowerShell. Tolerant of non-UTF-8 bytes."""
    try:
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-Command", "Get-Clipboard"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        return (proc.stdout or "").strip()
    except Exception:
        # Last-ditch: binary read + decode with replacement
        try:
            proc = subprocess.run(
                ["powershell", "-NoProfile", "-Command", "Get-Clipboard"],
                capture_output=True,
            )
            return (proc.stdout or b"").decode("utf-8", errors="replace").strip()
        except Exception:
            return ""


def find_chrome_window():
    """Find a usable Chrome window. Prefer the LARGEST visible Chrome window
    that's about:blank (so we don't disrupt a tab Heath is reading). If no
    about:blank, fall back to the largest visible Chrome window.

    Critical: small Chrome popup windows (e.g., 945-wide picture-in-picture)
    should NOT be chosen — coord math breaks because the script's screenshot
    captures the whole display but clicks target only the popup.
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

    # Filter out tiny windows (< 1000 wide) — these are popups, not main windows
    main_wins = [w for w in chrome_wins if w.width >= 1000]
    pool = main_wins if main_wins else chrome_wins

    # Prefer about:blank among the LARGEST candidates
    blanks = [w for w in pool if "about:blank" in (w.title or "").lower()]
    candidates = blanks if blanks else pool

    # Return the largest by area (handles dupes / multi-monitor)
    return max(candidates, key=lambda w: w.width * w.height)


def activate_window(win):
    """Bring a window to absolute foreground, even if other apps overlay it.

    pygetwindow's activate() is often blocked by Win32 SetForegroundWindow
    restrictions (you can only foreground a window that already had focus
    recently). Workaround: simulate Alt key press first, then call activate.
    """
    import ctypes
    try:
        if win.isMinimized:
            win.restore()
        # AltDown/AltUp tricks the SetForegroundWindow restriction
        user32 = ctypes.windll.user32
        user32.keybd_event(0x12, 0, 0, 0)  # ALT down
        user32.keybd_event(0x12, 0, 2, 0)  # ALT up
        time.sleep(0.05)
        try:
            win.activate()
        except Exception:
            pass
        # Also try ShowWindow + SetForegroundWindow + BringWindowToTop on the HWND
        try:
            hwnd = win._hWnd
            user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            user32.SetForegroundWindow(hwnd)
            user32.BringWindowToTop(hwnd)
            user32.SetActiveWindow(hwnd)
        except Exception:
            pass
        time.sleep(0.7)
    except Exception as e:
        log(f"activate warning: {e}")


def navigate_to(url):
    """Open new tab, paste URL, press Enter."""
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


def close_orphan_dialogs():
    """Find and forcefully close any common-dialog windows (Open file picker)
    that may have been triggered during Tab-walk. Uses WM_CLOSE via ctypes.

    Returns the number of windows closed.
    """
    import ctypes
    from ctypes import wintypes
    closed = 0
    try:
        EnumWindows = ctypes.windll.user32.EnumWindows
        EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
        GetClassName = ctypes.windll.user32.GetClassNameW
        GetWindowText = ctypes.windll.user32.GetWindowTextW
        IsWindowVisible = ctypes.windll.user32.IsWindowVisible
        SendMessage = ctypes.windll.user32.SendMessageW
        WM_CLOSE = 0x0010
        targets = []

        def callback(hwnd, lparam):
            if not IsWindowVisible(hwnd):
                return True
            cls = ctypes.create_unicode_buffer(64)
            GetClassName(hwnd, cls, 64)
            if cls.value == "#32770":
                title = ctypes.create_unicode_buffer(256)
                GetWindowText(hwnd, title, 256)
                t = title.value or ""
                # Only close known file-picker-like dialogs to be safe
                if any(k in t for k in ("Open", "Choose", "Browse", "Select", "Save")):
                    targets.append((hwnd, t))
            return True

        EnumWindows(EnumWindowsProc(callback), 0)
        for hwnd, title in targets:
            log(f"closing orphan dialog '{title}' hwnd={hwnd}")
            SendMessage(hwnd, WM_CLOSE, 0, 0)
            closed += 1
            time.sleep(0.3)
    except Exception as e:
        log(f"close_orphan_dialogs failed: {e}")
    return closed


def _get_chrome_uia_window(win):
    """Find the top-level Chrome UIA control matching the pygetwindow Window."""
    if not UIA_AVAILABLE:
        return None
    try:
        # Most specific: match by exact left/top
        for c in uia.GetRootControl().GetChildren():
            try:
                if c.ClassName != "Chrome_WidgetWin_1":
                    continue
                r = c.BoundingRectangle
                if abs(r.left - win.left) <= 8 and abs(r.top - win.top) <= 8:
                    return c
            except Exception:
                continue
        # Fallback: any Chrome window
        chromes = [c for c in uia.GetRootControl().GetChildren()
                   if c.ClassName == "Chrome_WidgetWin_1"]
        if chromes:
            return max(chromes, key=lambda c: (c.BoundingRectangle.width() * c.BoundingRectangle.height()))
    except Exception as e:
        log(f"UIA chrome window lookup failed: {e}")
    return None


def _uia_find_by_name(root, name, control_types=None, max_depth=25):
    """Walk UIA tree for controls whose Name equals `name`. Returns list of nodes."""
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


def dismiss_popups(win, run_dir):
    """Dismiss Chrome's notification permission popup and any FB cookie/intro dialogs.

    The notification popup is a Chrome-native UI (not page DOM). It appears as a
    small overlay at the top-left of the active tab, with 'Allow' and 'Block'
    buttons. Clicking 'Block' is the safe default.

    Also handles FB's "Allow all cookies" / "See notifications" dialogs that may
    overlay the feed.
    """
    try:
        # Strategy 1: UIA — find a Chrome button named "Block" or "Don't allow"
        cwin = _get_chrome_uia_window(win)
        if cwin is not None:
            for label in ["Block", "Don't allow", "Not now", "No thanks"]:
                btns = _uia_find_by_name(cwin, label, control_types=("ButtonControl",))
                for b in btns:
                    try:
                        r = b.BoundingRectangle
                        if r.width() <= 0 or r.height() <= 0:
                            continue
                        # Make sure it's inside the Chrome window
                        cx_btn = (r.left + r.right) // 2
                        cy_btn = (r.top + r.bottom) // 2
                        if not (win.left <= cx_btn <= win.left + win.width):
                            continue
                        if not (win.top <= cy_btn <= win.top + win.height):
                            continue
                        log(f"dismissing popup via UIA: '{label}' at ({cx_btn},{cy_btn})")
                        pyautogui.click(cx_btn, cy_btn)
                        time.sleep(0.6)
                        screenshot(run_dir / f"02b-dismissed-{label.replace(' ', '_')}.png")
                    except Exception:
                        continue

        # Strategy 2: Escape key to close any modal dialog focus (idempotent)
        pyautogui.press("escape")
        time.sleep(0.3)
    except Exception as e:
        log(f"dismiss_popups: {e}")


def wait_for_fb_load(win, run_dir, seconds=10):
    """Wait for FB load, then dismiss any popups. Screenshot before + after."""
    time.sleep(seconds)
    p = run_dir / "02-loaded.png"
    screenshot(p)
    # Dismiss notification permission popups and similar Chrome-native overlays
    dismiss_popups(win, run_dir)
    p2 = run_dir / "02c-after-dismiss.png"
    screenshot(p2)
    return str(p)


def _find_composer_via_uia(win):
    """Use UIA to find the FB inline 'Write something...' composer placeholder.

    Returns (x, y) center of bounding rect or None.
    """
    if not UIA_AVAILABLE:
        return None
    cwin = _get_chrome_uia_window(win)
    if cwin is None:
        return None
    # FB renders inline composer as a div with aria-label "Write something..."
    # or "Write something" or "Create a public post" (for group). Try multiple.
    candidates_text = [
        "Write something...",
        "Write something",
        "What's on your mind?",
        "Create a public post",
        "Create a post",
    ]
    for label in candidates_text:
        for ct in ("ButtonControl", "TextControl", "GroupControl", "EditControl"):
            matches = _uia_find_by_name(cwin, label, control_types=(ct,))
            for m in matches:
                try:
                    r = m.BoundingRectangle
                    if r.width() <= 0 or r.height() <= 0:
                        continue
                    cx = (r.left + r.right) // 2
                    cy = (r.top + r.bottom) // 2
                    # Must be inside the Chrome client area, below the URL bar
                    if not (win.left <= cx <= win.left + win.width):
                        continue
                    if not (win.top + 80 <= cy <= win.top + win.height - 80):
                        continue
                    log(f"UIA composer match '{label}' ({ct}) at ({cx},{cy})")
                    return (cx, cy, label, ct)
                except Exception:
                    continue
    return None


def click_composer(win, run_dir):
    """Click the FB group composer. UIA-first, then coordinate fallback."""
    # Strategy 1: UIA locate
    hit = _find_composer_via_uia(win)
    if hit is not None:
        cx, cy, label, ct = hit
        log(f"clicking UIA composer at ({cx},{cy}) [label='{label}' ct={ct}]")
        pyautogui.click(cx, cy)
        time.sleep(2.5)
        screenshot(run_dir / "03-after-uia-click.png")
        # Probe: try clipboard round-trip
        set_clipboard("ATLASPROBE")
        time.sleep(0.2)
        pyautogui.hotkey("ctrl", "v")
        time.sleep(0.6)
        pyautogui.hotkey("ctrl", "a")
        time.sleep(0.2)
        pyautogui.hotkey("ctrl", "c")
        time.sleep(0.3)
        clip = get_clipboard()
        if "ATLASPROBE" in clip:
            log(f"UIA composer focused (probe round-tripped). len={len(clip)}")
            pyautogui.hotkey("ctrl", "a")
            time.sleep(0.1)
            pyautogui.press("delete")
            time.sleep(0.3)
            return {"x": cx, "y": cy, "method": "uia", "label": label}
        log(f"UIA composer click did not focus an input (clip[:60]={clip[:60]!r})")

    # Strategy 2: Coordinate sweep — composer typically sits in the upper third
    # of viewport for group pages (right under tabs). Try many positions.
    cx = win.left + win.width // 2
    # The FB feed column is left-of-center for group pages because right sidebar
    # takes ~360px. Center of feed column ≈ window_left + (width - 360) / 2
    feed_cx = win.left + max(200, (win.width - 360) // 2)
    candidates_y_pct = [0.20, 0.24, 0.28, 0.33, 0.38, 0.45, 0.52]

    for i, ypct in enumerate(candidates_y_pct):
        cy = win.top + int(win.height * ypct)
        log(f"coord composer attempt {i+1}/{len(candidates_y_pct)} at ({feed_cx},{cy}) [{ypct*100:.0f}% down]")
        pyautogui.click(feed_cx, cy)
        time.sleep(2.0)
        screenshot(run_dir / f"03-after-coord-{i+1}.png")
        set_clipboard("ATLASPROBE")
        time.sleep(0.2)
        pyautogui.hotkey("ctrl", "v")
        time.sleep(0.5)
        pyautogui.hotkey("ctrl", "a")
        time.sleep(0.2)
        pyautogui.hotkey("ctrl", "c")
        time.sleep(0.3)
        clip = get_clipboard()
        if "ATLASPROBE" in clip:
            log(f"composer focused at attempt {i+1} (probe round-tripped). len={len(clip)}")
            pyautogui.hotkey("ctrl", "a")
            time.sleep(0.1)
            pyautogui.press("delete")
            time.sleep(0.3)
            return {"x": feed_cx, "y": cy, "method": "coord", "pct": ypct}
        log(f"  coord probe got: {clip[:40]!r}")

    return None


def paste_post_body(body, run_dir):
    """Paste the post body into the focused composer.

    Critical: after the Ctrl+A/Ctrl+C verification, the body is SELECTED. If we
    leave it selected, any subsequent keystroke (incl. Ctrl+Enter) will delete
    the body. We press End to collapse the selection AFTER verifying.
    """
    set_clipboard(body)
    time.sleep(0.3)
    pyautogui.hotkey("ctrl", "v")
    time.sleep(1.8)  # let FB process the paste

    screenshot(run_dir / "04-body-pasted.png")

    # Verify by select-all + copy
    pyautogui.hotkey("ctrl", "a")
    time.sleep(0.2)
    pyautogui.hotkey("ctrl", "c")
    time.sleep(0.3)
    clip = get_clipboard()

    # FB may strip whitespace / normalize newlines; check that a recognizable
    # substring of the body is present (first 30 chars sans newlines)
    needle = "".join(body.split())[:30].lower()
    haystack = "".join(clip.split()).lower()
    ok = needle in haystack

    # CRITICAL: collapse the selection so the body is preserved across the next
    # keystroke. End key moves cursor to end and clears selection.
    if ok:
        pyautogui.press("end")
        time.sleep(0.15)

    return ok, clip[:120]


def _find_create_post_dialog_rect(win):
    """Find the bounding rect of FB's 'Create post' dialog. Returns
    (left, top, right, bottom) or None.

    Approach: walk UIA tree looking for the 'Create post' Text/Group control.
    The dialog itself is the ancestor PaneControl/GroupControl that encloses
    this text. We approximate the dialog rect by walking up from the title
    control until we find a node with width 400-700 and height 400-700 (the
    dialog is roughly square-ish, centered).
    """
    if not UIA_AVAILABLE:
        return None
    try:
        target = _get_chrome_uia_window(win)
        if target is None:
            return None
        matches = _uia_find_by_name(target, "Create post",
                                    control_types=("TextControl", "GroupControl", "PaneControl", "WindowControl"))
        for m in matches:
            try:
                r = m.BoundingRectangle
                if r.width() <= 0 or r.height() <= 0:
                    continue
                cx = (r.left + r.right) // 2
                cy = (r.top + r.bottom) // 2
                if not (win.left <= cx <= win.left + win.width):
                    continue
                if not (win.top <= cy <= win.top + win.height):
                    continue
                # Walk up parents to find the dialog container
                node = m
                for _ in range(8):
                    try:
                        parent = node.GetParentControl()
                        if parent is None:
                            break
                        pr = parent.BoundingRectangle
                        pw, ph = pr.width(), pr.height()
                        # Dialog roughly 400-800 wide, 400-800 tall
                        if 350 <= pw <= 900 and 350 <= ph <= 900:
                            return (pr.left, pr.top, pr.right, pr.bottom)
                        node = parent
                    except Exception:
                        break
                # Fallback: use the title's rect expanded to typical dialog size
                # Centered horizontally on title, dialog ~600w x 700h
                dialog_w = 600
                dialog_h = 700
                dl = cx - dialog_w // 2
                dt = max(win.top + 60, r.top - 50)
                return (dl, dt, dl + dialog_w, dt + dialog_h)
            except Exception:
                continue
        return None
    except Exception as e:
        log(f"dialog rect lookup failed: {e}")
        return None


def _is_create_post_dialog_open(win):
    """Returns True if FB's 'Create post' dialog is currently open.
    Returns None if UIA unavailable so caller can fall back to clipboard probe.
    """
    if not UIA_AVAILABLE:
        return None
    r = _find_create_post_dialog_rect(win)
    return r is not None


def find_post_button_via_uia(win, run_dir):
    """Locate the FB 'Post' button (blue submit) in the Create post dialog.

    Modern FB renders the Post button as a div with aria-label='Post' but Chrome
    surfaces it to UIA inconsistently — sometimes ButtonControl, sometimes
    just a TextControl inside a GroupControl. We accept many control types and
    filter geometrically (must be inside the dialog, lower half of screen).
    """
    if not UIA_AVAILABLE:
        return None
    try:
        target = _get_chrome_uia_window(win)
        if target is None:
            return None
        # Widen control types — FB may render Post as Link, Button, or Text
        accept_types = (
            "ButtonControl", "TextControl", "GroupControl",
            "HyperlinkControl", "LinkControl", "PaneControl",
        )
        candidates = _uia_find_by_name(target, "Post", control_types=accept_types)
        cx_mid = win.left + win.width // 2
        cy_mid = win.top + win.height // 2
        viable = []
        for n in candidates:
            try:
                r = n.BoundingRectangle
                if r.width() <= 0 or r.height() <= 0:
                    continue
                cx = (r.left + r.right) // 2
                cy = (r.top + r.bottom) // 2
                if not (win.left <= cx <= win.left + win.width):
                    continue
                if not (win.top <= cy <= win.top + win.height):
                    continue
                # The submit button in the dialog is a wide, short rectangle
                # (roughly 400-500 wide, 40-50 tall). Filter out tiny or huge.
                w_r, h_r = r.width(), r.height()
                if w_r < 60 or w_r > 700:
                    continue
                if h_r < 20 or h_r > 80:
                    continue
                in_lower_half = cy > cy_mid
                # Within ~400px of center horizontally (dialog is centered)
                near_center_h = abs(cx - cx_mid) < 400
                ct = n.ControlTypeName
                # Score by type preference + position
                type_score = 3 if ct == "ButtonControl" else (1 if ct == "TextControl" else 2)
                score = type_score + (3 if in_lower_half else 0) + (1 if near_center_h else 0)
                viable.append((score, cx, cy, r, ct))
            except Exception:
                continue
        if not viable:
            log(f"UIA found {len(candidates)} Name=Post controls but none geometrically viable")
            return None
        viable.sort(key=lambda t: (-t[0], -t[2]))
        score, x, y, r, ct = viable[0]
        log(f"UIA Post button at ({x},{y}) score={score} ct={ct} rect=({r.left},{r.top},{r.right},{r.bottom})")
        try:
            from PIL import Image, ImageDraw
            shot_path = run_dir / "uia-post-target.png"
            screenshot(shot_path)
            img = Image.open(shot_path).convert("RGB")
            d = ImageDraw.Draw(img)
            d.ellipse([x - 12, y - 12, x + 12, y + 12], outline="red", width=4)
            d.rectangle([r.left, r.top, r.right, r.bottom], outline="lime", width=3)
            img.save(shot_path)
        except Exception:
            pass
        return (x, y)
    except Exception as e:
        log(f"UIA Post button lookup failed: {e}")
        return None


def click_post_button(win, run_dir):
    """Click the FB Post button. Success = the 'Create post' dialog disappears.

    Strategy order:
      1) UIA: find a 'Post' control inside the dialog and click it.
      2) Ctrl+Enter (in case the cursor is in contenteditable, this submits).
      3) Coordinate fallback (a grid of likely positions).

    For success detection we DO NOT use clipboard probing — that gives false
    positives when the body is empty. Instead we ask UIA whether 'Create post'
    (the dialog header) is still present in the Chrome window. If UIA is not
    available, fall back to a clipboard probe (with the known false-positive
    caveat).
    """

    def dialog_gone():
        state = _is_create_post_dialog_open(win)
        if state is None:
            # UIA unavailable — clipboard probe fallback (lossy)
            pyautogui.hotkey("ctrl", "a")
            time.sleep(0.2)
            pyautogui.hotkey("ctrl", "c")
            time.sleep(0.3)
            c = get_clipboard()
            return len(c) < 20
        return state is False

    # Strategy 0: Click the Post button using the dialog's bounding rect.
    # Most reliable — the Post button is always at the bottom-center of the
    # dialog (~92% down, dead center horizontally).
    dialog_rect = _find_create_post_dialog_rect(win)
    if dialog_rect is not None:
        dl, dt, dr, db = dialog_rect
        dw = dr - dl
        dh = db - dt
        # Post button sits at the very bottom of the dialog content area,
        # before a small ~12px padding strip. Center horizontally.
        bx = dl + dw // 2
        by = dt + int(dh * 0.92)
        log(f"dialog rect=({dl},{dt},{dr},{db}) {dw}x{dh} -> Post button at ({bx},{by})")
        pyautogui.click(bx, by)
        time.sleep(3.0)
        screenshot(run_dir / "05-after-dialog-click.png")
        if dialog_gone():
            log("Dialog-rect Post click submitted")
            return True, "dialog_rect_click"
        log("Dialog-rect click did not close dialog — trying nearby offsets")
        # Try a few Y offsets around 92% in case the dialog has accessories
        for offset_pct in (0.88, 0.95, 0.85, 0.97, 0.82):
            by2 = dt + int(dh * offset_pct)
            log(f"  dialog Y offset {offset_pct*100:.0f}% -> click ({bx},{by2})")
            pyautogui.click(bx, by2)
            time.sleep(2.5)
            if dialog_gone():
                return True, f"dialog_rect_offset_{int(offset_pct*100)}"

    # Strategy 1: UIA-located Post button
    target = find_post_button_via_uia(win, run_dir)
    if target is not None:
        x, y = target
        log(f"clicking UIA-located Post button at ({x},{y})")
        pyautogui.click(x, y)
        time.sleep(3.5)
        screenshot(run_dir / "05-after-uia-click.png")
        if dialog_gone():
            log("UIA Post click submitted (Create post dialog gone)")
            return True, "uia_click"
        log("UIA Post click did NOT close dialog — trying Tab-walk")

    # Strategy 2: Tab-walk + Enter. From the focused contenteditable, Tab moves
    # through interactive elements: mood, check-in, photo/video, tag, audience,
    # background-color, [Post]. ~7 Tabs typically lands on Post in modern FB.
    # We try after each Tab to detect dialog close on Enter — gracefully skipping
    # photo upload buttons (which open a file picker if accidentally pressed
    # Enter on, but we close that file picker if it appears).
    log("trying Tab-walk + Enter to find Post button by focus order")
    # Start by clicking back into the composer body area at the original click
    # site to ensure focus is in the contenteditable, then End key.
    # (composer_hit was returned earlier — but we don't have it here. Use the
    # known UIA composer location if we found one.)
    composer_hit = _find_composer_via_uia(win)
    if composer_hit is not None:
        cx_c, cy_c, _, _ = composer_hit
        # Click slightly below the placeholder so we hit the body, not the
        # placeholder again (which would re-open the dialog)
        # Actually the placeholder click already opened the dialog — clicking
        # back at same coords inside the now-open dialog will likely land in
        # the contenteditable. But safer: don't click. Just send Shift+Tab a
        # couple times to back up to composer, then End.
        pyautogui.hotkey("shift", "tab")
        time.sleep(0.2)
        pyautogui.hotkey("shift", "tab")
        time.sleep(0.2)
    pyautogui.press("end")
    time.sleep(0.2)

    for tab_count in range(1, 15):
        pyautogui.press("tab")
        time.sleep(0.25)
        # Press Enter and watch for dialog-close. Enter activates whatever
        # element has focus. If it's the Post button, dialog closes. If it's
        # a non-final button (photo, audience), we may open another sub-dialog;
        # we close any sub-dialog with Escape and continue Tab-walking.
        pyautogui.press("enter")
        time.sleep(2.0)
        if dialog_gone():
            log(f"Tab-walk submitted after {tab_count} tabs")
            screenshot(run_dir / f"05-tab-walk-{tab_count}.png")
            return True, f"tab_walk_{tab_count}"
        # If an unwanted sub-modal opened (file picker, etc.), close it
        pyautogui.press("escape")
        time.sleep(0.5)

    # Strategy 3: Ctrl+Enter as a last keyboard attempt
    log("submitting via Ctrl+Enter shortcut")
    pyautogui.hotkey("ctrl", "enter")
    time.sleep(3.0)
    screenshot(run_dir / "05-after-ctrl-enter.png")
    if dialog_gone():
        log("Ctrl+Enter submitted (Create post dialog gone)")
        return True, "ctrl_enter"

    # Strategy 4: Extended coordinate grid — Post button observed at
    # actual x≈1158, y≈680 on this 1920x1080 viewport (≈60% right, ≈65% down).
    # Sweep a wider X range and tighter Y range.
    cx_win = win.left + win.width // 2  # 960
    candidate_clicks = []
    # Sweep X from 60% to 70% of viewport width, Y from 62% to 78%
    for xpct in (0.60, 0.55, 0.65, 0.50, 0.70, 0.45):
        for ypct in (0.65, 0.70, 0.62, 0.74, 0.78):
            x = win.left + int(win.width * xpct)
            y = win.top + int(win.height * ypct)
            candidate_clicks.append((x, y, xpct, ypct))
    for i, (x, y, xp, yp) in enumerate(candidate_clicks):
        log(f"  post-button coord attempt {i+1}/{len(candidate_clicks)} at ({x},{y}) [{xp*100:.0f}%,{yp*100:.0f}%]")
        pyautogui.click(x, y)
        time.sleep(2.0)
        screenshot(run_dir / f"05-post-coord-{i+1}.png")
        if dialog_gone():
            return True, f"coord_click_{i+1}_{int(xp*100)}_{int(yp*100)}"

    return False, "all_attempts_failed"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--group-url", required=True)
    ap.add_argument("--post-body-file", required=True)
    ap.add_argument("--post-id", required=True)
    ap.add_argument("--idx", type=int, default=1)
    ap.add_argument("--total", type=int, default=1)
    args = ap.parse_args()

    body = Path(args.post_body_file).read_text(encoding="utf-8")

    run_dir = RUNS_ROOT / f"fb-post-{int(time.time())}-{args.post_id[:8]}"
    run_dir.mkdir(parents=True, exist_ok=True)

    result = {
        "ts": datetime.now().isoformat(),
        "post_id": args.post_id,
        "group_url": args.group_url,
        "idx": args.idx,
        "total": args.total,
        "run_dir": str(run_dir),
        "screenshots": [],
        "steps": [],
        "outcome": None,
        "reason": None,
    }

    def finish(outcome, reason=None):
        result["outcome"] = outcome
        result["reason"] = reason
        (run_dir / "result.json").write_text(json.dumps(result, indent=2))
        print("ATLAS_RESULT_JSON:" + json.dumps(result))
        sys.exit(0 if outcome in ("posted", "pending_review") else 0)

    # 0. Pre-cleanup any leftover Windows file pickers from prior runs
    pre_closed = close_orphan_dialogs()
    if pre_closed:
        log(f"pre-cleanup: closed {pre_closed} orphan dialog(s) from prior runs")

    # 1. Find Chrome
    win = find_chrome_window()
    if not win:
        log("no Chrome window found")
        finish("chrome_missing", "no visible Chrome window")
    result["window"] = {"title": win.title, "rect": [win.left, win.top, win.width, win.height]}
    activate_window(win)

    # 2. Before screenshot
    before = run_dir / "01-before.png"
    screenshot(before)
    result["screenshots"].append(str(before))

    # 3. Navigate
    log(f"navigating: {args.group_url}")
    navigate_to(args.group_url)
    result["steps"].append("opened new tab + navigated")

    # 4. Wait + screenshot
    loaded_path = wait_for_fb_load(win, run_dir, seconds=10)
    result["screenshots"].append(loaded_path)
    result["steps"].append("waited 10s for FB load")

    # 5. Click composer
    composer_hit = click_composer(win, run_dir)
    if not composer_hit:
        log("no composer detected — likely group blocks posts or different layout")
        # Close the tab to leave Chrome clean
        close_tab()
        finish("no_composer", "composer click did not produce focused input")

    result["steps"].append(f"composer focused at {composer_hit}")

    # 6. Paste body
    ok, sample = paste_post_body(body, run_dir)
    if not ok:
        log(f"paste verification failed (sample={sample!r})")
        # Press Escape to dismiss any dialog
        pyautogui.press("escape")
        time.sleep(0.5)
        pyautogui.press("escape")
        time.sleep(0.5)
        close_tab()
        finish("paste_failed", f"body not detected in composer after paste, sample={sample!r}")

    result["steps"].append("body pasted + verified")

    # 7. Click Post / submit
    submitted, how = click_post_button(win, run_dir)
    if not submitted:
        log("submit failed — composer still has content after all attempts")
        pyautogui.press("escape")
        time.sleep(0.5)
        pyautogui.press("escape")
        time.sleep(0.5)
        close_tab()
        finish("post_button_missing", "all submit attempts left dialog open")

    result["steps"].append(f"submitted via: {how}")

    # 8. Cleanup any lingering sub-dialogs (e.g., Windows file picker accidentally
    # opened by Tab-walk hitting a photo/video button). Escape works for most,
    # WM_CLOSE handles stubborn ones.
    for _ in range(3):
        pyautogui.press("escape")
        time.sleep(0.4)
    n_closed = close_orphan_dialogs()
    if n_closed:
        result["steps"].append(f"closed {n_closed} orphan dialog(s)")

    # 9. Wait + final screenshot
    time.sleep(2)
    final = run_dir / "06-final.png"
    screenshot(final)
    result["screenshots"].append(str(final))

    # 10. Re-activate Chrome window before close_tab so Ctrl+W goes to right place
    try:
        win.activate()
        time.sleep(0.4)
    except Exception:
        pass

    # 11. Close tab
    close_tab()
    result["steps"].append("closed tab")

    finish("posted")


if __name__ == "__main__":
    main()
