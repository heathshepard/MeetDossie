"""60-second end-to-end smoke test for Cole desktop control.

Run: python scripts/desktop-control/smoke_test.py

What it does (in order):
1. Launches Calculator
2. Finds the window via pywinauto
3. Screenshots before-state
4. Types "5+3="
5. Screenshots after-state (should show "8")
6. Closes Calculator via Alt+F4
7. Prints all action IDs + screenshot URLs from this run

NO Telegram confirmations fire because all actions are autonomous,
non-destructive, non-spend, non-customer-comm. If any of those gates trip
during a real Cole session, you'll see "blocked_by: guard" in the JSON output.
"""

from __future__ import annotations

import sys
import time
import subprocess
from pathlib import Path

_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_DIR))

import cole_desktop as d  # noqa: E402


def main() -> int:
    print("\n=== Cole desktop-control 60s smoke test ===\n")

    # 1. Launch Calculator
    print("1. Launching Calculator...")
    subprocess.Popen(["calc.exe"], shell=False)
    time.sleep(2)

    # 2. Find the window
    win = d.find_window("Calculator")
    print(f"2. Window found: {win is not None}")

    # 3. Screenshot before
    before = d.screenshot("calc-before")
    print(f"3. Before: {before}")

    # 4. Type 5+3=
    r1 = d.type_text("5", requested_by="smoke_test")
    print(f"4a. Type 5: action_id={r1['action_id']} result={r1['result']}")

    r2 = d.press_key("add", requested_by="smoke_test")
    print(f"4b. Press +: action_id={r2['action_id']} result={r2['result']}")

    r3 = d.type_text("3", requested_by="smoke_test")
    print(f"4c. Type 3: action_id={r3['action_id']} result={r3['result']}")

    r4 = d.press_key("enter", requested_by="smoke_test")
    print(f"4d. Press =: action_id={r4['action_id']} result={r4['result']}")

    # 5. Screenshot after
    after = d.screenshot("calc-after-5-plus-3")
    print(f"5. After: {after}")

    # 6. Close Calculator
    r5 = d.hotkey("alt", "f4", requested_by="smoke_test")
    print(f"6. Alt+F4: action_id={r5['action_id']} result={r5['result']}")

    print("\n=== Smoke test complete ===")
    print(f"Review the after screenshot ({after}) to confirm Calculator shows '8'.")
    print("Audit table:")
    print("  SELECT * FROM desktop_actions WHERE requested_by='smoke_test' ORDER BY id DESC LIMIT 10;")
    return 0


if __name__ == "__main__":
    sys.exit(main())
