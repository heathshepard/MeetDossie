"""Diagnostic: scrape ONE FB group with aggressive scroll + long settle.

Save the full raw clipboard dump to disk so we can see what FB is
actually returning. The earlier one-shot got 700-1100 chars per group;
that's far too thin to contain real post bodies.

Hypothesis options:
- FB is rendering a checkpoint / age-restriction wall
- FB's text-layer-on-page is limited to viewport + a few neighbors
- Heath's Chrome has reduced font rendering causing Ctrl+A to misbehave
- Group requires re-login

Strategy: navigate, wait 12s, scroll down 6 times with 3s pauses each,
then Ctrl+A + Ctrl+C, dump full text + length to a file.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO_ROOT / "scripts"))

import importlib
chrome = importlib.import_module("unified-scanner.chrome")

OUT_DIR = Path(__file__).resolve().parent / "diag"
OUT_DIR.mkdir(exist_ok=True)


def diag(group_name: str, group_url: str) -> None:
    print(f"--- {group_name} ---", flush=True)
    chrome.goto_url(group_url, settle_seconds=12.0)
    print("Navigated. Sleeping 5s for posts to render...", flush=True)
    time.sleep(5.0)

    for i in range(6):
        chrome.scroll(-900)
        time.sleep(3.0)
        print(f"  scroll {i+1}/6 done", flush=True)

    # One more wait so newest scrolled-in posts have a moment to settle.
    time.sleep(2.0)

    # Scroll back to top so Ctrl+A starts from the page beginning.
    chrome.scroll_to_top()
    time.sleep(1.5)

    raw = chrome.copy_visible_text()
    print(f"  scraped {len(raw or '')} chars", flush=True)

    safe = group_name.replace(" ", "_").replace("/", "_")
    out = OUT_DIR / f"{safe}.txt"
    out.write_text(raw or "<empty>", encoding="utf-8", errors="replace")
    print(f"  wrote {out}", flush=True)


if __name__ == "__main__":
    # Two groups for comparison.
    diag("Realtors San Antonio Boerne", "https://www.facebook.com/groups/752142151598217/")
    time.sleep(2.0)
    diag("Texas Real Estate Agents", "https://www.facebook.com/groups/texasusarealestateagents/")
    print("DONE", flush=True)
