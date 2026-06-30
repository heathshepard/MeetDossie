# DossieBot Chrome Profile Setup

Playwright scripts use a dedicated Chrome profile so they never conflict with
your personal Chrome session. Chrome locks the Default profile while it's open,
which causes Playwright to fail. The DossieBot profile is only used by scripts
and is never open in a live Chrome window at the same time.

---

## One-time setup (5 minutes)

1. Open Chrome normally.
2. Click the profile avatar in the top-right corner (circle/photo icon).
3. Click "Add" at the bottom of the profile dropdown.
4. Name it **DossieBot** exactly.
5. Chrome opens a new window for the DossieBot profile.
6. In that window, log into:
   - **Facebook** as Heath (meetdossie.com posts + group posting)
   - **Instagram** as @meetdossie
   - **LinkedIn** as Heath Shepard (the Dossie company page author)
   - **Twitter/X** as @meetdossie (optional for future scripts)
7. Close the DossieBot Chrome window (do not leave it open when running scripts).

---

## Finding the profile directory name

Chrome assigns a folder name like "Profile 1", "Profile 2", etc. You need the
exact folder name to set in `PLAYWRIGHT_PROFILE_NAME`.

1. Open Chrome with the DossieBot profile active.
2. Go to: `chrome://version`
3. Find the line that says "Profile Path" — it will look like:
   `C:\Users\Heath Shepard\AppData\Local\Google\Chrome\User Data\Profile 4`
4. The last segment (e.g., `Profile 4`) is your profile directory name.
5. Confirm `.env.local` matches:

```
PLAYWRIGHT_PROFILE_DIR=C:\Users\Heath Shepard\AppData\Local\Google\Chrome\User Data
PLAYWRIGHT_PROFILE_NAME=Profile 4
```

---

## Before running any script

1. Close ALL Chrome windows (including DossieBot).
2. Run the script from the MeetDossie repo root.

Chrome cannot run alongside Playwright persistent context — it will throw a
"profile is locked" error.

---

## Scripts reference

### fb-group-poster.js
Post approved group_posts to Facebook groups.

```
node scripts/fb-group-poster.js --post-id [uuid]
```

Fetches the post from `group_posts` table, navigates to the group, types and
submits the post body, marks it as posted, sends Telegram confirmation.

---

### fb-group-commenter.js
Scan FB groups for TC-pain posts, draft replies via Claude Haiku, send for
Telegram approval (30-min veto window), then post the comment if approved.

```
node scripts/fb-group-commenter.js
```

- Groups loaded from `group_registry` Supabase table (same as fb-group-poster.js).
- Keywords scanned: "transaction coordinator", "TC", "overwhelmed with paperwork",
  "looking for a TC", "my TC quit", "need help with my deals".
- Dedup file: `scripts/.fb-commenter-seen.json` (persists across runs).
- Sends TWO Telegram messages per match: context alert + APPROVE/SKIP buttons.
- 30-minute approval window; skips automatically on timeout.
- Requires: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_CHAT_ID`, `ANTHROPIC_API_KEY`.
- Run manually or on-demand (no cron — Vercel crons can't run local Playwright).

---

### instagram-engager.js
Like recent posts from target Texas RE influencer accounts. Comment on every
3rd post using Claude Haiku (2-4 words, genuine, no Dossie mention).

```
node scripts/instagram-engager.js
```

Target accounts: @ginger_unger_realestate, @miriahrealtor,
@robbieenglish_realestate, @hustlehumbly.

- Dedup file: `scripts/.instagram-seen.json`.
- Never follows or unfollows.
- Sends Telegram summary when done.
- Requires: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ANTHROPIC_API_KEY`.
- Recommended schedule: daily at 10 AM CST.
- Run via Windows Task Scheduler or manually:
  `node scripts/instagram-engager.js`

---

### linkedin-engager.js
Search LinkedIn for "Texas REALTOR transaction coordinator" and "Texas real
estate agent". Like top 5 posts per search. Comment on every other post
(1-2 sentence professional comment via Haiku, no Dossie mention).

```
node scripts/linkedin-engager.js
```

- Dedup file: `scripts/.linkedin-seen.json`.
- Never connects or follows.
- Sends Telegram summary when done.
- Requires: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ANTHROPIC_API_KEY`.
- Recommended schedule: weekdays at 9 AM CST.
- Run via Windows Task Scheduler or manually:
  `node scripts/linkedin-engager.js`

---

### fb-lead-scraper.js
Scan FB groups for agent posts mentioning TC overwhelm or need. Surface each
match as a Telegram warm-lead alert. Does NOT auto-comment or auto-DM.

```
node scripts/fb-lead-scraper.js
```

Keywords: "my TC", "transaction coordinator", "stressed", "overwhelmed with
paperwork", "juggling files", "need help with transactions", "looking for a TC".

- Dedup file: `scripts/.lead-scraper-seen.json`.
- Scans last 48 hours of posts per group.
- Telegram alert format: Name + Group + first 300 chars + URL + suggested action.
- Requires: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_CHAT_ID`.
- Recommended schedule: every 4 hours via Windows Task Scheduler.

---

### competitor-monitor.js
Check Facebook and Instagram pages for DealDock, ListedKit, and Done Deal TC.
Alert Heath via Telegram if any new post is found since the last run.

```
node scripts/competitor-monitor.js
```

- Dedup file: `scripts/.competitor-monitor-seen.json`.
- Checks up to 3 recent posts per platform per competitor.
- Telegram alert format: Brand + Platform + first 300 chars of post + URL.
- Requires: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- Recommended schedule: daily at 8 AM CST via Windows Task Scheduler.

---

## Windows Task Scheduler setup (for scripts that run on a schedule)

Since these Playwright scripts run locally (they need a real Chrome session),
Vercel crons cannot trigger them. Use Windows Task Scheduler instead.

1. Open Task Scheduler (search "Task Scheduler" in Start).
2. Click "Create Basic Task" in the right panel.
3. Name: e.g., "Dossie Instagram Engager"
4. Trigger: Daily / At a specific time.
5. Action: Start a program.
   - Program: `node`
   - Arguments: `scripts/instagram-engager.js`
   - Start in: `C:\Users\Heath Shepard\Desktop\MeetDossie`
6. Finish. Task will run even when terminal is closed.

Repeat for each script with the recommended schedule above.

---

## ZenRows Managed Scraping (for bot-protected public sites)

Tier 1 (stealth Playwright) fails against sites with aggressive bot detection
(realtor.com, Zillow, Homes.com). Tier 2 uses ZenRows, a managed proxy service
that handles Akamai and fingerprint detection automatically.

### Setup (one-time, ~2 minutes)

1. Sign up at https://www.zenrows.com/signup (free trial, no card required, 1,000 requests)
2. Copy your API key from the ZenRows dashboard
3. Add to Vercel environment: `ZENROWS_API_KEY=<your-key>`
4. Test: `node scripts/test-zenrows-realtor.js`

### When to use ZenRows vs DossieBot vs raw Playwright

| Target | Method | Why |
|--------|--------|-----|
| realtor.com, Zillow, Homes.com (public agent directories) | ZenRows | Bot detection (Akamai) |
| Facebook, Instagram, LinkedIn (logged-in actions) | DossieBot Chrome profile | Requires authentication |
| TREC Typesense, brokerage office pages (light bot detection) | Raw Playwright + stealth | Lower cost, sufficient for simple sites |

### Cost tracking

ZenRows free trial: **1,000 requests**. Premium proxy (enabled by default) uses ~10 credits per request.

- Test harness: 1 credit
- Realtor.com agent directory scrape: ~50-100 credits (5-10 pages)
- Single URL fetch: ~10 credits

Track credits via `getCostSummary()` in the wrapper:

```javascript
const { getCostSummary } = require('./_lib/zenrows-fetch');
const costs = getCostSummary();
console.log(`Credits used: ${costs.usedThisSession} / 1000`);
```

---

## Dedup files

The `.json` dedup files in `scripts/` are gitignored (or should be — add them
to `.gitignore` if not already present). They persist state between runs so
the same post is never re-processed. Delete them to start fresh.

Files:
- `scripts/.fb-commenter-seen.json`
- `scripts/.instagram-seen.json`
- `scripts/.linkedin-seen.json`
- `scripts/.lead-scraper-seen.json`
- `scripts/.competitor-monitor-seen.json`
