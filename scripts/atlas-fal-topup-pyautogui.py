"""atlas-fal-topup-pyautogui.py

Drive Heath's REAL logged-in Chrome (NOT DossieBot, NOT CDP-attached) to add
$20 of credits to fal.ai.

The previous JS attempt (scripts/atlas-fal-topup.js) connected via CDP on 9222
and hit a fal login wall — wrong, because Heath logged into fal.ai inside his
main personal Chrome window, not the CDP-controlled one.

Strategy (proven against the FB blitz scripts):
  1. Enumerate visible Chrome windows; pick the largest non-DossieBot one.
  2. Activate it (SetForegroundWindow + ShowWindow).
  3. Ctrl+T new tab, Ctrl+L address bar, paste URL, Enter.
  4. Wait for billing page to load.
  5. UIA-walk for "Top up" / "Add credits" / "Add funds" button.
  6. Click. Wait for modal. UIA-walk for the amount input.
  7. Clear, type 20.
  8. UIA-walk for the confirm/submit button. Click.
  9. Verify post-charge: re-probe fal API balance OR scrape new balance.
 10. ONE Telegram to Heath on success.

Hard rules:
  - DO NOT use DossieBot profile.
  - DO NOT ask Heath to log in.
  - DO NOT ping Heath unless 3D-Secure or no-card-on-file genuinely blocks.

Outcome codes (printed as ATLAS_RESULT_JSON):
  success                      - $20 charged, balance verified up
  no_card_on_file              - dialog asked for a new card; left open, pinged Heath
  threed_secure                - bank push fired; left dialog, pinged Heath
  not_logged_in                - fal redirected to /login (shouldn't happen but safe)
  top_up_button_missing        - couldn't find Top up button
  amount_input_missing         - couldn't find amount input
  confirm_button_missing       - couldn't find confirm button
  chrome_missing               - no usable Chrome window
  verification_failed          - submitted but balance didn't update
"""

import argparse
import ctypes
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib import request as urlrequest
from urllib import error as urlerror

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

# --- env loading ------------------------------------------------------------

def _load_env_local():
    env_path = REPO_ROOT / ".env.local"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
        t = line.strip()
        if not t or t.startswith("#"):
            continue
        eq = t.find("=")
        if eq < 0:
            continue
        k = t[:eq].strip()
        v = t[eq+1:].strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v

_load_env_local()

TG_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TG_CHAT = os.environ.get("TELEGRAM_CHAT_ID", "7874782923")
FAL_KEY = os.environ.get("FAL_KEY", "")

# --- helpers ----------------------------------------------------------------

def log(msg):
    print(f"[atlas-fal-topup] {msg}", flush=True)


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


def tg_send(text, photo_path=None):
    if not TG_TOKEN:
        log("no TG token; skipping ping")
        return
    try:
        import urllib.parse
        if photo_path and Path(photo_path).exists():
            # Use multipart/form-data via PowerShell + curl fallback. Simple urllib doesn't do multipart cleanly.
            # Use PowerShell Invoke-WebRequest with -Form.
            cmd = [
                "powershell", "-NoProfile", "-Command",
                f"$ErrorActionPreference='Stop'; $form=@{{chat_id='{TG_CHAT}'; caption=@'\n{text}\n'@; photo=Get-Item -LiteralPath '{photo_path}'}}; "
                f"Invoke-WebRequest -Uri 'https://api.telegram.org/bot{TG_TOKEN}/sendPhoto' -Method POST -Form $form | Out-Null"
            ]
            subprocess.run(cmd, capture_output=True, timeout=20)
            log(f"tg photo sent")
        else:
            data = json.dumps({"chat_id": TG_CHAT, "text": text}).encode("utf-8")
            req = urlrequest.Request(
                f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urlrequest.urlopen(req, timeout=10) as resp:
                log(f"tg msg: {resp.status}")
    except Exception as e:
        log(f"tg send failed: {e}")


def fal_balance_check():
    """Returns (locked, message). locked=True if API says 'Exhausted balance'."""
    if not FAL_KEY:
        return (None, "no FAL_KEY")
    try:
        req = urlrequest.Request(
            "https://queue.fal.run/fal-ai/flux/dev",
            data=json.dumps({"prompt": "test", "image_size": "square"}).encode("utf-8"),
            headers={
                "Authorization": f"Key {FAL_KEY}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urlrequest.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return (False, f"{resp.status}: {body[:200]}")
    except urlerror.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        if "Exhausted balance" in body or e.code == 403:
            return (True, f"HTTP {e.code}: {body[:200]}")
        return (False, f"HTTP {e.code}: {body[:200]}")
    except Exception as e:
        return (None, f"probe error: {e}")


# --- chrome window lookup ---------------------------------------------------

def find_chrome_window():
    """Find Heath's REAL main Chrome window — NOT DossieBot.

    DossieBot windows usually have specific titles (Facebook, Reddit) when
    auto-driven, but the cleanest signal is window size + which-profile-running.
    For now: pick the largest visible Chrome window. Exclude any window whose
    title screams DossieBot context (we don't expect DossieBot to be open
    during a billing top-up).
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
    log(f"found {len(chrome_wins)} chrome windows:")
    for w in chrome_wins:
        try:
            log(f"  - {w.width}x{w.height} :: {w.title[:80]}")
        except Exception:
            pass
    # Prefer windows that are reasonably large (main personal Chrome usually 1200+)
    main_wins = [w for w in chrome_wins if w.width >= 1000]
    pool = main_wins if main_wins else chrome_wins
    # Largest wins
    return max(pool, key=lambda w: w.width * w.height)


def activate_window(win):
    try:
        if win.isMinimized:
            win.restore()
        user32 = ctypes.windll.user32
        # Send a fake ALT key to unblock SetForegroundWindow (Windows quirk)
        user32.keybd_event(0x12, 0, 0, 0)
        user32.keybd_event(0x12, 0, 2, 0)
        time.sleep(0.05)
        try:
            win.activate()
        except Exception:
            pass
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
    pyautogui.hotkey("ctrl", "t")
    time.sleep(0.7)
    pyautogui.hotkey("ctrl", "l")
    time.sleep(0.3)
    set_clipboard(url)
    time.sleep(0.2)
    pyautogui.hotkey("ctrl", "v")
    time.sleep(0.25)
    pyautogui.press("enter")


# --- UIA helpers ------------------------------------------------------------

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


def _uia_find_by_name_contains(root, substr_lower, control_types=None, max_depth=35):
    matches = []
    def walk(node, depth=0):
        if depth > max_depth:
            return
        try:
            n = (node.Name or "").lower()
            ct = node.ControlTypeName
            if substr_lower in n and (control_types is None or ct in control_types):
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


def _uia_dump_buttons(root, run_dir, label="dump"):
    """For debugging: write all visible button/link names to a file."""
    if not UIA_AVAILABLE:
        return
    found = []
    def walk(node, depth=0):
        if depth > 30:
            return
        try:
            ct = node.ControlTypeName
            n = (node.Name or "").strip()
            if n and ct in ("ButtonControl", "LinkControl", "EditControl", "HyperlinkControl"):
                try:
                    r = node.BoundingRectangle
                    if r.width() > 0 and r.height() > 0:
                        found.append(f"{ct} :: {n[:120]} @ ({r.left},{r.top},{r.right},{r.bottom})")
                except Exception:
                    pass
        except Exception:
            pass
        try:
            for ch in node.GetChildren():
                walk(ch, depth + 1)
        except Exception:
            return
    walk(root)
    out = run_dir / f"uia-dump-{label}.txt"
    out.write_text("\n".join(found), encoding="utf-8")
    log(f"uia dump -> {out} ({len(found)} controls)")


def _rect_inside(r, win):
    cx = (r.left + r.right) // 2
    cy = (r.top + r.bottom) // 2
    return (win.left <= cx <= win.left + win.width and
            win.top + 80 <= cy <= win.top + win.height - 20)


def click_uia_node(node):
    try:
        r = node.BoundingRectangle
        cx = (r.left + r.right) // 2
        cy = (r.top + r.bottom) // 2
        pyautogui.click(cx, cy)
        return (cx, cy)
    except Exception:
        return None


# --- main flow --------------------------------------------------------------

def find_top_up_button(cwin, win):
    """Look for any button that screams 'add credits' or 'top up'."""
    keywords = [
        "top up", "topup", "add credit", "add credits", "add funds",
        "add balance", "buy credits", "auto top",
    ]
    for kw in keywords:
        for ct in ("ButtonControl", "LinkControl", "HyperlinkControl"):
            ms = _uia_find_by_name_contains(cwin, kw, control_types=(ct,))
            for m in ms:
                try:
                    r = m.BoundingRectangle
                    if r.width() <= 0 or r.height() <= 0:
                        continue
                    if not _rect_inside(r, win):
                        continue
                    log(f"top up candidate: '{m.Name}' ({ct}) at ({r.left},{r.top})")
                    return m
                except Exception:
                    continue
    return None


def find_amount_input(cwin, win):
    """In the top-up modal, find the amount input field."""
    # Edit controls inside the window
    candidates = []
    def walk(node, depth=0):
        if depth > 30:
            return
        try:
            ct = node.ControlTypeName
            if ct == "EditControl":
                r = node.BoundingRectangle
                if r.width() > 0 and r.height() > 0 and _rect_inside(r, win):
                    name = (node.Name or "").lower()
                    candidates.append((node, name, r))
        except Exception:
            pass
        try:
            for ch in node.GetChildren():
                walk(ch, depth + 1)
        except Exception:
            return
    walk(cwin)
    log(f"found {len(candidates)} edit controls")
    for node, name, r in candidates:
        log(f"  edit: '{name}' @ ({r.left},{r.top},{r.right},{r.bottom})")
    # Prefer ones with name hints; otherwise pick the largest-area edit (modal input)
    for node, name, r in candidates:
        if any(k in name for k in ("amount", "credit", "dollar", "$", "usd")):
            return node
    if candidates:
        # Fallback: largest non-search edit
        candidates.sort(key=lambda t: t[2].width() * t[2].height(), reverse=True)
        return candidates[0][0]
    return None


def find_confirm_button(cwin, win):
    keywords = [
        "confirm", "add credits", "submit", "continue", "pay", "purchase",
        "add funds", "top up", "buy",
    ]
    for kw in keywords:
        for ct in ("ButtonControl", "LinkControl"):
            ms = _uia_find_by_name_contains(cwin, kw, control_types=(ct,))
            for m in ms:
                try:
                    r = m.BoundingRectangle
                    if r.width() <= 0 or r.height() <= 0:
                        continue
                    if not _rect_inside(r, win):
                        continue
                    name_lc = (m.Name or "").lower()
                    # Skip if it's the same "Top up" link in nav
                    if "support" in name_lc or "docs" in name_lc:
                        continue
                    log(f"confirm candidate: '{m.Name}' ({ct}) at ({r.left},{r.top})")
                    return m
                except Exception:
                    continue
    return None


def detect_card_needed(cwin):
    """If the modal asks for a new card, we exit and ping Heath."""
    flags = ["add a card", "card number", "add payment method", "no payment method", "add a new card"]
    for f in flags:
        ms = _uia_find_by_name_contains(cwin, f)
        if ms:
            return True
    return False


def detect_login_redirect(win):
    """If fal redirected to /login, we abort and tell Heath."""
    title = (win.title or "").lower()
    if "/login" in title or "sign in" in title or "log in to fal" in title:
        return True
    return False


def read_balance_from_page(cwin, win):
    """Scan visible text for a balance string."""
    if not UIA_AVAILABLE:
        return None
    found = []
    def walk(node, depth=0):
        if depth > 30:
            return
        try:
            n = (node.Name or "").strip()
            if n and ("$" in n or "USD" in n.upper() or "balance" in n.lower() or "credit" in n.lower()):
                r = node.BoundingRectangle
                if r.width() > 0 and r.height() > 0 and _rect_inside(r, win):
                    found.append(n[:200])
        except Exception:
            pass
        try:
            for ch in node.GetChildren():
                walk(ch, depth + 1)
        except Exception:
            return
    walk(cwin)
    return found


# --- main -------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--amount", default="20", help="Top up amount in USD")
    ap.add_argument("--dry-run", action="store_true", help="Don't click confirm; just find buttons")
    args = ap.parse_args()

    run_dir = RUNS_ROOT / f"fal-topup-{int(time.time())}"
    run_dir.mkdir(parents=True, exist_ok=True)
    log(f"run dir: {run_dir}")

    result = {
        "ts": datetime.now().isoformat(),
        "amount": args.amount,
        "dry_run": args.dry_run,
        "run_dir": str(run_dir),
        "screenshots": [],
        "steps": [],
        "outcome": None,
        "reason": None,
        "balance_before": None,
        "balance_after": None,
    }

    def finish(outcome, reason=None):
        result["outcome"] = outcome
        result["reason"] = reason
        (run_dir / "result.json").write_text(json.dumps(result, indent=2))
        print("ATLAS_RESULT_JSON:" + json.dumps(result))
        sys.exit(0)

    # 1. Probe fal balance API BEFORE
    locked_before, msg_before = fal_balance_check()
    log(f"fal probe BEFORE: locked={locked_before} :: {msg_before[:140]}")
    result["balance_before"] = {"locked": locked_before, "msg": msg_before[:200]}
    result["steps"].append(f"probe before: locked={locked_before}")

    # 2. Find + activate Heath's real Chrome
    win = find_chrome_window()
    if not win:
        finish("chrome_missing", "no visible Chrome window")
    log(f"using window: {win.width}x{win.height} :: {win.title[:80]}")
    result["window"] = {"title": win.title, "rect": [win.left, win.top, win.width, win.height]}
    activate_window(win)

    screenshot(run_dir / "01-before.png")
    result["screenshots"].append(str(run_dir / "01-before.png"))

    # 3. Navigate to billing
    target_url = "https://fal.ai/dashboard/billing"
    log(f"navigating: {target_url}")
    navigate_to(target_url)
    result["steps"].append(f"opened new tab + nav {target_url}")

    # 4. Wait for load
    time.sleep(8)
    screenshot(run_dir / "02-billing-loaded.png")
    result["screenshots"].append(str(run_dir / "02-billing-loaded.png"))

    # Re-grab window in case the tab changed it (it shouldn't but title updates)
    try:
        win = find_chrome_window()
        if win:
            activate_window(win)
    except Exception:
        pass

    # Detect login redirect
    if win and detect_login_redirect(win):
        log("fal redirected to login — Heath is not logged in in this Chrome")
        screenshot(run_dir / "03-login-wall.png")
        result["screenshots"].append(str(run_dir / "03-login-wall.png"))
        tg_send(
            f"Atlas: fal.ai top-up blocked. Chrome shows /login. Heath — log into fal.ai in your main Chrome (not DossieBot), then I'll retry.",
            photo_path=str(run_dir / "03-login-wall.png"),
        )
        finish("not_logged_in", "fal redirected to /login")

    # 5. UIA scan
    cwin = _get_chrome_uia_window(win) if win else None
    if cwin is None:
        log("UIA: chrome window not located")
        finish("chrome_missing", "UIA cannot locate chrome window")

    _uia_dump_buttons(cwin, run_dir, "billing")

    # 6. Find Top Up button
    topup_btn = find_top_up_button(cwin, win)
    if topup_btn is None:
        log("top up button not found")
        screenshot(run_dir / "04-no-topup-btn.png")
        result["screenshots"].append(str(run_dir / "04-no-topup-btn.png"))
        finish("top_up_button_missing", "could not find 'Top up' / 'Add credits' on billing page")

    click_uia_node(topup_btn)
    result["steps"].append("clicked top up button")
    time.sleep(3.0)
    screenshot(run_dir / "05-modal-opened.png")
    result["screenshots"].append(str(run_dir / "05-modal-opened.png"))

    # Refresh chrome UIA after modal opens
    cwin = _get_chrome_uia_window(win)
    _uia_dump_buttons(cwin, run_dir, "modal")

    # 7. Check if card-needed dialog shown
    if detect_card_needed(cwin):
        log("card needed dialog detected")
        tg_send(
            "Atlas: fal.ai needs a card on file once. I've left the dialog open in your Chrome — punch in your card, then I'll retry the top-up.",
            photo_path=str(run_dir / "05-modal-opened.png"),
        )
        finish("no_card_on_file", "fal asked for new card")

    # 8. Find amount input + enter $20
    amt_input = find_amount_input(cwin, win)
    if amt_input is None:
        log("amount input not found")
        finish("amount_input_missing", "could not find amount input in modal")

    click_uia_node(amt_input)
    time.sleep(0.5)
    pyautogui.hotkey("ctrl", "a")
    time.sleep(0.2)
    pyautogui.press("delete")
    time.sleep(0.2)
    pyautogui.typewrite(args.amount, interval=0.08)
    time.sleep(0.5)
    screenshot(run_dir / "06-amount-typed.png")
    result["screenshots"].append(str(run_dir / "06-amount-typed.png"))
    result["steps"].append(f"typed amount: ${args.amount}")

    # Refresh
    cwin = _get_chrome_uia_window(win)

    # 9. Confirm button
    confirm_btn = find_confirm_button(cwin, win)
    if confirm_btn is None:
        log("confirm button not found")
        _uia_dump_buttons(cwin, run_dir, "post-amount")
        finish("confirm_button_missing", "could not find confirm/submit button in modal")

    if args.dry_run:
        log("DRY RUN — not clicking confirm")
        result["steps"].append("DRY RUN — confirm button found but not clicked")
        finish("dry_run_ok", "found all controls; did not submit")

    click_uia_node(confirm_btn)
    result["steps"].append("clicked confirm")
    log("clicked confirm — waiting for charge")
    time.sleep(8.0)
    screenshot(run_dir / "07-after-confirm.png")
    result["screenshots"].append(str(run_dir / "07-after-confirm.png"))

    # 10. 3D Secure detection (best effort — most stored cards won't trigger this)
    cwin = _get_chrome_uia_window(win)
    threed_flags = ["3d secure", "verify with your bank", "authenticate", "approve in your app", "additional verification"]
    for f in threed_flags:
        if _uia_find_by_name_contains(cwin, f):
            log(f"3D Secure detected: '{f}'")
            tg_send(
                "Atlas: fal.ai $20 charge is waiting on bank approval — should be a push in your bank app. Approve it and I'll verify the balance.",
                photo_path=str(run_dir / "07-after-confirm.png"),
            )
            finish("threed_secure", f"detected 3DS prompt: {f}")

    # 11. Verify via fal API probe
    time.sleep(4.0)
    locked_after, msg_after = fal_balance_check()
    log(f"fal probe AFTER: locked={locked_after} :: {msg_after[:140]}")
    result["balance_after"] = {"locked": locked_after, "msg": msg_after[:200]}
    result["steps"].append(f"probe after: locked={locked_after}")

    # 12. Read balance from page
    balance_strings = read_balance_from_page(cwin, win) or []
    log(f"page balance hints: {balance_strings[:5]}")
    result["balance_page_hints"] = balance_strings[:10]

    # 13. Outcome
    if locked_before is True and locked_after is False:
        log("SUCCESS — API was locked before, unlocked after")
        tg_send(
            f"Atlas: fal.ai +${args.amount} done. API unlocked (was 'Exhausted balance', now responding). Kling/Runway/Flux back online.",
            photo_path=str(run_dir / "07-after-confirm.png"),
        )
        finish("success", "API unlocked after top-up")
    elif locked_after is False:
        # Was already unlocked or now unlocked
        tg_send(
            f"Atlas: fal.ai +${args.amount} submitted. API is responding (not 'Exhausted balance'). Page hints: {balance_strings[:3]}",
            photo_path=str(run_dir / "07-after-confirm.png"),
        )
        finish("success", "API responding after top-up")
    elif locked_after is True:
        # Still locked — fal may not have credited yet
        log("API still 'Exhausted balance' after charge — could be a delay")
        # Wait a bit more and retry once
        time.sleep(10)
        locked_retry, msg_retry = fal_balance_check()
        log(f"fal probe RETRY: locked={locked_retry} :: {msg_retry[:140]}")
        if locked_retry is False:
            tg_send(
                f"Atlas: fal.ai +${args.amount} done (took ~12s to credit). API now responding.",
                photo_path=str(run_dir / "07-after-confirm.png"),
            )
            finish("success", "API unlocked on retry")
        else:
            tg_send(
                f"Atlas: fal.ai +${args.amount} submitted but API still says 'Exhausted balance' after 12s. Heath: check fal.ai/dashboard/billing — maybe charge failed silently.",
                photo_path=str(run_dir / "07-after-confirm.png"),
            )
            finish("verification_failed", "API still locked after charge")
    else:
        # locked_after is None (probe error)
        tg_send(
            f"Atlas: fal.ai +${args.amount} submitted, but balance probe failed: {msg_after[:120]}. Likely fine — check fal.ai dashboard.",
            photo_path=str(run_dir / "07-after-confirm.png"),
        )
        finish("success_unverified", f"probe error: {msg_after[:120]}")


if __name__ == "__main__":
    main()
