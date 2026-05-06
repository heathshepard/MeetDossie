# MeetDossie — Repo Conventions for Claude Code

## SECURITY RULES — NON-NEGOTIABLE
1. NEVER hardcode auth tokens, API keys, or secrets in source code.
2. NEVER use the "one-shot bypass token" pattern — it exposes auth patterns in git history.
3. If a cron needs manual triggering, use the `CRON_SECRET` from `.env.local` via curl locally.
4. If `CRON_SECRET` isn't available locally, ask Heath to run the curl — never embed a bypass.
5. Git history is permanent and public — treat every commit as permanent.

These rules are non-negotiable because:
- `meetdossie/MeetDossie` is a **public** GitHub repo. GitGuardian scans every push.
- A bearer-token bypass committed on 2026-05-06 (commit `f3700b2`) was reverted ~79 seconds later but lived in public history until scrubbed via `git filter-repo`. The pattern was repeated 3+ times in one day before this rule was written down.
- Even when reverted, hardcoded secrets remain visible in `git show <commit>` forever unless history is rewritten — and every rewrite is a destructive force-push that risks losing collaborator work.

### Approved patterns when manual trigger is needed
- **Run locally with the real secret**: `curl -H "Authorization: Bearer $CRON_SECRET" https://meetdossie.com/api/cron-publish-approved` (the value comes from `.env.local`, never the source).
- **Ask Heath to fire it**: paste a one-liner in Telegram, Heath runs it. No code change.
- **Add a debug param Heath passes manually**: e.g. `?force=1` paired with the existing `Bearer $CRON_SECRET` — gates additional behavior without weakening auth.

### Forbidden patterns
- `const ONE_SHOT_TOKEN = 'Bearer <hex>';` paired with a fallback `if (auth !== ONE_SHOT_TOKEN)`.
- Any literal API key, JWT, or bearer string in `.js`, `.py`, `.json`, `.html`, or other tracked files.
- Any "I'll commit this and revert it next commit" plan that involves a secret. Reverts do not undo public exposure.
