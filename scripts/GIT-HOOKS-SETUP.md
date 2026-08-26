# Git Hooks Setup

This repository uses custom git hooks to prevent common deployment mistakes. These hooks must be installed locally.

## Installation

Run this once after cloning or pulling:

```bash
cd /mnt/c/Users/Heath/Projects/MeetDossie
cp scripts/git-hooks/pre-commit-cron-cap-check.sh .git/hooks/pre-commit
cp scripts/git-hooks/pre-push-bundle-check.sh .git/hooks/pre-push
chmod +x .git/hooks/pre-commit .git/hooks/pre-push
```

Or on Windows:

```powershell
cd "C:\Users\Heath\Projects\MeetDossie"
Copy-Item scripts/git-hooks/pre-commit-cron-cap-check.sh .git/hooks/pre-commit
Copy-Item scripts/git-hooks/pre-push-bundle-check.sh .git/hooks/pre-push
```

Note: `.git/hooks/pre-push` on this clone is currently the staging->main merge
guard (see its header comment for what it does and its
`ALLOW_DIRECT_MAIN=1` override) — that guard is hand-maintained directly in
`.git/hooks/`, separate from `pre-push-bundle-check.sh` below. Don't overwrite
one with the other without merging their logic.

## Hooks

### pre-commit-cron-cap-check.sh

**Purpose:** Blocks any commit that would push `vercel.json`'s `crons` array past Vercel's 100-item cap. Broke production deploys twice (2026-08-23, 2026-08-25) because the overage was only caught at push/deploy time.

**Triggers:** When you run `git commit` and `vercel.json` is staged as part of the commit. No-op for every other commit.

**What it checks:**
- Reads the STAGED version of `vercel.json` (`git show :vercel.json`), not the working-tree copy
- Parses `crons` and counts entries
- Blocks (exit 1) if count > 100 — matches Vercel's real cap; 100 itself is allowed, 101+ is not, per Vercel's own validation error text: `"crons" should NOT have more than 100 items`
- Fails OPEN (warns, doesn't block) if `vercel.json` can't be read or parsed, so a corrupt file never becomes an unrelated blocker

**Fix:** If the hook rejects your commit, consolidate or remove the reported number of cron entries (or move an overflow job to cron-job.org, see CLAUDE.md) before committing again.

**Skip (should not normally be needed):** `git commit --no-verify`

### pre-push-bundle-check.sh

**Purpose:** Prevents blank-screen 404 incidents by verifying that all workspace-*.js bundles referenced in HTML are tracked in git before any push.

**Triggers:** When you run `git push`

**What it checks:**
- Scans `app.html` and `workspace.html` for `workspace-*.js` filenames
- For each referenced bundle, confirms it's tracked in git via `git ls-files`
- If any bundle is missing, refuses the push with a clear error

**Fix:** If the hook rejects your push:
```bash
git add assets/workspace-[HASH].js
git push origin staging
```

## Why These Hooks Matter

The pre-push hook prevents the recurring `67f1db4` / `d31fece` mistakes where HTML was updated with a new bundle hash but the actual bundle file was never committed. This left staging with a blank-screen 404. The pre-commit hook prevents `vercel.json` from ever exceeding Vercel's cron cap again.

Hooks are part of the repo but live outside the standard git tracking (in `.git/hooks/`). They must be installed once per local clone.
