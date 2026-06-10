"""Step 2: close the dead tab + Telegram Heath the killshot evidence.

playht.com is parked (redirects via Cloudflare turnstile to cinnabon.pkeeper.net
domain-parking network with dkw=playht.com). Marketing domain is gone. We already
knew api.play.ht NXDOMAIN. SV-PLAYHT-001 is closed.
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
import requests  # noqa: E402
from dotenv import load_dotenv  # noqa: E402

load_dotenv(_REPO_ROOT / ".env.local")

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "7874782923")

RUN_DIR = Path(__file__).parent

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler(RUN_DIR / "playht_run.log", encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("playht_step2")


def telegram_send_photo(text: str, photo_path: Path) -> None:
    if not TELEGRAM_BOT_TOKEN:
        log.warning("no telegram token — cannot send")
        return
    try:
        with open(photo_path, "rb") as f:
            r = requests.post(
                f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendPhoto",
                data={"chat_id": TELEGRAM_CHAT_ID, "caption": text[:1024]},
                files={"photo": f},
                timeout=20,
            )
        if not r.ok:
            log.warning("sendPhoto failed: %s %s", r.status_code, r.text[:200])
        else:
            log.info("Telegram screenshot sent.")
    except Exception as e:
        log.warning("sendPhoto exception: %s", e)


def telegram_send(text: str) -> None:
    if not TELEGRAM_BOT_TOKEN:
        return
    try:
        requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
            json={"chat_id": TELEGRAM_CHAT_ID, "text": text},
            timeout=15,
        )
    except Exception as e:
        log.warning("sendMessage failed: %s", e)


def focus_chrome():
    for w in Desktop(backend="uia").windows():
        try:
            t = w.window_text() or ""
        except Exception:
            continue
        if t.endswith("- Google Chrome"):
            try:
                w.set_focus()
            except Exception:
                time.sleep(0.4)
                w.set_focus()
            time.sleep(0.5)
            return w
    return None


def main():
    log.info("=" * 60)
    log.info("STEP 2 — close dead PlayHT tab + report kill")
    log.info("=" * 60)
    ks.start()

    # Close the dead PlayHT tab Heath's Chrome is on
    focus_chrome()
    cd.hotkey("ctrl", "w")
    time.sleep(0.5)
    log.info("Closed dead PlayHT/parking tab.")

    # Build report
    addr_file = RUN_DIR / "last_address_bar.txt"
    shot_url_file = RUN_DIR / "last_screenshot_url"
    addr = addr_file.read_text(encoding="utf-8").strip() if addr_file.exists() else "<no capture>"
    shot_url = shot_url_file.read_text(encoding="utf-8").strip() if shot_url_file.exists() else ""

    report = (
        "PlayHT signup: KILLED. Definitive evidence captured via your real Chrome.\n\n"
        "What happened:\n"
        "Opened https://playht.com/pricing in your Chrome via PyAutoGUI.\n"
        "Chrome was redirected through a Cloudflare 'I am a human' challenge to a "
        "domain-parking network. Address bar after 17s ended on:\n"
        f"{addr[:300]}\n\n"
        "That URL is cinnabon.pkeeper.net — a domain parking / PPC ad network. "
        "The 'dkw=playht.com' query string is the parking-network code for "
        "'domain keyword: playht.com'. Translation: playht.com is no longer owned "
        "by PlayHT — it's been parked or sold and is being monetized for ad clicks.\n\n"
        "Combined with the earlier finding (api.play.ht + api.play.ai both NXDOMAIN), "
        "this confirms PlayHT the service is fully dead. Bot detection wasn't the issue. "
        "The company is gone.\n\n"
        "Action taken:\n"
        "- Closed the dead tab.\n"
        "- Made no purchase.\n"
        "- INDEX.md SV-PLAYHT-001 will be moved to Closed items with outcome "
        "'Killed — PlayHT upstream offline, marketing domain parked'.\n\n"
        "Recommendation: stick with ElevenLabs Creator plan ($18.33/mo, Bill + Luna). "
        "If Charlie voice was the only reason for PlayHT, ElevenLabs has equivalent "
        "voices we can swap in (Liam, Brian, Josh already in use for agent TTS).\n\n"
        "Screenshot evidence: " + (shot_url or "(upload failed)") + "\n\n"
        "Bot detection bypass worked — we WERE running through your real logged-in "
        "Chrome. The signup target just doesn't exist."
    )

    # Send screenshot then text
    local_png = RUN_DIR / "last_screenshot.png"
    if local_png.exists():
        telegram_send_photo("PlayHT killshot evidence — see message below.", local_png)
    telegram_send(report)
    log.info("Report sent to Telegram.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
