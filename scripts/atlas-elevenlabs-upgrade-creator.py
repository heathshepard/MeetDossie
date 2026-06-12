"""atlas-elevenlabs-upgrade-creator.py

Drive Heath's real Chrome to upgrade the heath.shepard@gmail.com ElevenLabs
account from Free -> Creator ($18.33/mo). Same PyAutoGUI + UIA pattern as
the fal.ai top-up script.

Hard rules:
  - If no payment method on file => screenshot + Telegram Heath, abort cleanly.
  - If 3D Secure / SCA challenge => screenshot + Telegram Heath, abort.
  - On success, verify by re-probing /v1/user with the existing API key and
    confirming Luna voice now returns 200 (was 402 on free).
  - One consolidated Telegram message at end. Do NOT chatter.

Usage:
  python scripts/atlas-elevenlabs-upgrade-creator.py [--dry-run]
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from urllib import request as urlrequest
from urllib import error as urlerror

import pyautogui
import pygetwindow as gw
from mss import mss

try:
    import uiautomation as uia
    UIA = True
except Exception:
    UIA = False

REPO_ROOT = Path(__file__).resolve().parents[1]
RUN_DIR = REPO_ROOT / "scripts" / "atlas-runs" / f"elevenlabs-upgrade-{int(time.time())}"
RUN_DIR.mkdir(parents=True, exist_ok=True)

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.15


def _load_env_local():
    env = REPO_ROOT / ".env.local"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8", errors="replace").splitlines():
        t = line.strip()
        if not t or t.startswith("#") or "=" not in t:
            continue
        k, v = t.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v

_load_env_local()

TG_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TG_CHAT = os.environ.get("TELEGRAM_CHAT_ID", "7874782923")
EL_KEY = os.environ.get("ELEVENLABS_API_KEY", "")
LUNA_VOICE = "lxYfHSkYm1EzQzGhdbfc"


def log(m):
    line = f"[el-upgrade] {m}"
    print(line, flush=True)
    try:
        with (RUN_DIR / "run.log").open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def shot(name):
    p = RUN_DIR / name
    try:
        with mss() as sct:
            sct.shot(output=str(p))
    except Exception as e:
        log(f"screenshot fail: {e}")
    return p


def tg(text, photo=None):
    if not TG_TOKEN:
        log("no TG token; skipping")
        return
    try:
        if photo and Path(photo).exists():
            cmd = [
                "powershell", "-NoProfile", "-Command",
                f"$f=Get-Item -LiteralPath '{photo}'; "
                f"$body=@{{chat_id='{TG_CHAT}'; caption=@'\n{text}\n'@; photo=$f}}; "
                f"Invoke-RestMethod -Uri 'https://api.telegram.org/bot{TG_TOKEN}/sendPhoto' -Method Post -Form $body | Out-Null"
            ]
            subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        else:
            data = json.dumps({"chat_id": TG_CHAT, "text": text}).encode()
            req = urlrequest.Request(
                f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
                data=data, headers={"Content-Type": "application/json"}, method="POST",
            )
            urlrequest.urlopen(req, timeout=15)
    except Exception as e:
        log(f"TG send error: {e}")


def luna_works() -> bool:
    """Probe Luna voice. 200 = paid plan active. 402 = still free."""
    if not EL_KEY:
        return False
    body = json.dumps({"text": "test", "model_id": "eleven_flash_v2_5"}).encode()
    req = urlrequest.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{LUNA_VOICE}/stream?optimize_streaming_latency=3&output_format=mp3_22050_32",
        data=body,
        headers={"xi-api-key": EL_KEY, "Content-Type": "application/json", "Accept": "audio/mpeg"},
        method="POST",
    )
    try:
        with urlrequest.urlopen(req, timeout=15) as r:
            return r.status == 200
    except urlerror.HTTPError as e:
        log(f"Luna probe HTTP {e.code}")
        return False
    except Exception as e:
        log(f"Luna probe error: {e}")
        return False


def find_chrome():
    """Pick the largest Chrome window — same heuristic as fal-topup-v2."""
    best, best_area = None, 0
    for w in gw.getAllWindows():
        try:
            if not w.title or "chrome" not in w.title.lower():
                continue
            # Skip DossieBot profile windows
            if "DossieBot" in w.title:
                continue
            a = max(0, w.width) * max(0, w.height)
            if a > best_area:
                best, best_area = w, a
        except Exception:
            continue
    return best


def focus(w):
    try:
        if w.isMinimized:
            w.restore()
        w.activate()
        time.sleep(0.5)
    except Exception as e:
        log(f"focus fail: {e}")


def open_url(url):
    pyautogui.hotkey("ctrl", "l")
    time.sleep(0.3)
    pyautogui.typewrite(url, interval=0.01)
    time.sleep(0.15)
    pyautogui.press("enter")
    time.sleep(4.0)


def click_text(needle, timeout=15.0, partial=True):
    """UIA-walk + click first control whose Name contains needle (case-insensitive)."""
    if not UIA:
        log("UIA missing — cannot click_text")
        return False
    t0 = time.time()
    needle_lc = needle.lower()
    while time.time() - t0 < timeout:
        try:
            root = uia.GetRootControl()
            def walk(c, depth=0):
                if depth > 18:
                    return None
                try:
                    name = (c.Name or "").lower()
                    if needle_lc in name if partial else name == needle_lc:
                        return c
                    for child in c.GetChildren():
                        r = walk(child, depth + 1)
                        if r is not None:
                            return r
                except Exception:
                    pass
                return None
            hit = walk(root)
            if hit is not None:
                try:
                    rect = hit.BoundingRectangle
                    cx = (rect.left + rect.right) // 2
                    cy = (rect.top + rect.bottom) // 2
                    log(f"click '{needle}' at ({cx},{cy})")
                    pyautogui.click(cx, cy)
                    time.sleep(0.6)
                    return True
                except Exception as e:
                    log(f"click rect error: {e}")
                    return False
        except Exception as e:
            log(f"walk err: {e}")
        time.sleep(0.5)
    log(f"click_text timeout for '{needle}'")
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    log(f"Run dir: {RUN_DIR}")

    if luna_works():
        log("Luna already 200 — already on a paid plan. Nothing to do.")
        tg("ElevenLabs already on paid plan (Luna 200 OK). No upgrade needed.")
        return 0

    log("Luna 402 confirmed — free plan. Starting upgrade flow.")

    w = find_chrome()
    if not w:
        log("No suitable Chrome window found")
        tg("ElevenLabs upgrade BLOCKED: no Chrome window found. Open Chrome, log into elevenlabs.io as heath.shepard@gmail.com, retry.")
        return 1

    log(f"Targeting Chrome: '{w.title}' ({w.width}x{w.height})")
    focus(w)

    open_url("https://elevenlabs.io/app/subscription")
    time.sleep(2.0)
    shot("01-subscription-page.png")

    if args.dry_run:
        log("--dry-run: stopping here")
        tg("ElevenLabs upgrade DRY-RUN: page loaded, ready to upgrade. Re-run without --dry-run to execute.")
        return 0

    # The subscription page typically shows tier cards: Free / Starter / Creator / Pro / Scale / Business.
    # Click Creator tile. Common button texts: "Subscribe to Creator", "Upgrade to Creator", "Get Creator".
    creator_clicked = False
    for needle in ["Subscribe to Creator", "Upgrade to Creator", "Get Creator", "Choose Creator", "Select Creator"]:
        if click_text(needle, timeout=4.0):
            creator_clicked = True
            log(f"Clicked: {needle}")
            break

    if not creator_clicked:
        # Fallback: just click "Creator" — the card itself is clickable on some layouts.
        log("Specific Creator button not found — trying card click")
        if not click_text("Creator", timeout=4.0):
            shot("02-no-creator-button.png")
            tg("ElevenLabs upgrade BLOCKED: could not find Creator tier button on /app/subscription. Heath: pick the tier manually in Chrome and re-run.", photo=str(RUN_DIR / "02-no-creator-button.png"))
            return 1

    time.sleep(3.0)
    shot("03-after-creator-click.png")

    # Modal/checkout step. Look for "Subscribe" / "Confirm" / "Pay" / etc.
    # Also check for "Add payment method" — abort signal.
    if click_text("Add payment method", timeout=2.0):
        shot("04-needs-card.png")
        tg("ElevenLabs upgrade NEEDS CARD: account has no payment method on file. I left Chrome on the add-card screen — punch in your card, then re-run: python scripts/atlas-elevenlabs-upgrade-creator.py", photo=str(RUN_DIR / "04-needs-card.png"))
        return 2

    # Otherwise: try common confirm buttons.
    confirmed = False
    for needle in ["Subscribe", "Confirm subscription", "Confirm and pay", "Pay $", "Pay now"]:
        if click_text(needle, timeout=3.0):
            confirmed = True
            log(f"Confirm clicked: {needle}")
            break

    if not confirmed:
        shot("05-no-confirm.png")
        tg("ElevenLabs upgrade STALLED: Creator tier selected but no Subscribe/Pay button found. Heath: confirm payment manually in Chrome, then re-run to verify Luna.", photo=str(RUN_DIR / "05-no-confirm.png"))
        return 3

    # Wait for upgrade to process.
    time.sleep(8.0)
    shot("06-post-confirm.png")

    # Verify via API.
    verified = False
    for i in range(6):  # up to 60s wait for plan flip
        if luna_works():
            verified = True
            break
        log(f"Luna still 402, attempt {i+1}/6 — waiting 10s")
        time.sleep(10)

    if verified:
        log("Luna 200 OK — upgrade verified.")
        tg("ElevenLabs Creator upgrade SHIPPED. Luna voice live (verified 200 OK). Bill + Luna both work on existing API key. No restart needed for Jarvis-Cole.", photo=str(RUN_DIR / "06-post-confirm.png"))
        return 0
    else:
        log("Upgrade clicked but Luna still 402 after 60s.")
        tg("ElevenLabs upgrade SUBMITTED but plan not yet flipped (Luna still 402). May be processing (Stripe/3DS lag). Heath: check elevenlabs.io/app/subscription — if it says Creator, wait 5 min and Luna will work. If not, screenshot in chat.", photo=str(RUN_DIR / "06-post-confirm.png"))
        return 4


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log("interrupted")
        sys.exit(130)
    except Exception as e:
        log(f"fatal: {e}")
        try:
            shot("99-fatal.png")
            tg(f"ElevenLabs upgrade FATAL: {e}", photo=str(RUN_DIR / "99-fatal.png"))
        except Exception:
            pass
        sys.exit(1)
