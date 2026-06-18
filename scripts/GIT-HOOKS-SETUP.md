# Git Hooks Setup

This repository uses custom git hooks to prevent common deployment mistakes. These hooks must be installed locally.

## Installation

Run this once after cloning or pulling:

```bash
cd "C:\Users\Heath Shepard\Desktop\MeetDossie"
git config core.hooksPath scripts/git-hooks
cp scripts/git-hooks/*.sh .git/hooks/ 2>/dev/null || true
chmod +x .git/hooks/pre-push 2>/dev/null || true
```

Or on Windows:

```powershell
cd "C:\Users\Heath Shepard\Desktop\MeetDossie"
git config core.hooksPath scripts/git-hooks
Copy-Item scripts/git-hooks/*.sh .git/hooks/ -ErrorAction SilentlyContinue
```

## Hooks

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

The pre-push hook prevents the recurring `67f1db4` / `d31fece` mistakes where HTML was updated with a new bundle hash but the actual bundle file was never committed. This left staging with a blank-screen 404.

Hooks are part of the repo but live outside the standard git tracking (in `.git/hooks/`). They must be installed once per local clone.
