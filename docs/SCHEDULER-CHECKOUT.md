# The scheduler checkout — why it exists, how it stays in sync

**Problem (2026-09-16):** Windows Task Scheduler runs whatever's on disk at
`C:\Users\Heath\Projects\MeetDossie`. That tree is also Heath's live dev
surface — it hops branches all day (main → staging → wip/...) and regularly
carries 1000+ uncommitted files. Three times in one day a merged fix to a
scheduled script did nothing because the scheduler was still executing the
pre-merge version. `scripts/detect-scheduled-script-drift.js` detects this;
it doesn't fix it.

**Fix:** a second, fully separate `git clone` of this repo at
`C:\Users\Heath\Projects\MeetDossie-scheduler`, pinned to `main`, reset to
`origin/main` before every scheduled run. It has its own `.git` directory —
no shared objects/refs with the dev tree — so nothing that happens here can
ever touch `C:\Users\Heath\Projects\MeetDossie`.

## What syncs vs. what's copied

- **Code:** `git fetch origin main && git reset --hard -q origin/main`,
  run by `C:\Users\Heath\Projects\meetdossie-scheduler-run.cmd` before every
  task. That launcher lives OUTSIDE both `MeetDossie` and
  `MeetDossie-scheduler` (directly under `Projects\`) specifically so it is
  never a target of `reset --hard` in either tree.
- **`.env.local`:** gitignored either way, so `reset --hard` never touches
  it regardless. The launcher copies it fresh from the dev tree's copy on
  every run — one source of truth, no manual re-sync on rotation.
- **Local state files** (`scripts/.comment-hunt-halt.json`,
  `scripts/.comment-hunt-state.json`,
  `scripts/.listing-marketing-live-state.json`): untracked, copied ONCE at
  setup (2026-09-16) so day-gating/halt state carried over cleanly at
  cutover. After cutover only this checkout writes them — the dev tree's
  copies go stale and unused, which is fine as long as nothing manually
  re-runs these particular scripts from the dev tree.

## Self-locating paths (the real gotcha)

Several tracked wrapper scripts hardcoded an absolute
`C:\Users\Heath\Projects\MeetDossie\...` path to *themselves*
(`scripts\run-tc-discovery-harvest.cmd`,
`scripts\tc-discovery-harvest-hidden.vbs`). Cloned unmodified, they would
`cd`/shell back into the DEV tree regardless of which checkout launched
them — silently defeating this whole setup. Fixed via `%~dp0` (`.cmd`) and
`WScript.ScriptFullName`'s parent folder (`.vbs`) instead of literals —
same behavior in the dev tree, correct behavior anywhere else. See commit
`fix(scheduler): self-locate TC-harvest wrapper paths...`.

**Known gap:** `scripts/brokerage-mls-keepalive.cmd`/`.js` and
`scripts/sms-poller-hidden.vbs`/`run-sms-poller.sh` are NOT tracked in git
at all — they only exist on the dev-tree machine. A clean checkout of
`origin/main` doesn't contain them, so `Dossie-MLS-KeepAlive` and
`SmsPoller` cannot move to this checkout as-is. That's a separate decision
(track them, or leave those two tasks on the dev tree permanently) — out of
scope for this fix.

## What never moves here

`AgentQueuePoller`, `ClaudeCodeWorker`, `ColeClaudeCodeSession` run Claude
Code itself against the live dev tree by design (Cole's own Telegram
session, the worker, the queue poller). They must keep running against
`C:\Users\Heath\Projects\MeetDossie` with its uncommitted WIP intact —
repointing them here would hard-reset the very tree they operate on.

## Cutover safety

Repointing is a `schtasks /Change /TR ...` edit on each EXISTING task, not a
new task added alongside the old one — there is no window where both the
old (dev-tree) and new (-scheduler) action run concurrently for the same
task. Verify no task shows `Running` before editing.
