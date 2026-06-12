"""atlas-fal-topup-v2.py

Now we know the UI flow:
  - URL: https://fal.ai/dashboard/usage-billing
  - Button: 'Manage credits' (purple) at top
  - Clicking opens a modal with amount input + payment method + confirm

This script:
  1. Find Heath's real Chrome.
  2. Activate, navigate to /dashboard/usage-billing.
  3. Click 'Manage credits'.
  4. UIA scan the modal — find amount input + confirm.
  5. Type $20, click confirm.
  6. Verify via fal API probe.
  7. ONE Telegram on success.

Hard rules:
  - If 'Add card' shows up in the modal flow with no existing card, ping Heath
    and abort.
  - If 3D Secure (authentication step), ping Heath and abort.
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


def log(m): print(f"[fal-topup-v2] {m}", flush=True)


def screenshot(p):
    with mss() as sct:
        sct.shot(output=str(p))


def set_clipboard(text):
    proc = subprocess.run(
        ["powershell", "-NoProfile", "-Command", "$input | Set-Clipboard"],
        input=text, text=True, encoding="utf-8", capture_output=True,
    )
    return proc.returncode == 0


def tg_send(text, photo_path=None):
    if not TG_TOKEN:
        log("no TG token; skipping ping")
        return
    try:
        if photo_path and Path(photo_path).exists():
            cmd = [
                "powershell", "-NoProfile", "-Command",
                f"$ErrorActionPreference='Stop'; "
                f"$form=@{{chat_id='{TG_CHAT}'; caption=@'\n{text}\n'@; photo=Get-Item -LiteralPath '{photo_path}'}}; "
                f"Invoke-WebRequest -Uri 'https://api.telegram.org/bot{TG_TOKEN}/sendPhoto' -Method POST -Form $form | Out-Null"
            ]
            subprocess.run(cmd, capture_output=True, timeout=20)
            log("tg photo sent")
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
    """Returns (locked, message). locked=True if 'Exhausted balance'."""
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
        if "Exhausted balance" in body:
            return (True, f"HTTP {e.code}: {body[:200]}")
        if e.code in (401, 402, 403):
            return (True, f"HTTP {e.code}: {body[:200]}")
        return (False, f"HTTP {e.code}: {body[:200]}")
    except Exception as e:
        return (None, f"probe error: {e}")


def find_chrome():
    cands = [w for w in gw.getAllWindows()
             if w.title and "Google Chrome" in w.title and w.visible and not w.isMinimized]
    if not cands:
        return None
    return max(cands, key=lambda w: w.width * w.height)


def activate(win):
    try:
        if win.isMinimized: win.restore()
        u = ctypes.windll.user32
        u.keybd_event(0x12, 0, 0, 0); u.keybd_event(0x12, 0, 2, 0)
        time.sleep(0.05)
        try: win.activate()
        except Exception: pass
        hwnd = win._hWnd
        u.ShowWindow(hwnd, 9); u.SetForegroundWindow(hwnd)
        u.BringWindowToTop(hwnd); u.SetActiveWindow(hwnd)
        time.sleep(0.6)
    except Exception as e:
        log(f"activate warn: {e}")


def get_uia_chrome(win):
    if not UIA_AVAILABLE: return None
    for c in uia.GetRootControl().GetChildren():
        try:
            if c.ClassName != "Chrome_WidgetWin_1": continue
            r = c.BoundingRectangle
            if abs(r.left - win.left) <= 8 and abs(r.top - win.top) <= 8:
                return c
        except Exception:
            continue
    chromes = [c for c in uia.GetRootControl().GetChildren()
               if c.ClassName == "Chrome_WidgetWin_1"]
    if chromes:
        return max(chromes, key=lambda c: (c.BoundingRectangle.width() * c.BoundingRectangle.height()))
    return None


def find_by_name(root, name, ct=None, max_depth=35):
    out = []
    def walk(n, d=0):
        if d > max_depth: return
        try:
            nm = (n.Name or "").strip()
            if nm == name and (ct is None or n.ControlTypeName == ct):
                out.append(n)
        except Exception: pass
        try:
            for ch in n.GetChildren(): walk(ch, d+1)
        except Exception: return
    walk(root)
    return out


def find_by_name_contains_lower(root, sub_lower, ct=None, max_depth=35):
    out = []
    def walk(n, d=0):
        if d > max_depth: return
        try:
            nm = (n.Name or "").lower()
            if sub_lower in nm and (ct is None or n.ControlTypeName == ct):
                out.append(n)
        except Exception: pass
        try:
            for ch in n.GetChildren(): walk(ch, d+1)
        except Exception: return
    walk(root)
    return out


def click_node(node):
    r = node.BoundingRectangle
    cx, cy = (r.left + r.right) // 2, (r.top + r.bottom) // 2
    pyautogui.click(cx, cy)
    return (cx, cy)


def dump_uia(cwin, run_dir, label):
    found = []
    def walk(n, d=0):
        if d > 30: return
        try:
            ct = n.ControlTypeName
            nm = (n.Name or "").strip()
            if nm and ct in ("ButtonControl", "LinkControl", "EditControl", "HyperlinkControl"):
                r = n.BoundingRectangle
                if r.width() > 0 and r.height() > 0:
                    found.append(f"{ct} :: {nm[:120]} @ ({r.left},{r.top},{r.right},{r.bottom})")
        except Exception: pass
        try:
            for ch in n.GetChildren(): walk(ch, d+1)
        except Exception: return
    walk(cwin)
    (run_dir / f"uia-{label}.txt").write_text("\n".join(found), encoding="utf-8")
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--amount", default="20")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    run_dir = RUNS_ROOT / f"fal-topup-v2-{int(time.time())}"
    run_dir.mkdir(parents=True, exist_ok=True)
    log(f"run dir: {run_dir}")

    result = {
        "ts": datetime.now().isoformat(),
        "amount": args.amount,
        "dry_run": args.dry_run,
        "run_dir": str(run_dir),
        "outcome": None,
        "reason": None,
        "steps": [],
    }

    def finish(outcome, reason=None):
        result["outcome"] = outcome
        result["reason"] = reason
        (run_dir / "result.json").write_text(json.dumps(result, indent=2))
        print("ATLAS_RESULT_JSON:" + json.dumps(result))
        sys.exit(0)

    # 1. Balance probe BEFORE
    locked_before, msg_before = fal_balance_check()
    log(f"BEFORE: locked={locked_before} :: {msg_before[:140]}")
    result["balance_before"] = {"locked": locked_before, "msg": msg_before[:200]}

    # 2. Chrome
    win = find_chrome()
    if not win:
        finish("chrome_missing", "no Chrome window")
    log(f"chrome: {win.width}x{win.height} :: {win.title[:80]}")
    activate(win)

    # 3. Navigate to /dashboard/usage-billing (we found 'Manage credits' there)
    log("navigating to /dashboard/usage-billing")
    pyautogui.hotkey("ctrl", "l"); time.sleep(0.3)
    set_clipboard("https://fal.ai/dashboard/usage-billing")
    time.sleep(0.2)
    pyautogui.hotkey("ctrl", "v"); time.sleep(0.2)
    pyautogui.press("enter")
    time.sleep(7.0)

    win = find_chrome()
    activate(win)
    screenshot(run_dir / "01-usage-billing.png")
    result["steps"].append("loaded /dashboard/usage-billing")

    # 4. Click "Manage credits"
    cwin = get_uia_chrome(win)
    if cwin is None:
        finish("chrome_missing", "no UIA chrome")
    dump_uia(cwin, run_dir, "01-billing-page")

    # Prefer the BUTTON 'Manage credits' (the link version goes to same place but the button is the action)
    btns = find_by_name(cwin, "Manage credits", "ButtonControl")
    if not btns:
        btns = find_by_name(cwin, "Manage credits", "HyperlinkControl")
    if not btns:
        finish("manage_credits_missing", "no 'Manage credits' control on page")
    log(f"clicking 'Manage credits' ({btns[0].ControlTypeName})")
    click_node(btns[0])
    result["steps"].append("clicked Manage credits")
    time.sleep(4.0)
    screenshot(run_dir / "02-after-manage-click.png")

    # 5. Modal opened — UIA-dump it
    win = find_chrome()
    cwin = get_uia_chrome(win)
    modal_dump = dump_uia(cwin, run_dir, "02-modal")
    log(f"modal: {len(modal_dump)} controls")

    # 6. Look for amount input. The modal usually has a numeric input.
    # Also: detect 'Add a card' / 'Add payment method' state
    no_card = (find_by_name_contains_lower(cwin, "add a card") or
               find_by_name_contains_lower(cwin, "add payment method") or
               find_by_name_contains_lower(cwin, "no payment method"))
    if no_card:
        log("no card on file — pinging Heath")
        tg_send(
            "Atlas: fal.ai $20 top-up — they want a card on file. I've left the dialog open in your Chrome. Punch in your card and I'll retry.",
            photo_path=str(run_dir / "02-after-manage-click.png"),
        )
        finish("no_card_on_file", "modal asked for new card")

    # 7. Find amount input
    edit_controls = []
    def walk_edits(n, d=0):
        if d > 30: return
        try:
            if n.ControlTypeName == "EditControl":
                r = n.BoundingRectangle
                if r.width() > 0 and r.height() > 0:
                    name = (n.Name or "").lower()
                    edit_controls.append((n, name, r))
        except Exception: pass
        try:
            for ch in n.GetChildren(): walk_edits(ch, d+1)
        except Exception: return
    walk_edits(cwin)
    log(f"found {len(edit_controls)} edit controls in modal context")
    for n, name, r in edit_controls:
        log(f"  EDIT '{name}' @ ({r.left},{r.top},{r.right},{r.bottom})")

    # Filter: avoid the URL bar (at top of window, y < 200) and search bars
    modal_edits = []
    for n, name, r in edit_controls:
        if r.top < 200:
            continue
        if "address and search" in name or "search models" in name:
            continue
        modal_edits.append((n, name, r))
    log(f"modal-only edits: {len(modal_edits)}")
    for n, name, r in modal_edits:
        log(f"  candidate '{name}' @ ({r.left},{r.top})")

    if not modal_edits:
        finish("amount_input_missing", "no edit control found in modal")

    # Prefer the one whose name suggests amount/credits/dollar/USD
    amt_node = None
    for n, name, r in modal_edits:
        if any(k in name for k in ("amount", "credit", "dollar", "usd", "$")):
            amt_node = n
            break
    if amt_node is None:
        # Pick the smallest edit (modal inputs are usually smaller than the URL bar)
        modal_edits.sort(key=lambda t: t[2].width() * t[2].height())
        amt_node = modal_edits[0][0]

    log(f"using amount input: '{amt_node.Name}'")
    click_node(amt_node)
    time.sleep(0.5)
    pyautogui.hotkey("ctrl", "a"); time.sleep(0.2)
    pyautogui.press("delete"); time.sleep(0.2)
    pyautogui.typewrite(args.amount, interval=0.08)
    time.sleep(0.5)
    screenshot(run_dir / "03-amount-typed.png")
    result["steps"].append(f"typed amount: ${args.amount}")

    # 8. Find confirm button. Re-dump modal post-typing.
    cwin = get_uia_chrome(find_chrome())
    post_amt_dump = dump_uia(cwin, run_dir, "03-post-amount")

    # Search for confirm-style button
    confirm_keywords = ["add credits", "add funds", "buy credits", "purchase", "confirm", "pay", "submit"]
    confirm_btn = None
    for kw in confirm_keywords:
        btns = find_by_name_contains_lower(cwin, kw, "ButtonControl")
        for b in btns:
            try:
                r = b.BoundingRectangle
                if r.width() <= 0 or r.height() <= 0:
                    continue
                nm = (b.Name or "").lower()
                # Skip nav buttons
                if "manage credits" in nm:
                    continue
                if r.top < 200:
                    continue
                log(f"confirm candidate: '{b.Name}' at ({r.left},{r.top})")
                confirm_btn = b
                break
            except Exception:
                continue
        if confirm_btn:
            break

    if confirm_btn is None:
        finish("confirm_button_missing", "no confirm button in modal")

    if args.dry_run:
        log("DRY RUN — found everything, not clicking confirm")
        finish("dry_run_ok", "found amount input + confirm button")

    log("clicking confirm")
    click_node(confirm_btn)
    result["steps"].append("clicked confirm")
    time.sleep(8.0)
    screenshot(run_dir / "04-after-confirm.png")

    # 9. 3D Secure detection
    cwin = get_uia_chrome(find_chrome())
    threed_hits = (find_by_name_contains_lower(cwin, "3d secure") +
                   find_by_name_contains_lower(cwin, "verify with your bank") +
                   find_by_name_contains_lower(cwin, "authenticate") +
                   find_by_name_contains_lower(cwin, "approve in your"))
    if threed_hits:
        log("3D Secure detected")
        tg_send(
            f"Atlas: fal.ai $${args.amount} waiting on bank approval. Should be a push in your bank app — approve and I'll verify the balance.",
            photo_path=str(run_dir / "04-after-confirm.png"),
        )
        finish("threed_secure", "bank auth required")

    # 10. Verify via API
    time.sleep(5.0)
    locked_after, msg_after = fal_balance_check()
    log(f"AFTER: locked={locked_after} :: {msg_after[:140]}")
    result["balance_after"] = {"locked": locked_after, "msg": msg_after[:200]}

    if locked_before is True and locked_after is False:
        # SUCCESS — was locked, now unlocked
        tg_send(
            f"fal.ai +${args.amount} - balance topped up. API unlocked (was 'Exhausted balance', now responding). Kling/Runway/Flux unlocked.",
            photo_path=str(run_dir / "04-after-confirm.png"),
        )
        finish("success", "API unlocked after top-up")
    elif locked_after is False:
        tg_send(
            f"fal.ai +${args.amount} - submitted, API responding. Kling/Runway/Flux unlocked.",
            photo_path=str(run_dir / "04-after-confirm.png"),
        )
        finish("success", "API responding after top-up")
    elif locked_after is True:
        # Retry once after delay
        time.sleep(12)
        lr, mr = fal_balance_check()
        log(f"RETRY: locked={lr} :: {mr[:140]}")
        if lr is False:
            tg_send(
                f"fal.ai +${args.amount} - balance topped up (took ~17s to credit). API now responding.",
                photo_path=str(run_dir / "04-after-confirm.png"),
            )
            finish("success", "API unlocked on retry")
        else:
            tg_send(
                f"Atlas: fal.ai +${args.amount} submitted but API still locked after 17s. Check fal.ai/dashboard/usage-billing — charge may have failed.",
                photo_path=str(run_dir / "04-after-confirm.png"),
            )
            finish("verification_failed", "API still locked after charge")
    else:
        tg_send(
            f"fal.ai +${args.amount} - submitted. Balance probe inconclusive; check fal dashboard.",
            photo_path=str(run_dir / "04-after-confirm.png"),
        )
        finish("success_unverified", f"probe error: {msg_after[:120]}")


if __name__ == "__main__":
    main()
