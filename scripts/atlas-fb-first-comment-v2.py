"""atlas-fb-first-comment-v2.py

DO NOT delete - required by scheduled task "Dossie First Comment Auto-Attach"
at 18:00, 20:00, 03:00 daily. Called by scripts/atlas-fb-first-comments-blitz-v2.js.

Thin Python wrapper around scripts/_lib/fb-first-comment-playwright.js.

WHY a Node helper instead of PyAutoGUI on Heath's real Chrome?
  The prior strategy was PyAutoGUI on Heath's main Chrome. That window is
  NOT logged into Facebook (confirmed via screenshot 2026-06-11: every prior
  run hit FB's login wall and returned needle_not_found). The DossieBot-Sage
  Chrome profile IS logged in - it's the profile fb-group-poster.js uses to
  publish the parent posts in the first place. So we drive that profile via
  Playwright persistent context for a reliable DOM-based attach.

This script keeps the original CLI contract so atlas-fb-first-comments-blitz-v2.js
does not need to change:

  python scripts/atlas-fb-first-comment-v2.py \
    --group-url <url> --needle <str> --comment-file <path> \
    --post-id <uuid> --label <label>

It prints `ATLAS_RESULT_JSON:{...}` as its final line (the JS parses this
with regex). Outcome codes match the prior contract exactly so the JS retry
logic (`retryable = ['composer_unclickable', 'paste_failed', 'submit_failed',
'comment_button_missing']`) keeps working.

Outcome codes:
  posted, needle_not_found, comment_button_missing, composer_unclickable,
  paste_failed, submit_failed, login_required, exception
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
RUNS_ROOT = REPO_ROOT / "scripts" / "atlas-runs"
NODE_HELPER = REPO_ROOT / "scripts" / "_lib" / "fb-first-comment-playwright.js"


def log(msg):
    print(f"[atlas-fb-first-comment-v2] {msg}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--group-url", required=True)
    ap.add_argument("--needle", required=True)
    ap.add_argument("--comment-file", required=True)
    ap.add_argument("--post-id", required=True)
    ap.add_argument("--label", default="first-comment")
    args = ap.parse_args()

    run_dir = RUNS_ROOT / f"fb-fc-v2-{int(time.time())}-{args.label}"
    run_dir.mkdir(parents=True, exist_ok=True)

    if not NODE_HELPER.exists():
        result = {
            "ts": datetime.now().isoformat(),
            "group_url": args.group_url,
            "needle": args.needle,
            "post_id": args.post_id,
            "label": args.label,
            "run_dir": str(run_dir),
            "steps": ["node_helper_missing"],
            "outcome": "exception",
            "reason": f"missing {NODE_HELPER}",
            "comment_preview": "",
        }
        print("ATLAS_RESULT_JSON:" + json.dumps(result))
        sys.exit(0)

    log(f"delegating to Playwright helper: {NODE_HELPER}")
    log(f"run_dir: {run_dir}")

    cmd = [
        "node", str(NODE_HELPER),
        "--group-url", args.group_url,
        "--needle", args.needle,
        "--comment-file", args.comment_file,
        "--post-id", args.post_id,
        "--label", args.label,
        "--run-dir", str(run_dir),
    ]
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=str(REPO_ROOT),
    )

    captured = []
    pwfc_line = None
    if proc.stdout is not None:
        for line in proc.stdout:
            sys.stdout.write(line)
            sys.stdout.flush()
            captured.append(line)
            m = re.search(r"PWFC_RESULT_JSON:(\{.*\})\s*$", line)
            if m:
                pwfc_line = m.group(1)
    proc.wait()

    if pwfc_line:
        try:
            data = json.loads(pwfc_line)
        except Exception as e:
            data = {
                "outcome": "exception",
                "reason": f"could not parse PWFC_RESULT_JSON: {e}",
                "run_dir": str(run_dir),
                "ts": datetime.now().isoformat(),
                "post_id": args.post_id,
                "label": args.label,
                "needle": args.needle,
                "group_url": args.group_url,
                "comment_preview": "",
                "steps": [],
            }
        # Stamp our own contract fields. The blitz JS expects post_id, label,
        # group_url, needle, outcome, run_dir at top level - already present
        # because the Node helper writes them.
        print("ATLAS_RESULT_JSON:" + json.dumps(data))
        sys.exit(0)

    # Node helper died without emitting a result line.
    result = {
        "ts": datetime.now().isoformat(),
        "group_url": args.group_url,
        "needle": args.needle,
        "post_id": args.post_id,
        "label": args.label,
        "run_dir": str(run_dir),
        "steps": ["node_helper_exited_without_result"],
        "outcome": "exception",
        "reason": f"node exit code {proc.returncode}; last 400 chars: {''.join(captured)[-400:]}",
        "comment_preview": "",
    }
    print("ATLAS_RESULT_JSON:" + json.dumps(result))
    sys.exit(0)


if __name__ == "__main__":
    main()
