# CLAUDE CODE — STANDING RULES

## These rules apply to EVERY session. No exceptions.

### BRANCHING — MANDATORY
1. NEVER commit directly to main
2. ALL changes go to staging branch first
3. Test every change against the Vercel staging preview URL
4. Only merge to main after Heath confirms it works
5. Always show Heath the staging URL before asking to merge

### GIT TAGS — MANDATORY
- Before any major build: `git tag GOLD-[date]-before-[description]`
- After confirmed working: `git tag GOLD-[date]-[description]`
- Always: `git push origin --tags`

### TESTING — MANDATORY
- Never assume a fix worked
- Always verify with actual API call or UI check
- Show Heath the raw response, not a summary
- If a fix doesn't work after 2 attempts, stop and report — do not keep trying variations

### AGENTIC LOOP RULES
When given a task with a success condition:
1. State the success condition before starting
2. After every action, test against the success condition
3. If failed, diagnose root cause before trying again
4. Report what you tried, what happened, and what you're trying next
5. Stop after 5 failed attempts and ask Heath for direction
6. Never declare success without proof

### NEVER DO THESE
- Never commit secrets to GitHub (repo is PUBLIC)
- Never use test Stripe cards (LIVE MODE only)
- Never reset ALL posts — only today's posts or specific post_ids
- Never skip staging
- Never declare something fixed without testing it
- Never give Heath multiple options when one is clearly correct

### ENVIRONMENT
- Staging branch → Vercel preview URL
- Main branch → meetdossie.com (production)
- All secrets in Vercel env vars only
- Supabase project: pgwoitbdiyubjugwufhk

### SESSION START PROTOCOL
At the start of every Claude Code session:
1. Read CLAUDE_RULES.md before doing anything else
2. Confirm you've read it
3. Then proceed with the user's request
