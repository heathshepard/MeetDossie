"""Quick recheck: dismiss Chrome sign-in modal, screenshot billing, see if
the page actually has a Top Up control vs only Add Card.

This is a one-shot diagnostic — it does NOT click anything destructive.
"""
import ctypes
import json
import os
import subprocess
import time
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
run_dir = RUNS_ROOT / f"fal-recheck-{int(time.time())}"
run_dir.mkdir(parents=True, exist_ok=True)

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.12


def log(m): print(f"[recheck] {m}", flush=True)


def screenshot(p):
    with mss() as sct:
        sct.shot(output=str(p))


def find_chrome():
    cands = [w for w in gw.getAllWindows() if w.title and "Google Chrome" in w.title and w.visible and not w.isMinimized]
    if not cands: return None
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
        u.ShowWindow(hwnd, 9); u.SetForegroundWindow(hwnd); u.BringWindowToTop(hwnd); u.SetActiveWindow(hwnd)
        time.sleep(0.6)
    except Exception as e:
        log(f"activate warn: {e}")


win = find_chrome()
if not win:
    log("no chrome"); raise SystemExit(1)
log(f"chrome: {win.width}x{win.height} :: {win.title[:80]}")
activate(win)

screenshot(run_dir / "01-current.png")

# Dismiss "Sign in to Chrome" popup by clicking the "Use Chrome without an account" button.
# From the uia dump, it was at (1320,641,1522,677). Window had moved, so use UIA again.
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


cwin = get_uia_chrome(win)
if cwin is None:
    log("no UIA chrome"); raise SystemExit(1)

# Click "Use Chrome without an account"
btns = find_by_name(cwin, "Use Chrome without an account", "ButtonControl")
if btns:
    r = btns[0].BoundingRectangle
    cx, cy = (r.left + r.right) // 2, (r.top + r.bottom) // 2
    log(f"clicking 'Use Chrome without an account' at ({cx},{cy})")
    pyautogui.click(cx, cy)
    time.sleep(2.0)
else:
    log("no 'Use Chrome' button found — popup may already be gone")

# Re-grab chrome
win = find_chrome()
activate(win)
time.sleep(1.5)
screenshot(run_dir / "02-after-dismiss.png")

# Also dismiss cookie popup (Accept All)
cwin = get_uia_chrome(win)
ck = find_by_name(cwin, "Accept All", "ButtonControl")
if ck:
    r = ck[0].BoundingRectangle
    cx, cy = (r.left + r.right) // 2, (r.top + r.bottom) // 2
    log(f"clicking 'Accept All' at ({cx},{cy})")
    pyautogui.click(cx, cy)
    time.sleep(2.0)

screenshot(run_dir / "03-after-cookies.png")

# Now navigate to the explicit USAGE/billing URL since the previous title was
# "Billing | fal.ai" but the page showed billing-info form (Customer Name etc).
# fal has TWO billing pages:
#   /dashboard/usage-billing/billing - customer info
#   /dashboard/usage-billing - usage + top up control (what we want)
log("trying /dashboard/usage-billing (usage + topup)")
pyautogui.hotkey("ctrl", "l"); time.sleep(0.3)
subprocess.run(["powershell", "-NoProfile", "-Command", "Set-Clipboard 'https://fal.ai/dashboard/usage-billing'"], capture_output=True)
time.sleep(0.2)
pyautogui.hotkey("ctrl", "v"); time.sleep(0.2)
pyautogui.press("enter")
time.sleep(7.0)

win = find_chrome()
activate(win)
screenshot(run_dir / "04-usage-billing.png")

# UIA dump on this page
cwin = get_uia_chrome(win)
if cwin:
    found = []
    def walk2(n, d=0):
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
            for ch in n.GetChildren(): walk2(ch, d+1)
        except Exception: return
    walk2(cwin)
    (run_dir / "uia-usage-billing.txt").write_text("\n".join(found), encoding="utf-8")
    log(f"uia dump -> {len(found)} controls")

log(f"DONE — artifacts in {run_dir}")
print(f"RUN_DIR:{run_dir}")
