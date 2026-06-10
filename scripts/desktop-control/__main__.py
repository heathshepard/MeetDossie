"""Cole desktop control - top-level entry point.

Wires:
- kill_switch (Telegram STOP/RESUME poll loop)
- screen_recorder (rotating ffmpeg gdigrab capture)
- A simple line-based command REPL on stdin

Cole sends commands via subprocess.stdin in the form:
    <verb> <json args>
For example:
    click {"x": 420, "y": 200}
    type {"text": "hello", "redact_password": false}
    hotkey {"keys": ["ctrl", "s"]}
    screenshot {"label": "test"}
    find_window {"title": "Notepad"}
    sleep {"seconds": 1.5}
    quit {}

Every state-changing verb is funneled through guards.evaluate_action FIRST.
If a confirmation gate fires, the guard blocks the calling thread for up to
~90s waiting on Heath's Telegram tap; default-deny on timeout.

stdout returns JSON-per-line so the calling shell can parse responses.
"""

from __future__ import annotations

import sys
import json
import time
import signal
import logging
from pathlib import Path

# Make this directory importable both as `python -m desktop-control`
# and as `python __main__.py`
_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

import cole_desktop as desktop  # noqa: E402
import guards  # noqa: E402
import kill_switch  # noqa: E402
import screen_recorder  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("cole_desktop.main")


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, default=str) + "\n")
    sys.stdout.flush()


def _guarded(verb: str, args: dict, build_visible_text=None,
             requested_by: str = "cole") -> dict:
    """Run guard, return either an executed-action dict or a denial dict."""
    try:
        kill_switch.ensure_unlocked()
    except kill_switch.KillSwitchTriggered as e:
        return {"ok": False, "verb": verb, "error": str(e), "blocked_by": "kill_switch"}

    visible_text = build_visible_text(args) if build_visible_text else ""
    pre_shot = desktop.screenshot(f"{verb}-pre-guard")
    g = guards.evaluate_action(
        action_type=verb,
        target=str(args),
        text_typed=args.get("text", "") if isinstance(args, dict) else "",
        recipient=args.get("recipient", "") if isinstance(args, dict) else "",
        visible_text=visible_text,
        window_title=args.get("window_title", "") if isinstance(args, dict) else "",
        url=args.get("url", "") if isinstance(args, dict) else "",
        pre_screenshot_url=pre_shot,
    )
    if not g.allowed:
        # Log the blocked action for the audit table
        desktop.log_action(
            action_type=verb,
            target=str(args),
            screenshot_before_url=pre_shot,
            requested_by=requested_by,
            approved_by=None,
            result=f"blocked: {g.reason}",
        )
        return {"ok": False, "verb": verb, "error": g.reason, "blocked_by": "guard"}

    # Allowed - dispatch
    return {"_proceed": True, "approved_by": g.approved_by, "pre_screenshot_url": pre_shot}


def dispatch(line: str) -> dict:
    line = line.strip()
    if not line:
        return {"ok": True, "noop": True}
    # Split "verb {json}" - tolerate verb with no args
    if " " in line:
        verb, rest = line.split(" ", 1)
        try:
            args = json.loads(rest) if rest.strip() else {}
        except json.JSONDecodeError as e:
            return {"ok": False, "error": f"bad json: {e}"}
    else:
        verb, args = line, {}

    verb = verb.lower()
    requested_by = args.get("requested_by", "cole") if isinstance(args, dict) else "cole"

    # Verbs that DON'T mutate UI state (allowed without guard)
    if verb == "screenshot":
        url = desktop.screenshot(args.get("label", "manual"))
        return {"ok": True, "verb": verb, "screenshot_url": url}
    if verb == "screen_size":
        w, h = desktop.screen_size()
        return {"ok": True, "verb": verb, "width": w, "height": h}
    if verb == "find_window":
        win = desktop.find_window(args.get("title", ""))
        if win is None:
            return {"ok": True, "verb": verb, "found": False}
        try:
            title = win.window_text()
            rect = win.rectangle()
            return {"ok": True, "verb": verb, "found": True, "title": title,
                    "rect": {"left": rect.left, "top": rect.top, "right": rect.right, "bottom": rect.bottom}}
        except Exception as e:
            return {"ok": True, "verb": verb, "found": True, "error": str(e)}
    if verb == "sleep":
        time.sleep(float(args.get("seconds", 0.5)))
        return {"ok": True, "verb": verb}
    if verb == "is_locked":
        locked, reason = guards.is_locked()
        return {"ok": True, "verb": verb, "locked": locked, "reason": reason}
    if verb in ("quit", "exit"):
        return {"ok": True, "verb": "quit", "_quit": True}
    if verb == "ping":
        return {"ok": True, "verb": "ping", "ts": time.time()}

    # State-changing verbs: must pass guard
    pre = _guarded(verb, args, requested_by=requested_by)
    if not pre.get("_proceed"):
        return pre

    approved_by = pre.get("approved_by")

    try:
        if verb == "click":
            res = desktop.click(int(args["x"]), int(args["y"]),
                                button=args.get("button", "left"),
                                requested_by=requested_by, approved_by=approved_by)
        elif verb == "double_click":
            res = desktop.double_click(int(args["x"]), int(args["y"]),
                                       requested_by=requested_by, approved_by=approved_by)
        elif verb == "type":
            res = desktop.type_text(args["text"],
                                    redact_password=bool(args.get("redact_password", False)),
                                    interval=float(args.get("interval", 0.02)),
                                    requested_by=requested_by, approved_by=approved_by)
        elif verb == "hotkey":
            keys = args["keys"]
            res = desktop.hotkey(*keys, requested_by=requested_by, approved_by=approved_by)
        elif verb == "press_key":
            res = desktop.press_key(args["key"],
                                    requested_by=requested_by, approved_by=approved_by)
        elif verb == "drag":
            res = desktop.drag(int(args["x1"]), int(args["y1"]),
                               int(args["x2"]), int(args["y2"]),
                               duration=float(args.get("duration", 0.4)),
                               requested_by=requested_by, approved_by=approved_by)
        elif verb == "move_to":
            res = desktop.move_to(int(args["x"]), int(args["y"]),
                                  requested_by=requested_by, approved_by=approved_by)
        else:
            return {"ok": False, "error": f"unknown verb: {verb}"}
    except KeyError as e:
        return {"ok": False, "error": f"missing arg: {e}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}

    return {"ok": True, "verb": verb, **res}


def main() -> None:
    log.info("Starting Cole desktop control")

    # 1. Kill switch
    kill_switch.start()
    log.info("Kill switch active (text STOP to Telegram to lock)")

    # 2. Screen recorder (best-effort)
    if screen_recorder.start():
        log.info("Screen recorder active")
    else:
        log.warning("Screen recorder NOT running (ffmpeg missing or disabled)")

    # 3. Graceful shutdown
    def _sigterm(_sig, _frame):
        log.info("Signal received, shutting down")
        kill_switch.stop()
        screen_recorder.stop()
        sys.exit(0)
    try:
        signal.signal(signal.SIGTERM, _sigterm)
        signal.signal(signal.SIGINT, _sigterm)
    except Exception:
        pass

    _emit({"ok": True, "ready": True, "msg": "cole_desktop ready. send commands as 'verb {json}' lines"})

    # 4. stdin command loop
    for line in sys.stdin:
        result = dispatch(line)
        _emit(result)
        if result.get("_quit"):
            break

    kill_switch.stop()
    screen_recorder.stop()
    log.info("Bye")


if __name__ == "__main__":
    main()
