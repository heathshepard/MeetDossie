# Social Media Pipeline

## Social posting (code = source of truth)

1. `cron-generate-posts` 11AM UTC — 6 posts via Sonnet 4.6, upsert `on_conflict=post_id`, resets `telegram_sent_at`, renders cards via HCTI (IG+FB), stores `card_body` (50w max) + `caption` separately.
2. `cron-send-for-approval` 11:30 UTC — drafts where `status='draft'` AND `telegram_sent_at IS NULL`. Sends 2 messages to DossieMarketingBot: (1) card image, no buttons; (2) full caption+hashtags with Approve/Reject/Edit.
3. `cron-publish-approved` every 30min — `status='approved'` → Zernio (FB/Twitter/IG/LinkedIn/TikTok). Twitter splits to max 6 chunks paragraph-first. Sets `posted` or `failed`.

---

## CONTENT RULES — NON-NEGOTIABLE

**Persona voice:** all content in **third person** — never first-person "I". Brenda=she/her, Patricia=she/her, Victor=he/him. WRONG "I closed 6 deals." RIGHT "She closed 6 deals."

**Field constraints:** `card_body` max 50w (card only); `caption` full text; `stat` max 10 chars ("$8,000","80+"); `stat_label` max 50 chars; `hook` max 8 words, pattern-interrupting.

**Text encoding:** ASCII only — no em-dashes (—), en-dashes (–), curly quotes, special Unicode. Plain hyphens + straight quotes. HCTI + Telegram require this.

---

## CONTENT FUEL — real-language inputs to the generation prompt

`cron-generate-posts.js` injects three prompt blocks ahead of the topic brief,
each fed by real data and each failing gracefully to `''` when its source is
empty:

- `buildSageIntelligenceBlock()` — last 14 days of `post_analytics`, written by
  `cron-sage-intelligence.js`.
- `buildTopPerformerBlock()` — top 5 real hooks by `engagement_score` from
  `post_analytics`.
- `buildRedditPainLanguageBlock()` — real pain-language from
  `reddit_pain_language`, kept fresh by `scripts/reddit-pain-scraper.js`
  (r/realtors, r/RealEstateAgents, r/RealEstateAdvice via Reddit's public RSS
  feeds — no auth, but Reddit rate-limits/blocks bursty requests from
  datacenter IPs, so run this from Heath's machine on a schedule, same as
  `reddit-scanner.js`/`reddit-fetch-new.js`, not from a cloud sandbox).

`scripts/ad-library-scraper.js` (real competitor Ad Library scrape, proven
working) still has its `buildContentFuelBlock()` output NOT wired into the
prompt — that splice is the next piece to land alongside these three.

## HOOK-VARIANT TESTING

- `social_posts.hook_variant` — free-text label for an explicit multi-variant
  test (e.g. `"cost_focus"`, `"urgency_open"`), distinct from `variant`
  (just the A/B/C/... letter).
- `POST /api/sage-ab-test?source_id=<id>&variant_count=<2-6>` — generates a
  cohort of hook variants off one source post, each with its own
  `hook_variant` label, staggered 24h apart, same `ab_test_group_id`.
- `cron-analytics-sync.js` copies `hook`, `hook_type`, `cta_type`, and
  `hook_variant` from `social_posts` into `post_analytics` at sync time
  (fixed 2026-08-18 — the columns existed since 2026-07-08 but the sync
  query never selected them, so they were always `NULL`), then flags
  `ab_test_winner=true` on the highest-scoring variant once **every** member
  of the `ab_test_group_id` has posted (or terminally failed/rejected) —
  waits for the full cohort, not just any 2 that happen to be 72h old.
- `cron-weekly-post-review.js` / `sage_weekly_review.js` already bucket by
  `hook_variant` — that report only had real data starting 2026-08-18.

---

## KNOWN ISSUES / WATCH LIST

- TikTok posts sit as `pending_video` — video pipeline separate (inactive until ~May 20).
- FB hashtags inconsistent — check AI prompt if missing.
- Founding spot count = `subscriptions` where `status='active'` AND `plan='founding'`.
- HCTI free 50/mo — monitor; upgrade $14/mo at 1k.

---

## SOCIAL MEDIA ACCOUNTS

| Platform | Handle | Zernio status |
|---|---|---|
| Facebook Page | MeetDossie | ✅ connected |
| Instagram | @meetdossie | ✅ connected |
| Twitter / X | @meetdossie | ✅ connected |
| TikTok | @meetdossietc | ✅ connected ✅ active (live since 2026-05-08) |
| Threads | @meetdossie | not automated |
| LinkedIn | linkedin.com/company/meetdossie | ✅ connected ✅ active (live since 2026-05-07) |

**Heath's personal realtor accounts — "Brokerage" Zernio profile** (Heath
created 2026-08-18, separate from "Default" which holds MeetDossie's
connections; profile id `6a8469b3a307bfe9b1958bc4`). Three destinations
connected directly by Heath in Zernio's dashboard, confirmed live via
`GET /v1/accounts` (`api/debug-zernio-accounts.js`):

- **Facebook** — facebook.com/HeathShepardRealtor, dedicated `zernio_account_id`
  `6a8469f177555aae01775798`. Supersedes the earlier workaround where this
  Page rode MeetDossie's shared connection disambiguated by `page_id` (see
  `20260817_zernio_accounts_owner.sql` / `20260818_zernio_accounts_page_id.sql`
  for that history). Now routed through its own dedicated connection —
  `page_id 102113502016276` is left populated as a harmless belt-and-suspenders
  pin, not a disambiguation requirement. Migrated via
  `20260818b_zernio_accounts_brokerage_profile.sql`.
- **Instagram** — @heathshepardrealtor, `zernio_account_id`
  `6a8469d677555aae017735a1`. First Instagram destination beyond
  `@meetdossie`; `owner`/routing pattern extends with no schema gap (partial
  unique index is already `(platform, owner) WHERE is_active`).
- **YouTube** — "Shepard Real Estate Solutions" channel, `zernio_account_id`
  `6a846a0c77555aae017776e3`. Connected and available — **no posting logic
  wired, no content plan yet.** Not inserted into `zernio_accounts`; noted
  here for when there's a reason to route to it.
- (A fourth destination, `metaads` `6a846a2f77555aae01778a01`, also lives
  under this profile — not social posting, out of scope.)

Both `owner='heath-realtor'` rows are read by `cron-publish-approved.js`
`pushToZernio()` via `social_posts.target_owner`. Weekly posting cadence
(when there's content) is drafted in `docs/REALTOR-PAGE-CADENCE.md`.

---

## ZERNIO ACCOUNT IDs

**MeetDossie ("Default" profile, `owner='dossie'`)**

| Platform | Account ID | Active |
|---|---|---|
| facebook | `69f253c3985e734bf3d8f9bc` | ✅ |
| instagram | `69f25431985e734bf3d8fcbe` | ✅ |
| twitter | `69f255c6985e734bf3d90ba1` | ✅ |
| linkedin | `69fccd7392b3d8e85f8f12be` | ✅ (URN `urn:li:organization:115997183`) |
| tiktok | `69f15791985e734bf3d13b89` | ✅ |

**Heath's realtor accounts ("Brokerage" profile, `owner='heath-realtor'`)**

| Platform | Account ID | Active |
|---|---|---|
| facebook | `6a8469f177555aae01775798` | ✅ (in `zernio_accounts`) |
| instagram | `6a8469d677555aae017735a1` | ✅ (in `zernio_accounts`) |
| youtube | `6a846a0c77555aae017776e3` | connected, not wired — no content plan |

---

## FACEBOOK GROUP ENGAGEMENT PIPELINE (read-only scan -> draft -> Heath approves)

Separate from the Zernio auto-post pipeline above. This is DossieBot's Chrome
profile scanning real FB groups for genuine engagement opportunities (TC-pain
posts, real-estate-practice questions) and drafting a reply — never auto-posts.

1. `scripts/fb-group-discovery.js` — one-off/periodic. Searches FB's own group
   search across a broad query set (statewide, TREC, TC-specific, hyperlocal
   metro+county, brokerage-specific, mastermind/networking), verifies each
   candidate (real navigation, member count 300-300k, Public group), dedupes
   against `group_registry`, inserts survivors. Never posts/joins/comments.
2. `scripts/fb-engagement-scraper.js` — the daily driver. Loads groups from
   `group_registry` (oldest-scanned-first), extracts BEFORE each scroll step
   (FB virtualizes content that scrolls out of view — extracting only once at
   the end silently loses text), matches TC-pain + genuine-practice-question
   patterns, drafts a reply via Sonnet in Heath's voice, inserts into
   `engagement_queue` at `status='pending_review'`.
3. `api/cron-engagement-review.js` surfaces `engagement_queue` pending rows to
   Heath via Telegram for approve/reject.

### Anti-ban pacing — `scripts/_lib/scan-caps.js` (scanning) + `scripts/_lib/comment-caps.js` (posting/commenting)

Two separate ceilings because they're different actions from FB's side:

**Scanning (read-only page visits)** — `scan-caps.js`, state in
`scripts/.scan-caps-state.json` (local file, no DB migration needed):
- **25 group pages/day**, hard cap, shared across `fb-engagement-scraper.js`
  and `fb-group-discovery.js` combined. Reasoning: a genuinely active solo
  agent might browse 15-25 groups in a day hunting for something specific —
  that's the plausible human ceiling this should look like from FB's side.
- Randomized dwell between group-to-group navigations (2.5-6s) and between
  scroll steps within a page (1.4-3.2s) — no mechanical/metronomic interval.

**Posting/commenting** — `comment-caps.js` (existing, Heath-approved
2026-06-10, tightened post-shadowban 2026-07-01):
- Facebook 5/day, Instagram 5/day, LinkedIn 3/day, Reddit 3/day, Twitter
  5/day. **21/day hard ceiling across all platforms combined.**
- Min gap between comments: FB 45min, IG 20min, Twitter 45min, LinkedIn
  90min, Reddit 60min.
- 1 comment per thread (2 if the thread @-mentions Dossie/Heath), 7-day
  cooldown before commenting on the same author again, 80-char substance
  floor on any drafted comment.
- **`engagement_queue` backlog building (fb-engagement-scraper.js runs) is
  NOT gated by comment-caps** — that cap only fires at actual-post time.
  Building a large reviewable backlog is fine; the ceiling is on what
  actually goes out to FB in a day, not on how much sits in the queue
  waiting for Heath's approval.
