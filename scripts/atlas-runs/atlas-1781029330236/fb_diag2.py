"""Diagnose why goto_url isn't navigating Heath's Chrome.

Steps:
1. Take baseline screenshot.
2. List Chrome windows + window text (URL bar).
3. Bring Chrome forward via pywinauto.
4. Capture screen after focus.
5. Ctrl+L, read clipboard (the address bar contents WILL be selected after Ctrl+L).
6. Save what the address bar held.
7. Try navigation: clipboard.copy('https://example.com'), Ctrl+V, Enter.
8. Wait 5s, screenshot AGAIN, dump new window title.
9. Try Ctrl+A + Ctrl+C and report char count.

This tells us exactly where in the chain we lose: focus, nav, or scrape.
"""

import os
import sys
import time
from pathlib import Path

import pyautogui
import pyperclip
import mss
import mss.tools
from pywinauto import Desktop

pyautogui.FAILSAFE = False
pyautogui.PAUSE = 0.1

OUT = Path(__file__).resolve().parent


def shoot(name: str):
    out = OUT / name
    try:
        with mss.MSS() as sct:
            mon = sct.monitors[1]
            data = sct.grab(mon)
            mss.tools.to_png(data.rgb, data.size, output=str(out))
        print(f"  screenshot saved: {out}")
    except Exception as e:
        print(f"  screenshot FAILED: {e}")


def chrome_window_title() -> str:
    titles = []
    for w in Desktop(backend="uia").windows():
        try:
            t = w.window_text() or ""
        except Exception:
            continue
        if "chrome" in t.lower():
            titles.append(t)
    return " || ".join(titles)


def focus_chrome():
    for w in Desktop(backend="uia").windows():
        try:
            t = (w.window_text() or "").lower()
        except Exception:
            continue
        if "chrome" in t:
            try:
                w.set_focus()
                time.sleep(0.5)
                return True
            except Exception as e:
                print("  focus exception:", e)
                continue
    return False


def main():
    sw, sh = pyautogui.size()
    print(f"Screen size: {sw}x{sh}")
    pyautogui.moveTo(sw // 2, sh // 2)

    print("Baseline window title:")
    print(" ", chrome_window_title()[:300])
    shoot("diag2_step1_baseline.png")

    print("\nFocusing Chrome...")
    focused = focus_chrome()
    print(f"  focus_chrome -> {focused}")
    time.sleep(1.0)
    shoot("diag2_step2_focused.png")
    print("  title after focus:", chrome_window_title()[:300])

    print("\nStep 3: Ctrl+L (focus address bar)")
    pyautogui.hotkey("ctrl", "l")
    time.sleep(0.6)

    # Read what's selected in address bar via Ctrl+C
    pyperclip.copy("")
    time.sleep(0.2)
    pyautogui.hotkey("ctrl", "c")
    time.sleep(0.6)
    addr = pyperclip.paste()
    print(f"  address bar content: '{addr[:140]}'")
    Path(OUT / "diag2_address_bar.txt").write_text(addr, encoding="utf-8")
    shoot("diag2_step3_address_bar_selected.png")

    print("\nStep 4: paste a target URL")
    target = "https://www.facebook.com/search/posts/?q=trec+amendment+help"
    pyautogui.hotkey("ctrl", "l")  # refocus address bar
    time.sleep(0.3)
    pyautogui.press("delete")
    time.sleep(0.2)
    pyperclip.copy(target)
    time.sleep(0.3)
    pyautogui.hotkey("ctrl", "v")
    time.sleep(0.5)
    pyautogui.press("enter")
    print("  waiting 8s for navigation...")
    time.sleep(8.0)
    shoot("diag2_step4_after_nav.png")
    print("  title after nav:", chrome_window_title()[:300])

    print("\nStep 5: F6 to move focus from address bar to page")
    pyautogui.press("f6")
    time.sleep(0.5)
    pyautogui.click(x=sw // 2, y=sh // 2)
    time.sleep(0.5)
    shoot("diag2_step5_after_f6_click.png")

    print("\nStep 6: scroll then Ctrl+A + Ctrl+C")
    for _ in range(3):
        pyautogui.scroll(-800)
        time.sleep(1.0)
    pyautogui.hotkey("ctrl", "home")
    time.sleep(1.0)

    pyperclip.copy("")
    time.sleep(0.2)
    pyautogui.hotkey("ctrl", "a")
    time.sleep(0.5)
    pyautogui.hotkey("ctrl", "c")
    time.sleep(1.2)
    text = pyperclip.paste() or ""
    print(f"  clipboard text length: {len(text)}")
    Path(OUT / "diag2_scrape.txt").write_text(text[:8000], encoding="utf-8")
    shoot("diag2_step6_final.png")

    print("\nDone. Inspect diag2_*.png + diag2_address_bar.txt + diag2_scrape.txt")


if __name__ == "__main__":
    main()
