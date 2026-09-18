# Swipe-File Pipeline

Owner: Sage. Built 2026-09-18. Heath's answer to "how do we find great examples to emulate"
without him hand-sending links.

Finds ads and posts that are **demonstrably working** in our three markets, extracts the
structure, scores it against real evidence, and proposes new hooks for the bank in
`docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md` §2 — as candidates a human accepts, never as a
silent rewrite.

**Markets:**

| Key | Market |
|---|---|
| `tx_real_estate` | Texas real estate / realtor services |
| `tc_saas` | Transaction coordination + real-estate SaaS |
| `fitness_ai` | Fitness / AI coaching apps (Rust) |

---

## 1. What we take, and what we never take

**We study patterns and structures. We do not copy anyone's creative or claims.**

Take: the mechanism (what the opening line *does*), the beat order, the CTA *shape*, the
format and length, and the evidence that it's working.

Never take: their sentences, their paraphrased sentences, their statistics, their offer,
their brand names, their testimonials, or their footage. A hook we publish has to be true of
*us*, sourced from our own verified facts, and pass the swap test — if the line would be
equally true on a competitor's homepage, it isn't a hook, it's a category claim.

This is enforced in three places, not just stated here:

1. `sage_swipe_items` carries a DB CHECK (`sage_swipe_items_external_no_verbatim`) forbidding
   verbatim external copy. That table is what the **post generator** reads
   (`api/_lib/sage-external-patterns.js` → `api/cron-generate-posts.js`), so verbatim
   external text physically cannot reach generation.
2. `swipe_ads.full_copy` — the raw archive record — is for human study and pattern extraction
   only. **Nothing that generates a Dossie/Rust/realtor post may read `swipe_ads`.**
3. Every proposed hook runs through `api/_lib/fabrication-guard.js` before it is even written
   as a candidate.

### Never, under any circumstances

- **No Instagram or LinkedIn logged-in scraping.** Both are login-walled and automated
  collection is against their terms; doing it puts a real account at risk. Verified
  2026-09-18: a server-side fetch of an Instagram post URL returns HTTP 200 with a login wall
  and no post content. The supported path is the **browser extension** — Heath's own signed-in
  browser reading what is on screen for a human and handing the text back (§5). A person
  reading their own feed is not scraping. Do not "fix" this later with a session cookie.
- **No fabricated performance numbers.** If a source didn't publish a metric, we don't have
  one. `scripts/_lib/swipe-store.js` `scoreEvidence()` takes a typed evidence object and
  returns both the score *and* the sentence justifying it; "no evidence" scores 25 and says
  "no performance data available from this source — treat as unproven."

---

## 2. Sources — what actually works, verified

### Meta Ad Library — WORKS (public web surface) ✅

**Verified 2026-09-18** with a live run of `scripts/ad-library-scraper.js --terms "transaction
coordinator"`: returned real, currently-running US ads with advertiser name, full body copy,
CTA button, and Meta's own **"Started running on &lt;date&gt;"** line, across exactly our
markets (Top Tier TC, Tiffany Haynes, David Siddons Group, dozens of realtor pages).

That start date is the point. Meta publishes **no impressions and no spend for commercial
ads**, so run length is the only performance signal available — and it's a good one: nobody
keeps paying to run a loser. A 400-day ad is a proven ad.

**The official API is the wrong tool here, and it's important to know why.** The Graph
`ads_archive` endpoint requires a Meta developer app plus identity confirmation and acceptance
of the Ad Library API terms (~1-2 weeks' approval). Even after that, per Meta's own reference:

> "Ads that did not reach any location in the EU will only return if they are about social
> issues, elections or politics."

Our three markets are US commercial advertisers. **The API would return nothing for them.**
`ad_type` accepts `HOUSING_ADS`, `EMPLOYMENT_ADS` and `FINANCIAL_PRODUCTS_AND_SERVICES_ADS`
alongside `POLITICAL_AND_ISSUE_ADS`, but the EU-delivery rule above still gates them — we have
not been able to test this without a token, so treat "US housing ads via API" as **unverified,
probably unavailable**. Rate limit if we ever do get a token: ~200 calls/hour.

**Terms note, stated plainly:** the Ad Library is a public transparency archive Meta publishes
deliberately, and it is browsable without a login. Automated collection of it still runs
against Meta's general terms on automated data gathering. We run this at a low weekly volume,
from the public surface, with no login and no account at risk, for competitive research. That
is a judgment call, not a legal opinion, and it is the reason this collector stays weekly and
low-volume rather than becoming a continuous crawler. If Meta blocks it, we don't route around
the block — we stop.

- Collector: `scripts/swipe-collect-meta.js`
- Reuses the tested `parseAdsFromBodyText()` from `scripts/ad-library-scraper.js` (splits on
  the stable `Library ID:` marker rather than Meta's obfuscated CSS classes).
- Needs a real browser (Playwright), so it cannot run in a Vercel function — see §4.

### TikTok Creative Center — GATED ❌

**Verified 2026-09-18, does not work anonymously.** Every Creative Center data endpoint
(`/creative_radar_api/v1/top_ads/v2/list`, `/popular_trend/...`) returns
`{"code":40101,"msg":"no permission"}` with and without an anonymous session cookie, and the
Top Ads page itself server-renders `{"materials": []}` — the data loads client-side through
that gated API. There is no public API and no stable scrapeable structure without auth.

**What would unblock it:** a logged-in TikTok Ads Manager business account. With that, a
Playwright collector against the DossieBot Chrome profile could read Top Ads (which *does*
carry real CTR/CVR/impression bands per industry and region — the best performance data of any
of our three sources). That's a Heath decision, not a code problem. Until then this source is
documented and not built. **Do not add a TikTok collector that fakes headers to get past 40101.**

### YouTube Data API v3 — WORKS, needs one key 🔑

`search.list` + `videos.list` return title, description, tags, `publishedAt`, and **real
`viewCount` / `likeCount` / `commentCount`**. That makes it the only one of our three sources
with genuine engagement numbers.

**We do not have a key yet.** The endpoint is reachable and our parameters are accepted (a
keyless call returns `API_KEY_INVALID`, not a parameter error), but `YOUTUBE_API_KEY` is not in
Vercel or `.env.local`. `api/_lib/youtube-oauth.js` exists but is *upload-only* scaffolding and
`user_integrations` has **zero** `google_youtube` rows — so there is no existing YouTube
connection to borrow, despite the scaffolding. See §7 for the 2-minute fix.

**No transcripts.** `captions.download` only authorises the owner of a video, so there is no
supported way to pull a third party's transcript. We work from title + description + tags and
record that limitation on the row. Don't add a transcript scraper.

Quota: 10,000 units/day default. `search.list` costs 100 units, `videos.list` costs 1. A full
weekly run across all three markets is under 2,000 units.

- Collector: `scripts/swipe-collect-youtube.js` (exits 2 with setup instructions if the key is
  missing — that's expected, not a failure).

---

## 3. Storage

Migration: `supabase/migrations/20260918a_swipe_file_pipeline.sql`. All four tables are
RLS-enabled with no permissive policy — service-role code paths only, nothing customer-facing.

| Table | Holds |
|---|---|
| `swipe_ads` | The catch. source, source_ref (dedupe key), market, advertiser, creative_type, **hook_text**, **full_copy**, **cta_text**, link, run_started_on / run_ended_on / still_active, first_seen / last_seen, `evidence` jsonb + `evidence_kind`, raw. |
| `swipe_patterns` | One row per ad: hook_pattern, structure, cta_shape, hook_type, `evidence_score` (0-100), `evidence_basis` (the sentence justifying the score). |
| `swipe_hook_candidates` | Proposed playbook entries. status pending → accepted/rejected → merged. |
| `swipe_inbox` | Heath's pasted links + the browser-capture queue. |
| `swipe_digest_v` | View the Monday brief reads. Joins ads+patterns, computes `days_running`, flags `is_new_this_week`. |

**`days_running` is derived, never stored** (`public.swipe_ads_days_running()`), so nobody can
type an unbacked number into it. It is NULL when the source gave us no start date — which
scores as "run length unknown," not as zero.

Re-seeing an ad updates `last_seen` and never moves `first_seen`. That pair is how we watch an
ad's life without guessing at it.

---

## 4. Schedule — where it runs, and why not on a Vercel cron

`vercel.json` carries **99 cron entries against a hard cap of 100.** Nothing here takes a slot.

The Meta collector needs a real browser anyway, which a Vercel function cannot give it. So the
collectors ride the existing weekly dispatcher:

```
api/cron-competitor-scan-weekly.js   "0 1 * * 1"  (Sun 20:00 CDT)
  └─ enqueues task_type 'competitor_scan'   (pre-existing)
  └─ enqueues task_type 'swipe_collect'     (added 2026-09-18)
        └─ scripts/agent-queue-poller.js on Heath's PC spawns a session that runs:
              node scripts/swipe-collect-meta.js
              node scripts/swipe-collect-youtube.js
              node scripts/swipe-propose-hook-candidates.js
```

Same handoff pattern the competitor scan already uses. A failure in the swipe enqueue is
non-fatal and never fails the older, more important competitor scan on that schedule.

The **digest** rides `api/cron-morning-brief.js` (`0 12 * * *`) as one extra section that
renders **on Mondays only** — `api/_lib/swipe-digest.js` returns `''` every other day and on
any error, so the rest of the brief is byte-identical. One message, no new bot.

---

## 5. Manual swipe inbox — Heath pastes a link

```
node scripts/swipe-paste.js <url> --note "why this one"
node scripts/swipe-paste.js --pending
node scripts/swipe-paste.js --supply <inbox_id> --file captured.txt
```

Backed by `POST/GET/PATCH /api/swipe-ingest` (Bearer `CRON_SECRET`).

**Server-fetchable** (resolved immediately, analysed on the spot):
- YouTube — via the Data API when `YOUTUBE_API_KEY` is set (real view/like/comment counts), else
  via **oEmbed, which needs no key at all** (verified 2026-09-18) and returns title + channel.
  With oEmbed the row is filed `evidence_kind: 'none'` rather than pretending we have numbers.
- Any public web page — title, og:description, body text.
- A Meta Ad Library permalink (thin, because it renders client-side; the Playwright collector
  is the real path for those).

**Not server-fetchable** → parks at `status='needs_capture'`:
- Instagram, LinkedIn, TikTok, Facebook post URLs.

### The browser path (this is how the Instagram link Heath sent gets handled)

`scripts/swipe-paste.js --pending` prints what's waiting. In the Chrome extension session
(see `extension-bridge-standing-prompt` in memory for the standing loop), the instruction is:

> EXTENSION: open &lt;url&gt;. Read the visible post text — caption, on-screen text, the CTA,
> and any like/comment counts *shown on the page*. Report it back starting with `EXT:`. Do not
> log into anything you are not already logged into, and do not use any API.

Claude Code writes that text to a file and runs `--supply <id> --file <path>`. From there it
goes through exactly the same ingest pipe as a collector-found ad: market classified, pattern
extracted, evidence scored, mirrored into `sage_swipe_items`.

Counts the extension actually **read off the page** can be passed as
`evidence: { kind: 'source_reported', score, basis }`. Nothing else may set a number.

---

## 6. Scoring, and how a pattern reaches the hook bank

`scoreEvidence()` in `scripts/_lib/swipe-store.js`, 0-100:

| Evidence kind | How it scores |
|---|---|
| `ad_longevity` | `30 + 65·(1−e^(−days/130))`, capped 95. 30d ≈ 55, 90d ≈ 72, 180d ≈ 83, 365d ≈ 92. Deliberately steep early and flat late: 90 days of continuous spend already clears the "this converts" bar, and 400 days is not four times better evidence than 100. |
| `youtube_engagement` | Engagement **rate** `(likes + 3·comments) / views`, with a 1,000-view floor so a 12-view video with 3 likes can't outrank a real hit. Absolute views mostly measure channel size. |
| `source_reported` | Whatever the source published, with its basis recorded. |
| `none` | 25, flat, and `evidence_basis` says "treat as unproven." |

`evidence_basis` is stored verbatim on every pattern so the number can always be challenged.

### The path to the playbook

```
swipe_patterns (evidence_score ≥ 55)
  └─ scripts/swipe-propose-hook-candidates.js
       writes swipe_hook_candidates, status='pending'
       — content drawn ONLY from the verified-fact block in that script
       — rejected outright by api/_lib/fabrication-guard.js if it invents anything
  └─ Monday brief lists them
  └─ Heath: node scripts/swipe-merge-hook-candidates.js --list
            node scripts/swipe-merge-hook-candidates.js --accept <uuid>
            node scripts/swipe-merge-hook-candidates.js --reject <uuid> --reason "..."
  └─ node scripts/swipe-merge-hook-candidates.js
       appends accepted entries INSIDE the
       <!-- SWIPE-CANDIDATES:BEGIN/END --> block in
       docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md §2, marks them 'merged'
```

The merge script only ever **appends inside that block** and never rewrites what's already
there, so hand edits survive. If the block is missing it refuses and exits rather than guessing
where to put things. **Nothing else in this pipeline may write to the playbook.**

Separately, every transferable pattern is mirrored into `sage_swipe_items` (pattern-level, no
verbatim copy) so `api/_lib/sage-external-patterns.js` can feed it into post generation — that
bridge is already built and currently dormant pending Heath's go-ahead.

---

## 7. What Heath has to do

| # | Action | Time | Unblocks |
|---|---|---|---|
| 1 | Apply `supabase/migrations/20260918a_swipe_file_pipeline.sql` | 1 min | Everything |
| 2 | **`YOUTUBE_API_KEY`** — console.cloud.google.com, the *existing* project that already holds `GOOGLE_CLIENT_ID` → APIs & Services → Library → "YouTube Data API v3" → Enable → Credentials → Create credentials → API key. Add to Vercel (Prod+Preview) and `.env.local`. No OAuth consent screen needed for public search. | 2 min | The only source with real engagement numbers |
| 3 | *Optional:* TikTok Ads Manager business account, logged into the DossieBot Chrome profile | — | TikTok Creative Center (best performance data of the three) |
| 4 | *Optional, low value:* Meta developer app + identity confirmation (~1-2 weeks) | — | Probably nothing for US markets — see §2 |

Nothing here needs a Meta API key. The Meta collector works today.
