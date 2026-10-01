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

## Accounts browser profile (Heath's personal financial/service logins)

Dedicated Chrome profile for Heath's personal accounts — RBFCU, Toyota
Financial, Allstate, USAA, and similar — so Cole/Atlas can check or operate
these logins the same way the Brokerage persona already operates
connectMLS/zipForm. Lives at `scripts/_lib/accounts-browser.js`.

**Profile directory:** `C:\Users\Heath\.accounts-browser-profile` (override
with `ACCOUNTS_PROFILE_DIR`). This is a brand-new, dedicated profile — it
must never collide with any of:
- `~/.brokerage-browser-profile` (Brokerage persona — connectMLS/zipForm)
- `.brokerage-command-profile` (Brokerage CDP-attach flows)
- the DossieBot-Sage profile (`AppData\Local\DossieBot-Sage` — FB/IG/LinkedIn)
- the shared MCP `playwright` server's profile (`.jarvis-browser-profile`)

**Who may use it:** any agent operating Heath's personal financial/service
accounts on his behalf (Atlas built it; Cole dispatches work against it).
Not for Dossie product work, not for marketing/social automation — those
have their own profiles above.

**One holder at a time — same rule as every other profile here.** Chrome's
ProcessSingleton lock means only one Playwright context may have this
profile directory open at once. `launchAccountsContext()` waits
cooperatively for a live holder to release (via the shared
`chrome-profile-unlock.js` helper) rather than killing it — never pass
`forceUnlock` unless you are deliberately reclaiming the profile from a job
you know is dead. **Always close the context when done**
(`await context.close()`) — an unclosed context blocks every subsequent
script, including your own next run.

**WSL note:** real Chrome does not exist under WSL (`channel: 'chrome'`
resolves to a Linux path that isn't there — this is the same failure the
shared MCP playwright server hits). `accounts-browser.js` detects WSL and
re-execs the calling script through the real Windows `node.exe`
automatically; callers don't need to do anything special, but output will
show a one-line `[accounts-browser] WSL detected — ...` notice first. This
mirrors `scripts/_lib/brokerage-browser.js`'s existing WSL guard. Verified
working 2026-10-01: `node scripts/accounts-login.js rbfcu` launches a real
Windows Chrome window, lands on `https://www.rbfcu.org/`, and closes
cleanly.

**Scripts:**
- `scripts/accounts-login.js <url-or-site-key>` — one-time interactive
  login. Opens the site headful in the Accounts profile, waits for Heath to
  log in by hand (password, 2FA, everything), then closes on Enter so the
  session persists to disk. Known keys: `rbfcu`, `toyota`, `allstate`,
  `usaa`. Anything else is treated as a URL.
- `scripts/accounts-session-check.js` — read-only. Opens each known site
  headless and reports SIGNED IN / SIGNED OUT / ERROR with the evidence used
  (final URL + whether a login redirect or password field was found). Never
  logs a credential or cookie value.

**No `storageState`, ever.** `accounts-browser.js` does not accept a
`storageState` option at all (brokerage-browser.js's own attempt at this
corrupted a live persistent profile's cookies and was reverted 2026-09-10 —
see that file's header comment). The persistent profile directory is the
only session-persistence mechanism for Accounts.

**No secrets in any script here.** Login is always typed by Heath's own
hands in the headful window — nothing in this repo reads, stores, or logs a
password, PIN, security answer, or OTP for these accounts. This is a PUBLIC
repo.

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
