"""Diagnostic: scrape Facebook public posts search.

If most of Heath's groups in group_registry are 'pending admin approval'
(per fb_diag.txt findings), then we need a different surface that doesn't
depend on group membership. Facebook's public posts search returns
posts from any Page/group/profile that's set to Public -- including
TC-related laments from Texas agents -- without requiring Heath to be
approved into the source group.

URLs to test:
  /search/posts/?q=transaction%20coordinator%20texas
  /search/posts/?q=texas%20realtor%20option%20period
  /search/posts/?q=trec%20amendment

Save each raw scrape to disk for inspection.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
import urllib.parse

_REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO_ROOT / "scripts"))

import importlib
chrome = importlib.import_module("unified-scanner.chrome")

OUT_DIR = Path(__file__).resolve().parent / "diag"
OUT_DIR.mkdir(exist_ok=True)


def diag(query: str) -> None:
    q = urllib.parse.quote(query)
    url = f"https://www.facebook.com/search/posts/?q={q}"
    safe = query.replace(" ", "_")
    print(f"--- {query} ---", flush=True)
    chrome.goto_url(url, settle_seconds=12.0)
    print("Navigated. Sleeping 5s for posts to render...", flush=True)
    time.sleep(5.0)

    for i in range(8):
        chrome.scroll(-1000)
        time.sleep(2.5)
        print(f"  scroll {i+1}/8 done", flush=True)

    time.sleep(2.0)
    chrome.scroll_to_top()
    time.sleep(1.5)

    raw = chrome.copy_visible_text()
    print(f"  scraped {len(raw or '')} chars", flush=True)
    out = OUT_DIR / f"search_{safe}.txt"
    out.write_text(raw or "<empty>", encoding="utf-8", errors="replace")
    print(f"  wrote {out}", flush=True)


if __name__ == "__main__":
    diag("transaction coordinator texas")
    time.sleep(2.0)
    diag("texas realtor option period")
    print("DONE", flush=True)
