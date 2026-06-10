"""PlayHT Pro signup runner — drives Heath's real Chrome via PyAutoGUI.

PERMANENT RULE: never spawn a fresh Playwright Chromium. Always use Heath's
actual logged-in Chrome window. Bot detection is the whole reason desktop
control exists. See feedback_pyautogui_not_playwright.md.

Flow:
  1. Find Heath's Chrome top-level window, focus it.
  2. Ctrl+T new tab, navigate to https://playht.com/pricing
  3. Screenshot — verify page actually loads (PlayHT may be dead upstream).
  4. Find + click the Pro plan signup button.
  5. Prefer Google SSO if visible (uses Heath's existing session).
  6. At Stripe ($50/mo) — PAUSE, Telegram confirm gate (Claudy), default DENY.
  7. Navigate /app/api-access, screenshot User ID + API Secret, write env.
  8. Final Telegram via Claudy.

Stripe gate is the only Heath ping. Everything else runs end-to-end.
"""

from __future__ import annotations

import os
import sys
import time
import secrets
import string
import logging
import json
from pathlib import Path
from typing import Optional

# Add desktop-control dir to path so we can import cole_desktop + guards + kill_switch
_REPO_ROOT = Path("C:/Users/Heath Shepard/Desktop/MeetDossie")
sys.path.insert(0, str(_REPO_ROOT / "scripts" / "desktop-control"))

import cole_desktop as cd  # noqa: E402
import guards as g  # noqa: E402
import kill_switch as ks  # noqa: E402

from pywinauto import Desktop, Application  # noqa: E402
import pyautogui  # noqa: E402
import requests  # noqa: E402
from dotenv import load_dotenv  # noqa: E402

load_dotenv(_REPO_ROOT / ".env.local")

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "7874782923")
ENV_LOCAL_PATH = _REPO_ROOT / ".env.local"

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
log = logging.getLogger("playht_signup")


# -------------------------------------------------------------------- helpers


def telegram_send(text: str, photo_path: Optional[str] = None) -> None:
    """Send a Telegram message via Claudy (TELEGRAM_BOT_TOKEN)."""
    if not TELEGRAM_BOT_TOKEN:
        log.warning("TELEGRAM_BOT_TOKEN not set — cannot send: %s", text)
        return
    try:
        if photo_path and Path(photo_path).exists():
            with open(photo_path, "rb") as f:
                resp = requests.post(
                    f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendPhoto",
                    data={"chat_id": TELEGRAM_CHAT_ID, "caption": text[:1024]},
                    files={"photo": f},
                    timeout=20,
                )
        else:
            resp = requests.post(
                f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
                json={"chat_id": TELEGRAM_CHAT_ID, "text": text},
                timeout=15,
            )
        if not resp.ok:
            log.warning("telegram_send failed: %s %s", resp.status_code, resp.text[:200])
    except Exception as e:
        log.warning("telegram_send exception: %s", e)


def focus_chrome():
    """Find Heath's Chrome top-level window and focus it. Returns the window."""
    ks.ensure_unlocked()
    log.info("Locating Chrome window via pywinauto …")
    chrome_window = None
    chrome_pid = None
    for w in Desktop(backend="uia").windows():
        try:
            title = w.window_text() or ""
        except Exception:
            continue
        if title.endswith("- Google Chrome"):
            chrome_window = w
            chrome_pid = w.process_id()
            log.info("  found: %r (pid=%s)", title, chrome_pid)
            break
    if chrome_window is None:
        raise RuntimeError("No Chrome window found. Heath needs to open Chrome first.")
    # set_focus brings to foreground
    try:
        chrome_window.set_focus()
    except Exception as e:
        log.warning("set_focus first try failed (%s) — retrying …", e)
        time.sleep(0.5)
        chrome_window.set_focus()
    time.sleep(0.6)
    cd.log_action(action_type="focus_chrome", target=str(chrome_pid), result="success")
    return chrome_window


def address_bar_navigate(url: str) -> None:
    """Open a new tab and navigate to the URL."""
    ks.ensure_unlocked()
    # New tab
    cd.hotkey("ctrl", "t")
    time.sleep(0.7)
    # Focus address bar
    cd.hotkey("ctrl", "l")
    time.sleep(0.3)
    cd.type_text(url, interval=0.01)
    time.sleep(0.2)
    cd.press_key("enter")
    log.info("Navigated to %s", url)


def gen_password(length: int = 16) -> str:
    alphabet = string.ascii_letters + string.digits + "!@#$%^&*"
    while True:
        pw = "".join(secrets.choice(alphabet) for _ in range(length))
        if (
            any(c.islower() for c in pw)
            and any(c.isupper() for c in pw)
            and any(c.isdigit() for c in pw)
            and any(c in "!@#$%^&*" for c in pw)
        ):
            return pw


def write_env_var(key: str, value: str) -> None:
    """Upsert KEY=VALUE in .env.local (preserves rest of file)."""
    path = ENV_LOCAL_PATH
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    found = False
    new_lines = []
    for line in lines:
        if line.startswith(f"{key}="):
            new_lines.append(f'{key}="{value}"')
            found = True
        else:
            new_lines.append(line)
    if not found:
        new_lines.append(f'{key}="{value}"')
    path.write_text("\n".join(new_lines) + "\n", encoding="utf-8")
    log.info(".env.local updated: %s=<%d chars>", key, len(value))


def wait_for_telegram_reply(prompt_text: str, timeout: int = 90) -> str:
    """Send a prompt, then poll Telegram getUpdates for the user's next text reply.
    Returns the lowercased text (stripped). Empty string on timeout."""
    if not TELEGRAM_BOT_TOKEN:
        log.warning("No telegram bot token — cannot poll for reply, default DENY")
        return ""
    # Drain existing updates so we don't pick up stale messages
    last_id = 0
    try:
        r = requests.get(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/getUpdates",
            params={"timeout": 0},
            timeout=10,
        )
        if r.ok:
            for upd in r.json().get("result", []):
                last_id = max(last_id, upd.get("update_id", 0))
    except Exception as e:
        log.warning("drain getUpdates failed: %s", e)
    # Send prompt
    telegram_send(prompt_text)
    # Poll
    started = time.time()
    while time.time() - started < timeout:
        try:
            r = requests.get(
                f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/getUpdates",
                params={"offset": last_id + 1, "timeout": 5},
                timeout=15,
            )
            if r.ok:
                for upd in r.json().get("result", []):
                    last_id = max(last_id, upd.get("update_id", 0))
                    msg = upd.get("message") or {}
                    chat = msg.get("chat") or {}
                    if str(chat.get("id")) != str(TELEGRAM_CHAT_ID):
                        continue
                    text = (msg.get("text") or "").strip()
                    if not text:
                        continue
                    log.info("Telegram reply: %r", text)
                    return text.lower()
        except Exception as e:
            log.warning("poll exception: %s", e)
        time.sleep(2)
    log.info("Telegram reply timeout (%ds)", timeout)
    return ""


# -------------------------------------------------------------------- steps


def step_focus_and_open_pricing() -> str:
    focus_chrome()
    address_bar_navigate("https://playht.com/pricing")
    log.info("Waiting 6s for page render …")
    time.sleep(6.0)
    url = cd.screenshot("playht-pricing-loaded")
    log.info("Screenshot: %s", url)
    return url


def detect_dead_upstream(screenshot_url: str) -> bool:
    """If page didn't load (DNS NXDOMAIN, Cloudflare timeout, etc.), the address-
    bar URL will still show but content area will be Chrome error. We can't OCR
    in Phase 1, so we use a behavioural cue: take 2 screenshots 3s apart and let
    a human (us, via the upload URL) eyeball.

    For autonomous decisioning we rely on the second screenshot's pre-Stripe
    check anyway. Here we just flag the URL to Heath as a sanity-check thumbnail.
    Return True if we should bail."""
    # Heuristic: try to focus address bar + read clipboard via Ctrl+A Ctrl+C
    cd.hotkey("ctrl", "l")
    time.sleep(0.3)
    cd.hotkey("ctrl", "a")
    time.sleep(0.2)
    cd.hotkey("ctrl", "c")
    time.sleep(0.3)
    try:
        import pyperclip
        addr = pyperclip.paste()
    except Exception:
        addr = ""
    log.info("Current address bar URL: %r", addr)
    # Click back into page so subsequent typing doesn't hit address bar
    cd.press_key("escape")
    time.sleep(0.2)
    # Chrome shows e.g. "data:," or about:blank or chrome-error://chromewebdata/
    # for dead navigation
    if not addr:
        return False
    bad = ("chrome-error", "about:blank", "data:,")
    return any(b in addr.lower() for b in bad)


def main():
    log.info("=" * 60)
    log.info("PlayHT Pro signup runner — PyAutoGUI on Heath's real Chrome")
    log.info("=" * 60)

    # Start kill switch
    ks.start()
    ks.ensure_unlocked()

    # Step 1: open PlayHT pricing in Heath's Chrome
    try:
        shot_url = step_focus_and_open_pricing()
    except Exception as e:
        log.exception("focus + navigate failed: %s", e)
        telegram_send(f"❌ PlayHT signup aborted — could not focus Chrome or load page: {e}")
        return 2

    # Step 2: check if upstream is dead
    dead = detect_dead_upstream(shot_url)
    if dead:
        log.error("Upstream looks dead (chrome-error / about:blank in address bar).")
        telegram_send(
            "⚠️ PlayHT signup aborted — playht.com/pricing did not load in your Chrome "
            "(Chrome error page or blank). This matches the earlier finding that PlayHT "
            "may be dead upstream (DNS NXDOMAIN on api.play.ht and api.play.ai). "
            "Screenshot: " + shot_url + "\n\nRecommend: kill SV-PLAYHT-001 and stick with "
            "ElevenLabs Creator plan. Reply 'force' to make me try again anyway."
        )
        reply = wait_for_telegram_reply(
            "Reply 'force' within 60s to retry, or anything else to bail.",
            timeout=60,
        )
        if reply.strip() != "force":
            return 3
        log.info("Heath said force — retrying once.")
        shot_url = step_focus_and_open_pricing()
        if detect_dead_upstream(shot_url):
            telegram_send(
                "Still dead. Closing this stream. SV-PLAYHT-001 marked closed. "
                "Use ElevenLabs Charlie + Bill + Luna instead."
            )
            return 3

    # Page is up. Send Heath a thumbnail so he knows we're moving.
    telegram_send(
        f"PlayHT pricing loaded in your Chrome. Looking for the Pro plan signup button now. "
        f"Pre-click screenshot: {shot_url}"
    )

    # Step 3: find + click Pro plan button.
    # We have no OCR in Phase 1. Strategy: use PyAutoGUI's locateOnScreen with
    # template images for known "Pro" / "Get started" buttons. Without templates
    # to match, we ask Heath where to click via Telegram screenshot ping.
    # For a first run we ping Heath with screenshot and pause for a coordinate
    # reply (e.g. "click 850 540") OR a "manual" reply meaning Heath will click
    # the button himself and reply "next".

    # SAFER MODE for first run: ask Heath to confirm the click target.
    coord_reply = wait_for_telegram_reply(
        "I'm on the PlayHT pricing page. Reply with the Pro plan signup button "
        "screen coordinates as 'x y' (e.g. '850 540'), OR reply 'manual' and click "
        "it yourself then reply 'next' when you're at the signup screen. Screenshot "
        f"of current state: {shot_url}",
        timeout=180,
    )

    if coord_reply.startswith("manual"):
        log.info("Manual click mode — waiting for 'next' …")
        nxt = wait_for_telegram_reply(
            "OK, click the Pro plan button yourself. Reply 'next' when you're at "
            "the signup form (email field visible).",
            timeout=300,
        )
        if "next" not in nxt:
            telegram_send("Didn't get 'next' — bailing. Run me again when you're ready.")
            return 4
    elif coord_reply:
        parts = coord_reply.replace(",", " ").split()
        if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
            x, y = int(parts[0]), int(parts[1])
            log.info("Clicking Pro plan button at (%d, %d)", x, y)
            cd.click(x, y)
            time.sleep(3.0)
        else:
            telegram_send(f"Couldn't parse coords from {coord_reply!r}. Bailing.")
            return 4
    else:
        telegram_send("No reply received. Bailing without taking any action.")
        return 4

    # Step 4: At signup form. Prefer Google SSO if Heath says it's visible.
    sso_reply = wait_for_telegram_reply(
        "On the PlayHT signup form. Reply 'google' if you see 'Sign up with Google' "
        "(I'll click it and let Chrome's existing Google session do the work), OR "
        "reply 'email' to fill heath@meetdossie.com + a generated password.",
        timeout=120,
    )

    plays_ht_password = None
    if sso_reply == "google":
        google_reply = wait_for_telegram_reply(
            "Reply with the 'Sign up with Google' button coords as 'x y'.",
            timeout=120,
        )
        parts = google_reply.replace(",", " ").split()
        if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
            cd.click(int(parts[0]), int(parts[1]))
            time.sleep(4.0)
            # Google account chooser may appear in a popup; we can't drive it
            # without coords from Heath. Ask.
            chooser = wait_for_telegram_reply(
                "If a Google account chooser appeared, click your heath@meetdossie "
                "(or whichever you want) yourself, complete consent, and reply 'done'. "
                "If no chooser appeared (auto-signed-in), reply 'auto'.",
                timeout=300,
            )
            if chooser not in ("done", "auto"):
                telegram_send("Didn't get 'done'/'auto' — bailing.")
                return 5
        else:
            telegram_send("Couldn't parse Google SSO coords — bailing.")
            return 5
    elif sso_reply == "email":
        # Generate password + fill form
        plays_ht_password = gen_password(16)
        write_env_var("PLAYHT_PASSWORD", plays_ht_password)
        log.info("Generated PLAYHT_PASSWORD, length=%d", len(plays_ht_password))
        # We need Heath to tell us where the email field is.
        coord = wait_for_telegram_reply(
            "Reply with email-field coords as 'x y' — I'll click it, type the email, "
            "Tab to password, type the password. Make sure the email field is in view.",
            timeout=180,
        )
        parts = coord.replace(",", " ").split()
        if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
            cd.click(int(parts[0]), int(parts[1]))
            time.sleep(0.5)
            cd.type_text("heath@meetdossie.com", interval=0.02)
            time.sleep(0.3)
            cd.press_key("tab")
            time.sleep(0.3)
            # Use typewrite for the password but mark redacted
            cd.type_text(plays_ht_password, redact_password=True, interval=0.02)
            time.sleep(0.5)
            telegram_send(
                "Email + password filled. Click the 'Sign up' / 'Create account' button "
                "yourself if there's no Stripe redirect, OR reply with submit-button coords."
            )
            submit = wait_for_telegram_reply(
                "Reply with submit-button coords as 'x y', or 'manual' if you clicked it.",
                timeout=180,
            )
            if submit and submit != "manual":
                sp = submit.replace(",", " ").split()
                if len(sp) >= 2 and sp[0].isdigit() and sp[1].isdigit():
                    cd.click(int(sp[0]), int(sp[1]))
                    time.sleep(4.0)
        else:
            telegram_send("Couldn't parse email-field coords — bailing.")
            return 5
    else:
        telegram_send("No SSO/email decision — bailing.")
        return 5

    # Step 5: Stripe checkout gate
    pre_stripe_shot = cd.screenshot("playht-pre-stripe")
    telegram_send(
        "🛒 PlayHT Pro $50/mo at Stripe checkout. Card field — confirm to autofill "
        "from your saved cards, or paste a card if Chrome doesn't autofill. "
        f"Screenshot: {pre_stripe_shot}",
        photo_path=None,
    )
    stripe_reply = wait_for_telegram_reply(
        "Reply 'confirm' / 'yes' / 'go' to proceed with autofill + submit. "
        "Reply anything else (or wait 90s for timeout) to abort.",
        timeout=90,
    )
    if stripe_reply not in ("confirm", "yes", "go", "go ahead", "go-ahead", "ahead"):
        telegram_send("Stripe gate denied. Aborting signup before any charge. No purchase made.")
        log.info("Stripe gate not confirmed (reply=%r) — aborting.", stripe_reply)
        return 6

    # Heath confirmed — try autofill via Tab + Down + Enter, then ask for submit coords
    log.info("Stripe gate confirmed — attempting autofill flow.")
    # On Chrome Stripe forms, focusing card number field usually pops the autofill chip.
    coord = wait_for_telegram_reply(
        "Reply with Stripe card-number field coords as 'x y'. I'll click it, "
        "let autofill pop up, hit Tab to focus the autofill, Enter to accept. "
        "If autofill doesn't appear, I'll ping you for paste.",
        timeout=180,
    )
    parts = coord.replace(",", " ").split()
    if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
        cd.click(int(parts[0]), int(parts[1]))
        time.sleep(1.0)
        # Try Down then Enter (typical Chrome autofill pattern)
        cd.press_key("down")
        time.sleep(0.3)
        cd.press_key("enter")
        time.sleep(1.0)
        autofill_shot = cd.screenshot("playht-after-autofill")
        verify = wait_for_telegram_reply(
            "Did autofill work? Reply 'yes' (I'll click submit) + submit-button coords. "
            "Or 'no' and I'll wait for you to paste manually. "
            f"Screenshot: {autofill_shot}",
            timeout=180,
        )
        if verify.startswith("yes"):
            # Try to parse coords from the rest
            after_yes = verify.replace("yes", "", 1).replace(",", " ").split()
            after_yes = [t for t in after_yes if t.isdigit()]
            if len(after_yes) >= 2:
                cd.click(int(after_yes[0]), int(after_yes[1]))
                time.sleep(6.0)
            else:
                submit2 = wait_for_telegram_reply(
                    "Reply submit-button coords as 'x y'.", timeout=120
                )
                sp = submit2.replace(",", " ").split()
                if len(sp) >= 2 and sp[0].isdigit() and sp[1].isdigit():
                    cd.click(int(sp[0]), int(sp[1]))
                    time.sleep(6.0)
        else:
            paste = wait_for_telegram_reply(
                "OK, paste the card yourself + click submit. Reply 'done' when "
                "you see the post-checkout success page.",
                timeout=600,
            )
            if "done" not in paste:
                telegram_send("Didn't get 'done' — assuming signup did not complete. Bailing.")
                return 7
    else:
        telegram_send("Couldn't parse card-field coords — bailing.")
        return 7

    # Step 6: navigate to API access
    log.info("Navigating to API access page …")
    address_bar_navigate("https://playht.com/app/api-access")
    time.sleep(5.0)
    api_shot = cd.screenshot("playht-api-access")
    telegram_send(
        f"On PlayHT API access page. Reply with the 'copy User ID' button coords as 'x y'. "
        f"Screenshot: {api_shot}"
    )
    uid_coord = wait_for_telegram_reply(
        "Reply User ID copy-button coords 'x y'.", timeout=300
    )
    parts = uid_coord.replace(",", " ").split()
    user_id = None
    api_secret = None
    if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
        cd.click(int(parts[0]), int(parts[1]))
        time.sleep(0.5)
        try:
            import pyperclip
            user_id = pyperclip.paste().strip()
        except Exception:
            user_id = ""
        log.info("PLAYHT_USER_ID captured, length=%d", len(user_id))
        if user_id:
            write_env_var("PLAYHT_USER_ID", user_id)

    sec_coord = wait_for_telegram_reply(
        "Reply API Secret copy-button coords 'x y'.", timeout=300
    )
    parts = sec_coord.replace(",", " ").split()
    if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
        cd.click(int(parts[0]), int(parts[1]))
        time.sleep(0.5)
        try:
            import pyperclip
            api_secret = pyperclip.paste().strip()
        except Exception:
            api_secret = ""
        log.info("PLAYHT_API_SECRET captured, length=%d", len(api_secret) if api_secret else 0)
        if api_secret:
            write_env_var("PLAYHT_API_SECRET", api_secret)

    # Step 7: final report
    summary = (
        "✅ PlayHT signup done via your real Chrome.\n\n"
        f"User ID captured: {'yes (' + str(len(user_id)) + ' chars)' if user_id else 'NO — capture failed'}\n"
        f"API Secret captured: {'yes (' + str(len(api_secret) if api_secret else 0) + ' chars)' if api_secret else 'NO — capture failed'}\n"
        f"Password saved to .env.local: {'yes' if plays_ht_password else 'n/a (Google SSO)'}\n\n"
        "Still need to add these to Vercel prod env vars manually:\n"
        "  PLAYHT_USER_ID, PLAYHT_API_SECRET"
        + (", PLAYHT_PASSWORD" if plays_ht_password else "")
        + "\n\nBot detection bypassed (we drove your real Chrome, not a script-launched browser)."
    )
    telegram_send(summary)
    log.info("Done.")
    return 0


if __name__ == "__main__":
    rc = main()
    log.info("Exit code: %d", rc)
    sys.exit(rc)
