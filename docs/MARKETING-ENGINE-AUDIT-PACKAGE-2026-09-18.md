# Marketing Engine — Audit Package for External Review
**Generated:** 2026-09-18 · **Repos:** `C:\Users\Heath\Projects\MeetDossie`, `C:\Users\Heath\Projects\Rust`
**Reference branch:** `main` @ `b53761f9` (2026-09-17 20:11 CDT) — this is what production runs.

**Reader note on provenance.** Every path, number, threshold and quote below was read out of the repo,
the live Supabase project (`pgwoitbdiyubjugwufhk`), or Windows Task Scheduler on 2026-09-18. Where a
claim could not be substantiated, it says so. Two premises given to the auditor were wrong and are
corrected in place: the local tick runs every **15** minutes (not 30), and the "13 silently muted jobs"
figure is **not written down anywhere** — the verifiable number is 6 (§10.1).

---

## 1. Architecture overview

### 1.1 Three brands, two repos, one Supabase

| Brand | `target_owner` | What it is | Live destinations |
|---|---|---|---|
| **Dossie** | `dossie` | TC (transaction-coordination) software for Texas REALTORS. $149/mo Solo, $349/mo Team. 8 founding customers at $29/mo, closed permanently 2026-08-04. | Facebook, Instagram, X, LinkedIn, TikTok, YouTube (Zernio) |
| **Heath's realtor page** | `heath-realtor` | Heath Shepard, REALTOR® — Keller Williams City View, San Antonio/Boerne, TX Lic #751964. | Facebook (`HeathShepardRealtor`), Instagram (`@heathshepardrealtor`), YouTube ("Shepard Real Estate Solutions") |
| **Rust** | `rust` | AI fitness coaching app, pre-launch. $19.99/mo. ~5 users, all friends Heath texted. | **None.** No social accounts, no domain. |

**Repos.** `MeetDossie` holds the Vercel deploy, every `api/cron-*.js`, every `scripts/*` automation,
and the `Media/` library (gitignored). `Rust` is a separate Vite/Capacitor app on its **own** Supabase
project (`aflqnvlhpkbokfneyhqh`) — `api/_lib/attribution.js` explicitly cannot see it and returns
`supported:false` rather than a fabricated zero.

### 1.2 Where things run

```
                        ┌──────────────────────────────────────────────┐
                        │  VERCEL (meetdossie.com) — serverless         │
                        │  54 vercel.json cron entries, HARD cap 100    │
                        │                                               │
   Vercel Cron ────────▶│  16 dispatcher routes (cron-dispatch-*.js)    │
   (x-vercel-cron: 1)   │    └─ api/_lib/cron-multiplex.js              │
                        │         runGroup() → Promise.all over N       │
                        │         real job modules, in-process          │
                        │  + 38 standalone cron routes                  │
                        │                                               │
                        │  NO ffmpeg. NO browser. NO Playwright.        │
                        └───────┬──────────────────────────┬────────────┘
                                │                          │
                                ▼                          ▼
                    ┌───────────────────────┐   ┌────────────────────────┐
                    │ SUPABASE (Postgres)   │   │ ZERNIO ($18/mo)        │
                    │ social_posts          │   │ POST zernio.com/api/   │
                    │ video_library         │◀──┤   v1/posts             │
                    │ post_analytics        │   │ fans out to FB/IG/X/   │
                    │ posting_schedule      │   │ LI/TikTok/YouTube      │
                    │ comment_opportunities │   └────────────────────────┘
                    │ tc_discovery_responses│
                    │ group_posts           │            ▲
                    │ ops_flags             │            │
                    │ alert_state           │            │
                    │ comment_caps_state    │            │
                    └───────────┬───────────┘            │
                                │                        │
                                ▼                        │
        ┌───────────────────────────────────────────┐    │
        │ WINDOWS TASK SCHEDULER (Heath's PC)       │    │
        │ "Dossie TC Discovery Harvest" — every 15m │    │
        │   → MeetDossie-scheduler\scripts\         │    │
        │     tc-discovery-harvest-hidden.vbs       │    │
        │     → run-tc-discovery-harvest.cmd        │────┘  (Playwright posts
        │       Steps 1..11 (§1.3)                  │        directly to FB/LI
        │                                           │        as Heath, NOT via
        │ ffmpeg · Playwright · real Chrome profile │        Zernio)
        │ (DossieBot-Sage = Heath's PERSONAL FB)    │
        └───────────────────┬───────────────────────┘
                            │
                            ▼
              ┌──────────────────────────────┐
              │ TELEGRAM — DossieMarketingBot│
              │ Approve / Edit / Skip / STOP │
              │ gated by api/_lib/           │
              │   telegram-gate.js           │
              └──────────────────────────────┘
```

**Why the split is not arbitrary** (`scripts/daily-video-supply.js`, verbatim):

> It cannot be a Vercel cron for three independent reasons, any one of which is fatal:
>   1. Vercel serverless has no ffmpeg (api/cron-render-videos.js says so in its own header) and both formats end in an ffmpeg composite.
>   2. D1's source material is a Playwright screenshot loop against the live app; R1's is a connectMLS session in real Chrome. Neither exists in a serverless sandbox.
>   3. vercel.json is at 54/100 cron entries and the cap is HARD at 100 on every plan.

**The scheduler checkout.** Task Scheduler runs a *second* clone at
`C:\Users\Heath\Projects\MeetDossie-scheduler`, pinned to `main` and `git reset --hard origin/main`
before every run, because the dev tree hops branches all day. From `docs/SCHEDULER-CHECKOUT.md`:

> Three times in one day a merged fix to a scheduled script did nothing because the scheduler was still executing the pre-merge version.

### 1.3 The local tick — 11 steps

Entry: `scripts/run-tc-discovery-harvest.cmd`. **Actual cadence: every 15 minutes**, verified via
`schtasks /query /tn "Dossie TC Discovery Harvest" /v` → `Repeat: Every: 0 Hour(s), 15 Minute(s)`.
Several code comments still call it "the 30-min tick"; they are stale. Most steps self-gate and exit
in ~2s without launching Chrome.

| Step | Script | What it does |
|---|---|---|
| 1 | `harvest-tc-discovery-responses.js` | Harvests new comments on Heath's own campaign posts. Self-gates: every 45 min in the first 48h after a post, every 3 days after. |
| 2 | `watch-guest-thread-replies.js` | Watches threads where Heath commented on *other people's* posts (`comment_watchlist`) for replies to him. |
| 3 | `fb-group-commenter.js --tc-reply-queue` | Posts Heath-APPROVED threaded replies. Budget `facebook_reply` 10/day, 30-min min-gap. Also runs a pure-DB check first: any approved reply unposted >60 min → Telegram alert (the 1-hour reply SLA), deduped ~hourly. |
| 4 | `fb-comment-hunt-daily.js` | Daily comment-opportunity hunt (once/day). Re-verifies recent posted comments first — **a removed comment halts the whole pipeline**. |
| 5 | `fb-comment-opp-poster.js` | Posts approved comment opportunities. At most ONE per tick, `facebook_auto` 8/day, 45–60 min varied spacing, verify-by-re-render, registers the thread in `comment_watchlist`. |
| 6 | `fb-group5-post-queue.js` | Posts approved daily-5-group posts. ONE per tick, `facebook_group_post` 5/day (1 per target group), 18–24 min varied spacing. Shares Step 5's circuit breaker — one FB profile. |
| 7 | `linkedin-engager.js --post-approved --warm-touch-only` | Posts approved `linkedin_personal` posts in Heath's own voice. ONE per calendar day. Added 2026-09-09 after **18 posts sat approved with zero scheduled trigger anywhere**. |
| 8 | `fb-listing-group-post-queue.js` | Posts approved listing-group posts. ONE per tick, `facebook_group_post_listing` 3/day, 30–40 min spacing. |
| 9 | `listing-marketing-generate-live.js` | Once/day live connectMLS read **and** generation in one process. The only safe generator for Heath's listing posts — `api/cron-daily-listing-posts.js` was disabled 2026-09-11 after advertising 23 Nopalito at a stale $1,195,000 against a live $999,000. On a dead session it generates **zero** posts and alerts; never falls back to cached data. |
| 10 | `detect-scheduled-script-drift.js` | Follows every scheduled task's real invocation graph (incl. `require()`'d libs no `.cmd` names), diffs the local working tree against `origin/main`, alerts only on a locally-CLEAN file that has diverged. Detect-and-report only; never checks out/stashes/resets. |
| 11 | `run-daily-video-supply.cmd` → WSL → `daily-video-supply.js` | THE SUPPLY LOOP. Picks ONE video format for the day by starvation score against each format's remaining runway, renders it, runs the quality gate, queues into `video_library` at `status='approved'`. **Publishes nothing.** Self-gates once/calendar-day, so 95 of every 96 ticks exit in ~1s. A day that produces nothing alerts Heath (deduped ~20h via `alert_state`). |

---

## 2. Scheduled jobs

### 2.1 `vercel.json` — 54 cron entries on `main`

Vercel's schema caps the `crons` array at **100** and rejects the deploy outright above it. That cap
was hit on 2026-09-16 (101 entries, deploy `167cb30a` rejected), which is why `api/_lib/cron-multiplex.js`
and the 16 dispatchers exist. Only jobs with **byte-identical** schedule strings are grouped, so
cadence is preserved exactly.

**38 standalone entries:**

| Schedule | Route |
|---|---|
| `0 9 * * 1` | `/api/cron-weekly-content-scheduler` |
| `10 11 * * *` | `/api/cron-render-videos` |
| `30 11 * * *` | `/api/cron-send-to-sage` |
| `0 7 * * *` | `/api/cron-heath-publish-digest` |
| `0 14 * * 1-5` | `/api/cron-content-brief` |
| `5 13 * * *` | `/api/cron-deadline-reminders` |
| `15 13 * * *` | `/api/cron-mls-status-staleness` |
| `20 13 * * *` | `/api/cron-financial-sanity` |
| `0 21 * * 4` | `/api/cron-newsletter-draft-reminder` |
| `0 2 * * 0` | `/api/cron-analytics-sync` |
| `45 * * * *` | `/api/cron-verify-posts` |
| `0 13,17,21,1 * * *` | `/api/cron-reddit-scanner` |
| `0 3 * * *` | `/api/cron-daily-platform-health` |
| `0 14 * * 0` | `/api/cron-competitor-intel` |
| `0 12 * * 1` | `/api/cron-competitor-monitor` |
| `0 14-23/2 * * *` | `/api/cron-platform-health-checker` |
| `0 6 * * *` | `/api/cron-pull-post-analytics` |
| `0 2 * * *` | `/api/cron-daily-debrief` |
| `10 */6 * * *` | `/api/cron-fanout-builds-to-agent-queues` |
| `*/2 * * * *` | `/api/cron-agent-queue-dispatch` |
| `7 * * * *` | `/api/cron-inbox-scan` |
| `17 * * * *` | `/api/cron-apply-approved-improvements` |
| `0 22 * * 5` | `/api/cron-friday-action-summary` |
| `0 12 * * 1-5` | `/api/cron-warm-touch-populate` |
| `0 12,15,18,23 * * *` | `/api/cron-social-cadence` |
| `0 1 * * 1` | `/api/cron-competitor-scan-weekly` |
| `0 13 * * 5` | `/api/cron-heath-cameo-reminder` |
| `0 */4 * * *` | `/api/cron-ridge-watchdog` |
| `0 5 * * *` | `/api/cron-stripe-reconcile` |
| `30 4 * * *` | `/api/cron-storage-retention` |
| `0 11 * * 1-5` | `/api/cron-generate-heath-linkedin` |
| `0 11 * * 1` | `/api/cron-monday-digest-1100` |
| `0 13 * * 1` | `/api/cron-monday-digest-1300` |
| `0 14 * * 1` | `/api/cron-monday-digest-1400` |
| `15 14 * * *` | `/api/cron-request-testimonial-draft` |
| `45 15 * * *` | `/api/cron-request-zillow-review-prompt` |
| `0 23 * * 0` | `/api/cron-weekly-batch-digest` |
| `20 15 * * *` | `/api/cron-silence-alarm` |

**16 dispatchers and their members** (from each `api/cron-dispatch-*.js`'s `HANDLERS` array):

| Dispatcher | Schedule | maxDuration | Members |
|---|---|---|---|
| `cron-dispatch-every5` | `*/5 * * * *` | 70s | alert-health · cron-pc-heartbeat-check · cron-staging-watcher · cron-send-outbound-emails · cron-agent-queue-tick · cron-auto-reply-veto-check |
| `cron-dispatch-every10` | `*/10 * * * *` | 60s | cron-auto-approve · cron-assemble-skits · cron-tc-reply-approval |
| `cron-dispatch-every15` | `*/15 * * * *` | 40s | cron-followup-check · cron-send-engagement-approvals · cron-relevance-watcher · cron-email-to-dossier · cron-esign-events · cron-merge-queue-backfill · cron-comment-monitor |
| `cron-dispatch-every20` | `*/20 * * * *` | 300s | cron-dossie-sign-completion-loop · cron-content-pipeline-review · cron-engagement-review · cron-content-pipeline-promote |
| `cron-dispatch-every30` | `*/30 * * * *` | 70s | **cron-publish-approved** · cron-verify-zernio-deliveries · cron-agent-queue-orphan-reset · cron-sage-draft-engagements · cron-showingtime-feedback · cron-support-ticket-alert · cron-comment-opp-approval · cron-retry-unsent-approvals |
| `cron-dispatch-hourly` | `0 * * * *` | 70s | cron-mission-watchdog · cron-unsubscribe-spike-monitor |
| `cron-dispatch-every6h` | `0 */6 * * *` | 130s | cron-account-session-monitor · cron-reconcile-future-builds · cron-codebase-facts-indexer |
| `cron-dispatch-daily-0800` | `0 8 * * *` | 70s | cron-affiliate-qualify-referrals · cron-trec-scanner |
| `cron-dispatch-daily-0900` | `0 9 * * *` | 130s | cron-regression-suite · cron-daily-group5-posts |
| `cron-dispatch-daily-1000` | `0 10 * * *` | 300s | cron-video-approval · cron-cron-fire-verifier · cron-dossie-full-diagnostic · cron-self-improvement-daily · cron-trending-audio-scan |
| `cron-dispatch-daily-1100` | `0 11 * * *` | 300s | cron-pipeline-check · **cron-generate-posts** · cron-kpi-drift-detector · cron-autonomous-loop · cron-autonomous-daily-digest |
| `cron-dispatch-daily-1200` | `0 12 * * *` | 20s | cron-followup · cron-morning-brief · cron-customer-morning-brief · cron-social-digest |
| `cron-dispatch-daily-1300` | `0 13 * * *` | 40s | cron-calculator-deadline-reminders · cron-email-digest · cron-pipeline-health · cron-render-skits · cron-morning-ops-digest |
| `cron-dispatch-daily-1330` | `30 13 * * *` | 20s | **cron-post-videos** · cron-deletion-reminders |
| `cron-dispatch-daily-1400` | `0 14 * * *` | 20s | cron-elevenlabs-monitor · cron-testimonial-request |
| `cron-dispatch-daily-1500` | `0 15 * * *` | 70s | cron-activation-drip · cron-stale-action-escalation · cron-testimonial-nudge |

Dispatcher auth (`cron-multiplex.js`) is two-layer: a top-level `isAuthorizedDispatch()` returning 401
with zero sub-jobs invoked, plus each sub-job's own unchanged `x-vercel-cron` / `Bearer CRON_SECRET`
check. The top-level gate was added 2026-09-16 after QA found an unauthenticated probe returned 207 —
no side effects ran, but it was a free way to fan out to and hammer every handler on demand.

### 2.2 Windows Scheduled Tasks (live, `schtasks /query /v`, 2026-09-18)

| Task | Trigger | Runs | Status / last result |
|---|---|---|---|
| `Dossie TC Discovery Harvest` | Daily 00:00, **repeat every 15 min** | `wscript.exe MeetDossie-scheduler\scripts\tc-discovery-harvest-hidden.vbs` → the 11-step tick | Ready · last 2026-09-18 21:45 · result **0** |
| `Dossie-MLS-KeepAlive` | One-time + repeat every **8h** | `MeetDossie\scripts\brokerage-mls-keepalive.cmd` | Ready · last 2026-09-18 19:57 · result **1 (failing)** |
| `AgentQueuePoller` | At logon + at startup | `MeetDossie\scripts\agent-queue-poller-hidden.ps1` | Running |
| `ClaudeCodeWorker` | At logon | `MeetDossie\scripts\claude-code-worker-hidden.ps1` | Running |
| `ColeClaudeCodeSession` | At logon + at startup | `MeetDossie\scripts\cole-session-hidden.ps1` | Running |
| `JarvisBridgeWatchdog` | At logon | `MeetDossie-scheduler\scripts\jarvis-bridge\watchdog.ps1` | Ready · last 2026-09-16 |
| `SmsPoller` | At logon | `MeetDossie\scripts\sms-poller-hidden.vbs` | Running |

Only the first two are marketing-relevant. The last three deliberately stay pointed at the **dev tree**
(they run Claude Code against Heath's live WIP; repointing them would hard-reset the tree they operate
on). `brokerage-mls-keepalive.cmd` and `sms-poller-hidden.vbs` are **not tracked in git at all** — a
clean checkout of `origin/main` doesn't contain them, which is a named, unclosed gap in
`docs/SCHEDULER-CHECKOUT.md`.

---

## 3. Content generation

### 3.1 Text posts — `api/cron-generate-posts.js` (2,025 lines)

Runs 11:00 UTC daily inside `cron-dispatch-daily-1100`, `maxDuration: 300`. Generates **6 posts/day**
(was 9; Instagram and TikTok slots removed 2026-09-15) in **Dossie brand voice only**. Model:
`claude-sonnet-5`. Verifier: `claude-haiku-4-5-20251001`.

**Personas are dead but the code still carries them.** `PERSONAS` (Brenda / Patricia / Victor) is still
defined, and `BRAND_VOICE_FORMATS_ENFORCED` exists specifically because Sonnet keeps trying to emit
them anyway:

```js
// Currently-accepted, non-retired formats. PERSONA_STORY (Brenda/Patricia/
// Victor) was retired 2026-06-14 (25aa1b02) and must never be treated as
// valid output again, regardless of what a generation call returns.
const BRAND_VOICE_FORMATS_ENFORCED = ['CAPABILITY_ONELINER', 'TREC_EDUCATION', 'FOUNDER_STORY'];
```

**`HOOK_FORMULAS` — verbatim, all five:**

```js
const HOOK_FORMULAS = [
  {
    name: 'STAT',
    description: 'Lead with a shocking or specific number.',
    example: '$8,000 a year. For email follow-ups.',
    instruction: 'Open with a concrete number that creates immediate "wait, really?" tension. The number should feel specific and surprising, not round or generic. State the number first, then the context. E.g. "$400 a file. And she still missed the amendment."',
  },
  {
    name: 'QUESTION',
    description: 'Open with the exact question the agent is already thinking.',
    example: 'What happens when your TC quits mid-deal?',
    instruction: 'Ask the question that is already running through the agent\'s head but that they haven\'t said aloud. Must be a real operational fear, not rhetorical filler. E.g. "Who follows up with the lender when you\'re at a showing?"',
  },
  {
    name: 'CONTRAST',
    description: 'Before vs after — then vs now.',
    example: 'Last month: spreadsheets at midnight. This month: Dossie handles it.',
    instruction: 'Two beats: the old painful reality vs the new Dossie reality. Keep each beat short — 5-8 words each. The contrast should feel earned, not like an ad. E.g. "Last week: three missed follow-ups. This week: Dossie caught all of them."',
  },
  {
    name: 'STORY_OPEN',
    description: 'Drop directly into a scene.',
    example: 'She had 6 closings in 10 days and no TC.',
    instruction: 'Start in the middle of a scene — no setup, no preamble. Immediate situation. The reader should feel like they walked into the room mid-story. E.g. "Friday at 4pm. Option period expires Monday. TC unreachable." Then continue the story.',
  },
  {
    name: 'BOLD_CLAIM',
    description: 'Make a direct, confident declaration.',
    example: 'You don\'t need a TC. You need a system.',
    instruction: 'Lead with a confident declarative statement that challenges a common assumption. Must be true and defensible, not hype. E.g. "Every missed deadline has the same cause. No one was watching."',
  },
];

function pickHookFormula(dayOfYear, postIndex) {
  const idx = (dayOfYear + postIndex) % HOOK_FORMULAS.length;
  return HOOK_FORMULAS[idx];
}
```

**`PLATFORM_RULES` — verbatim (per-platform algorithm constraints injected into every generation call):**

```js
const PLATFORM_RULES = {
  tiktok: {
    hook_rule: "First sentence must be under 8 words and create immediate curiosity or tension. Never start with 'I' — start with a question, a number, or a provocative statement.",
    length_rule: "Keep total post under 150 words. Shorter = higher completion rate = more reach.",
    format_rule: "Use line breaks after every 1-2 sentences. No paragraphs. Mobile reading pattern.",
    cta_rule: "End with a single clear action: 'Link in bio' or 'Comment YES if this is you'",
    timing: "Best performing: 6-9AM or 7-9PM CST",
    hashtags: "REQUIRED: 2-3 hashtags at end. Use: #txrealestate #realtorlife #trec",
  },
  instagram: {
    hook_rule: "First line must make someone stop scrolling. Ask a question or make a bold claim. Gets cut off at ~125 chars so front-load the value.",
    length_rule: "150-300 words ideal. Long enough to be useful, short enough to read.",
    format_rule: "Line breaks between every thought. Use emojis sparingly — 1-2 max, relevant only.",
    cta_rule: "Ask for a SAVE ('save this for your next transaction') or SHARE ('send this to an agent who needs it'). Saves and shares beat likes for reach.",
    timing: "Best performing: 8-11AM or 6-8PM CST",
    hashtags: "REQUIRED: 8-10 hashtags at end. Mix high-volume (#realestate #realtor #realtorlife), Texas-specific (#texasrealestate #texasrealtor #trec #sanantoniorealestate), and niche (#transactioncoordinator #realtortools #closingday)",
  },
  facebook: {
    hook_rule: "Start with a relatable pain point or a question agents are already thinking. Facebook audience skews older — be direct, not trendy.",
    length_rule: "Facebook rewards long-form. 200-500 words performs better than short posts. Tell a story.",
    format_rule: "Short paragraphs, 2-3 sentences max. White space is your friend. No bullet points — Facebook reads like a conversation.",
    cta_rule: "Ask a direct question at the end to drive comments. Comments are the strongest signal. 'How many of you are still doing this manually?' works.",
    timing: "Best performing: Tuesday-Thursday 9AM-1PM CST",
    hashtags: "NONE. Facebook hashtags add no value. Do not include any hashtags in Facebook posts.",
  },
  twitter: {
    hook_rule: "Under 280 chars for the opener. Punchy, opinionated, or contrarian. Takes get pushed. Safe content dies.",
    length_rule: "Either under 280 chars (single tweet) or a thread of 5-8 tweets. Nothing in between.",
    format_rule: "For threads: each tweet must stand alone AND connect to the next. Write clean tweet text without manual numbering — the publish system handles threading automatically.",
    cta_rule: "End threads with 'RT if this helped' or a question. Quote tweets and replies are the strongest signals.",
    timing: "Best performing: 8-10AM or 12-1PM CST weekdays",
    hashtags: "REQUIRED: 2-3 hashtags at end. Use: #txrealestate #realtorlife #trec",
  },
  linkedin: {
    hook_rule: "First two lines are visible before the 'see more' fold — front-load the value with a specific operational insight, a contrarian take, or a number. No clickbait, no 'You won't believe...' Sound like a peer talking shop, not a marketer.",
    length_rule: "1300-2000 chars. LinkedIn rewards story-shaped, single-thread posts in this range with the strongest dwell signal. Shorter posts under 600 chars also work for sharp one-line takes.",
    format_rule: "Short paragraphs, 1-3 sentences each. Heavy line-breaks for white space. Skimmable structure beats prose blocks. Lists OK if they're load-bearing, not ornamental.",
    cta_rule: "End with a specific question that invites operators to reply with their own number or workflow ('What does your TC actually cost per file when you add the chase time?'). Comments dwarf likes for reach. Avoid 'Thoughts?' — too generic.",
    timing: "Best performing: Tuesday-Thursday 7-10AM CST. Friday morning also lands well for ops-minded audiences.",
    hashtags: "REQUIRED: 3-5 hashtags at end. Use: #realestate #transactioncoordinator #texasrealestate #proptech #realtors",
  },
  youtube: {
    hook_rule: "First sentence must hook the viewer in under 10 words — state the specific problem or outcome. YouTube viewers decide in the first 3 seconds. Examples: 'Your option period deadline is 8 days away.' or 'Most Texas agents miss this TREC rule.'",
    length_rule: "Description: 150-300 words. The voiceover_script should target 60-90 seconds spoken (550-800 chars) — longer than TikTok/Instagram, educational depth expected. YouTube rewards watch time, not brevity.",
    format_rule: "Description uses short paragraphs. Voiceover is conversational and structured: intro problem, explain the rule or feature, show the solution, CTA. No bullet points in voiceover — write for ears, not eyes.",
    cta_rule: "End description with 'Subscribe for more Texas real estate tips + Link: meetdossie.com/signup'. Voiceover ends with 'This is Dossie. Texas agents - meetdossie.com slash signup.'",
    timing: "Best performing: 9AM-12PM CST (14:00-17:00 UTC). Post 1/day max.",
    hashtags: "REQUIRED: 3-5 hashtags at end of description. Use: #texasrealestate #realtortips #trec #transactioncoordinator #realestateagent",
  },
};
```

**The 8 rotating topics** (`TOPICS`, chosen by `dayOfYear % TOPICS.length`): `cost_math`,
`pain_points`, `day_in_the_life`, `capability_oneliners`, `control_freak_agent`, `build_in_public`,
`feature_reveal`, `community_movement`.

**The verifier gate.** Every draft is re-read by Haiku against an inlined facts snapshot
(`VERIFIER_SYSTEM_PROMPT`, ~150 lines) before insert. Excerpt of the red-flag list:

> 🔴 RED (highest severity — verdict MUST be needs_revision):
> - Founding member numbers past `__FOUNDING_COUNT__`
> - Any language pitching founding membership, founding pricing ($29/mo), spot counts/scarcity ("X spots left", "X of 25 taken"), or meetdossie.com/founding as available to a NEW customer. Founding CLOSED PERMANENTLY 2026-08-04 — no new signups exist or will ever exist again.
> - Invented timestamps with the air of specificity ("Tuesday at 9:43pm", "10pm debug session", "ship in 48 hours") not documented above
> - Customer names + events not in the verified list above
> - Features claimed as live from the NOT-yet-built list
> - Made-up quoted testimonials
> - Numbers presented as real stats ("80% of our users", "saved $X across the platform") — Dossie has `__FOUNDING_COUNT__` customers; aggregate stats don't exist

The NOT-yet-built list it enforces against: Reply Monitoring, AI Autopilot, White Label, brokerage
compliance document sending, Stripe Payment Links, TikTok automation, **Zernio analytics feedback loop**,
Brevo nurture, bulk email drafts, amendment drafting, SMS sending, voice escalation, mobile native app,
Discord.

**Why Instagram and TikTok were cut from this cron** (verbatim comment):

> 2026-09-15 (Carter): removed the instagram + tiktok slots below. Both platforms retired the per-post Creatomate video path on 2026-09-09 in favor of Pipeline B (video_library -> cron-post-videos.js). With video_required=false but no card fallback (video-only policy, 2026-08-18/26), every instagram/tiktok row this cron generated sat inert forever — **79 accumulated before this fix**.

### 3.2 Videos

**Two pipelines.** *Pipeline A* (`cron-render-videos.js` → Creatomate) attaches media to `social_posts`
rows. *Pipeline B* (`video_library` → `cron-post-videos.js`) is where all Instagram/TikTok/YouTube video
now comes from.

**`scripts/build-shortform-video.py`** — the compositor. JSON spec in → hook card + full-bleed footage
segments + punch-in + libass captions + multi-voice audio + ducked music bed + CTA card out. Python
because ffmpeg/libass is the proven toolchain in WSL; note there is **no `drawtext` filter** in this
environment, so all text goes through libass or Playwright HTML→PNG. It refuses a build if a brand's
CTA URL doesn't resolve (`assert_cta_url_resolves()`, a real DNS lookup).

**`scripts/daily-video-supply.js`** — the only thing that *schedules* a video. Three registered formats,
each with a `runway()` that must count real remaining material and a `blocked()` that returns a named
reason or null:

```js
const FORMATS = [
  { id: 'D1', brand: 'dossie',        label: 'Ask Dossie real-question screen demo', share: 3, ... },
  { id: 'R1', brand: 'heath-realtor', label: 'Ken Burns listing reel',               share: 3, ... },
  { id: 'U1', brand: 'rust',          label: 'Rust readiness -> coach adjustment',   share: 2,
    runway: () => ({ remaining: 24, note: '6 coaches x 4 readiness scenarios (CONTENT-FORMAT-LIBRARY §U1)' }),
    blocked: () => 'Rust has no connected social account — every master would be '
      + 'banked, not posted (§9 item 1: Heath must create the accounts). Building '
      + 'into a void burns ElevenLabs credits for zero reach.',
    run: () => { throw new Error('U1 is blocked — see blocked()'); },
  },
];
```

Selection is a starvation score: days-since-last-success ÷ share of the week; hungriest eligible format
wins; a blocked format is skipped with a named reason and the next runs.

**D1 generator:** `scripts/generate-ask-dossie-video.js` (Playwright capture against the live app) +
`scripts/render-ask-dossie-video.js` (VO, compositor, gate, queue). Hook copy is a **closed per-capability
set** — an unmapped capability is a refusal, not an improvised claim. Trailing sentences may be cut to
fit runtime; nothing is reworded.
**R1 generator:** `scripts/listing-reel-trigger.js --render` → live connectMLS read → Ken Burns over real
MLS photos → gate → queue.

### 3.3 Brand config — `scripts/_lib/shortform-brands.json` (verbatim, in full)

```json
{
  "_doc": [
    "Per-brand constants for scripts/build-shortform-video.py.",
    "",
    "WHY THIS FILE EXISTS: docs/CONTENT-FORMAT-LIBRARY.md §5.1 is explicit that the",
    "compositor only unlocks ten formats once the *constants* stop being Rust-specific",
    "code and become per-brand config: 'Hook-card palette, caption style, CTA card text",
    "and URL - must come from a per-brand config'. build-shortform-video.py had already",
    "moved capture geometry into the spec; this file moves the brand identity out of the",
    "individual specs, so a format generator names a brand instead of restating hexes,",
    "fonts, a CTA URL and a voice id every time (and drifting on one of them).",
    "",
    "JSON rather than .py or .js deliberately: the compositor is Python, the card",
    "renderer and the generators are Node, and both have to agree on these values.",
    "",
    "cta.forbidden is a RENDER-TIME REFUSAL, not documentation. build-shortform-video.py",
    "matches every pattern against the CTA card's visible text and aborts the build. The",
    "same guard already exists in scripts/generate-conversation-video.js; the playbook",
    "says it belongs in the compositor too, so it cannot be bypassed by writing a new",
    "generator that forgets it.",
    "",
    "captions.font is asserted against a heavy-sans allowlist (§5a check 12). Cormorant",
    "Garamond is a Dossie brand/heading face and is an automatic gate FAIL as a caption",
    "face - it may only appear inside a card's own CSS."
  ],

  "_voice_note": [
    "Voice ids are mirrored from scripts/voice-select.js, which is the runtime source of",
    "truth for TTS routing and is NOT committed on main (it lives uncommitted in the dev",
    "tree as of 2026-09-16). They are duplicated here ONLY so the compositor can refuse a",
    "wrong-voice build without importing an untracked file. If the two ever disagree,",
    "voice-select.js wins and this file is the bug.",
    "",
    "THE RULE THAT MATTERS (docs/CONTENT-FORMAT-LIBRARY.md §3): Heath's clone may speak",
    "AS HEATH in Dossie founder/instructional content. It may NEVER speak AS DOSSIE.",
    "Dossie's character voice is Luna, always. That is why 'dossie' lists Luna as the",
    "persona voice and Heath's clone only under allowed_speaker_voices."
  ],

  "brands": {
    "dossie": {
      "target_owner": "dossie",
      "label": "Dossie",
      "source": { "w": 1170, "h": 2532, "window_h": 2080, "composer_h": 380 },
      "captions": {
        "font": "Plus Jakarta Sans", "size": 64, "primary": "#FFFFFF",
        "outline": "#1A1A2E", "back": "#1A1A2E",
        "margin_v": 500, "margin_lr": 150, "max_words": 5
      },
      "palette": {
        "bg": "#1A1A2E", "ink": "#F5E6E0", "accent": "#E8836B",
        "kicker": "#C9A96E", "muted": "#D4A0A0"
      },
      "cta": {
        "card": "cta-dossie.html",
        "url": "meetdossie.com/signup",
        "hold_seconds": 2.2,
        "forbidden": [ "(?i)/?founding", "(?i)founding member", "(?i)\\$29\\b" ],
        "forbidden_reason": "Founding closed 2026-08-04 and never reopens (CLAUDE.md §5). The CTA is meetdossie.com/signup. A /founding or $29 CTA sends a prospect to an offer that does not exist."
      },
      "voices": {
        "persona": { "name": "Dossie", "voice_id": "lxYfHSkYm1EzQzGhdbfc", "note": "Luna IS Dossie's voice. Never substituted." },
        "allowed_speaker_voices": { "Dossie": "lxYfHSkYm1EzQzGhdbfc", "Heath": "i41TA0Q36AUrp4axERi3" },
        "forbidden_speaker_voices": { "Dossie": ["i41TA0Q36AUrp4axERi3"] },
        "forbidden_reason": "Heath's clone may speak AS HEATH in Dossie founder/instructional content, but never AS DOSSIE."
      },
      "music_default": "Media/Music/upbeat-renovation.mp3"
    },

    "heath-realtor": {
      "target_owner": "heath-realtor",
      "label": "Heath Shepard, REALTOR",
      "source": { "w": 1170, "h": 2532, "window_h": 2080, "composer_h": 380 },
      "captions": {
        "font": "Plus Jakarta Sans", "size": 62, "primary": "#FFFFFF",
        "outline": "#2B2B24", "back": "#2B2B24",
        "margin_v": 500, "margin_lr": 150, "max_words": 5
      },
      "palette": {
        "bg": "#2B2B24", "ink": "#F3EFE6", "accent": "#8BA888",
        "kicker": "#C9A96E", "muted": "#B9B4A4"
      },
      "cta": {
        "card": "cta-realtor.html",
        "url": "Text me for a private showing",
        "hold_seconds": 2.4,
        "requires_trec_attribution": true,
        "forbidden": [
          "(?i)motivated seller", "(?i)priced to sell",
          "(?i)price (cut|drop|reduc|improv)", "(?i)reduced",
          "(?i)back on (the )?market", "(?i)bring (me )?(all )?offers",
          "(?i)must sell", "(?i)days on market", "(?i)\\bDOM\\b",
          "(?i)good schools", "(?i)safe (area|neighborhood|neighbourhood)",
          "(?i)family neighborhood", "(?i)up-and-coming"
        ],
        "forbidden_reason": "Two separate hard rules. (1) listing-copy-never-signal-weakness.md: no hint of a price cut, motivated seller, or DOM emphasis - Heath represents the seller and copy that invites lowballs is a fiduciary problem, not a style problem. (2) docs/CONTENT-DO-NOT-WRITE-LIST.md: fair-housing steering language is a HARD_BLOCK."
      },
      "trec": {
        "attribution": "Heath Shepard, REALTOR (R) | Keller Williams City View | TX Lic #751964",
        "broker_name": "Keller Williams City View",
        "note": "TREC 535.154/535.155 - social media and video ARE advertisements. The broker name must appear at >= half the size of the largest agent/team contact info and be readily noticeable. OPEN VERIFICATION ITEM (CONTENT-FORMAT-LIBRARY.md §10.1): the rendered type sizes on the closing card have never been measured against the rule. cta-realtor.html sets broker at 0.62x the agent line to clear it with margin, but that ratio has not been checked against a TREC reviewer's reading of 'largest contact info'.",
        "min_broker_to_agent_size_ratio": 0.5
      },
      "voices": {
        "persona": { "name": "Heath", "voice_id": "i41TA0Q36AUrp4axERi3", "note": "Heath's own cloned voice - his realtor listings ONLY." },
        "allowed_speaker_voices": { "Heath": "i41TA0Q36AUrp4axERi3" },
        "forbidden_speaker_voices": {},
        "forbidden_reason": "Heath's clone is scoped to his realtor listings, Rust, and Dossie founder/instructional content."
      },
      "music_default": "Media/Music/cinematic-acreage-luxury.mp3"
    },

    "rust": {
      "target_owner": "rust",
      "label": "Rust",
      "source": { "w": 1170, "h": 2532, "window_h": 2080, "composer_h": 380 },
      "captions": {
        "font": "Plus Jakarta Sans", "size": 64, "primary": "#FFFFFF",
        "outline": "#120C0A", "back": "#000000",
        "margin_v": 500, "margin_lr": 150, "max_words": 5
      },
      "palette": {
        "bg": "#0D0D0F", "ink": "#F2F2F2", "accent": "#E4572E",
        "kicker": "#8A8A8A", "muted": "#9A9A9A"
      },
      "cta": {
        "card": "cta-rust.html",
        "url": "rust-eight-rosy.vercel.app/waitlist.html",
        "url_note": "rustfitness.app is NXDOMAIN as of 2026-09-16 (verified: no A or NS record). This Vercel URL is the real, live waitlist (confirmed 200, API validating) - ugly beats dead. Swap this ONE value back to rustfitness.app once Heath buys the domain; build-shortform-video.py renders cta-rust.html's {{CTA_URL}} from this field, so nothing else needs to change.",
        "offer": "join the waitlist",
        "hold_seconds": 2.2,
        "forbidden": [
          "(?i)download", "(?i)app store", "(?i)play store",
          "(?i)get it now", "(?i)available now", "(?i)install now"
        ],
        "honest_exemptions": [ "Not in the app stores yet" ],
        "honest_exemptions_reason": "docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md §5 item 10 prescribes this exact sentence as the correct honest line while the stores are not live. It contains the substring 'app store' and would otherwise trip the download refusal. Exact-phrase exemption only - 'download now' on the same card still fails.",
        "forbidden_reason": "Rust is in neither store. iOS is in review with manual release; Android is blocked in closed testing behind Google's health-declaration scanner (rust-app-store-submission-state.md). The only honest CTA is the waitlist."
      },
      "voices": {
        "persona": { "name": "coach", "voice_id": null, "note": "Each coach uses THAT coach's own in-app ElevenLabs voice from Rust/api/tts.ts VOICE_MAP, mirrored in voice-select.js RUST_COACH_VOICES. If the real voice cannot be reproduced, ship silent and say so - never substitute a random voice for a named persona." },
        "allowed_speaker_voices": { "Heath": "i41TA0Q36AUrp4axERi3", "Marcus": "nPczCjzI2devNBz1zQrb" },
        "forbidden_speaker_voices": {},
        "forbidden_reason": "A named coach speaking in a voice that is not theirs in the product is a broken promise, not a style choice."
      },
      "facts": {
        "readiness_scale": "1-5, never 1-10",
        "price": "$19.99",
        "deload": "NO calendar-based deload exists. The only real mechanic is a per-exercise 10% back-off after missed reps. marketing/rust-hook-library.md line 1 still says 'deload every 5th week' - that line is STALE, do not generate from it."
      },
      "music_default": "Media/Music/cinematic-acreage-luxury.mp3"
    }
  },

  "caption_font_allowlist": [ "Plus Jakarta Sans", "Inter", "Poppins" ],
  "caption_font_denylist": [ "Cormorant Garamond", "Cormorant", "Georgia", "Times New Roman", "Playfair Display" ]
}
```

### 3.4 `docs/CONTENT-FORMAT-LIBRARY.md` — 21 formats, 13 killed

Written 2026-09-16, 678 lines. **Note for the reviewer: this file is NOT on `main`.** It lives on the
analysis branch checked out in the working tree. The generators reference it by path; it is not deployed.

**Three hard constraints it is built around:**
1. **Video only, no static cards.** Heath, verbatim: *"We aint doing static cards because they suck ass
   and dont convert shit but if they are shorts or videos then lets see them."* The number behind it: the
   702 Fawndale static Instagram post got **54 views and 1 like**. Consequence: *a platform that cannot
   take video with the asset we have gets no post generated at all.*
2. **Screen recordings are the raw material and they are nearly gone.** `Media/feature-demos/` holds 13
   Dossie demos, all recorded 2026-09-07.
3. **The destinations do not exist yet.** 3 brands × 6 platforms = 18 assumed. **Eight exist.**

**The 21 formats:**

| # | Brand | Format | Runway | Draw | Notes |
|---|---|---|---|---|---|
| R1 | Realtor | Ken Burns Listing Reel | 18 | 1/wk | Built, proven, 3 listings rendered |
| R2 | Realtor | TREC Process Explainer (screen-recorded form) | ~20 | 1/wk | Not built |
| R3 | Realtor | "Ask a REALTOR" FAQ, Heath on camera | ∞ | 1/wk | **Needs Heath, 20 min every 2 weeks** |
| R4 | Realtor | Hill Country / Boerne Local | 12-15 | 0.3/wk | Needs his phone b-roll |
| R5 | Realtor | Offer-Desk Breakdown (anonymized numbers) | event | 0.25/wk | Per received offer |
| R6 | Realtor | Just Sold / Under Contract, in motion | event | 0.25/wk | Per MLS status change |
| R7 | Realtor | Market Reality Check (bounded, monthly) | 12/yr | monthly | |
| D1 | Dossie | Real-Question Screen Demo ("Ask Dossie") ⭐ | ~40 | 1/wk | **Built and firing** |
| D2 | Dossie | Reddit Pain → Dossie Answer | ∞ | 1/wk | Scraper exists, mapper not built |
| D3 | Dossie | Founder Explainer, Heath on camera | ~6 | 0.3/wk | **The one hard cliff: ~20 weeks. Only 2 verified war stories exist.** |
| D4 | Dossie | Deadline Math Proof | ~15 | 0.3/wk | |
| D5 | Dossie | LinkedIn Document Carousel | — | — | **DECISION REQUIRED, DO NOT BUILD YET** — conflicts with the no-cards rule |
| D6 | Dossie | Coordinator-to-Coordinator (Door B) | ~8 | 0.15/wk | |
| D7 | Dossie | "Watch It Flag" — Contract Scan Audit | ~10 | 0.3/wk | |
| U1 | Rust | Readiness → Coach Adjustment ⭐ | 24 | 0.5/wk | **Proven. Blocked: no destination.** |
| U2 | Rust | One Sentence, Rebuilt Workout | 15 | 0.3/wk | Blocked |
| U3 | Rust | Coach vs. Coach ⭐ | very high | 1/wk | Highest-yield Rust format. Blocked. |
| U4 | Rust | Progression Math on Screen | 8 | 0.2/wk | Blocked |
| U5 | Rust | Build-in-Public: the Google Health Declaration fight | ~6 | 0.25/wk | Blocked |
| U6 | Rust | Equipment Reality Check | 10 | 0.3/wk | Blocked |
| U7 | Rust | Founder Story, Heath on camera | — | — | "one asset, not a format" |

**Weekly plan:** 8 masters → ~21 live posts (Realtor 3 masters → 9 posts; Dossie 3 → 12; Rust 2 → **0,
banked**). `posting_schedule` allows ~40 slots/week against a 21-post plan. *"The constraint has never
been the schedule. It has always been supply."*

**The 13 killed formats:**

| # | Killed | Why |
|---|---|---|
| 1 | All static image cards, every brand | 702 Fawndale static IG post: 54 views, 1 like. Static is the most algorithmically suppressed format on Meta |
| 2 | **AI-persona text posts on LinkedIn (Brenda/Patricia/Victor)** — ⚠️ *was still running in production via `cron-generate-posts.js`* | LinkedIn's March 2026 "Authenticity Update" suppresses templated AI content beyond first-degree network, reported 30-55% reach/engagement penalty |
| 3 | **Link in the first comment** — ⚠️ *the current instruction in `docs/REALTOR-PAGE-CADENCE.md`* | On LinkedIn, cuts visibility by up to 80%. External link in post body costs 18.8% of median reach. Both worse than no link |
| 4 | LinkedIn polls | Collapsed to 0.07% engagement after the same update |
| 5 | Full-length property walkthrough tours as organic social | The format that still works is a 20-45s cut. R1 is already that shape. *(directional, no hard data)* |
| 6 | **Facebook as a growth surface** | Organic FB reach for new-audience growth "effectively dead" in 2026. Keep FB for Heath's warm network, but **stop counting FB posts as reach** |
| 7 | Rust "coming soon" / countdown / feature-list teasers | Burns pre-launch impressions that should convert to a waitlist |
| 8 | Rust transformation / before-after | Heath has no before/after and must not fake one |
| 9 | Fitness myth-busting / mistake-correction hooks | Most-used fitness hook family, showing saturation |
| 10 | Plain "Just Sold" graphics with no story | Saturated and numbing. R6 survives only with a real line attached, 1/close |
| 11 | In-video Reels link stickers as CTA | Meta gated these behind paid "Meta Verified for Business" in 2026. Stories link stickers remain free |
| 12 | Generative AI b-roll (Kling) for real property footage | Models warp architecture between frames — misrepresentation risk on a TREC-regulated ad |
| 13 | **Color-card "conversation" videos** (`generate-conversation-video.js` output) | **Verified failure, not a guess:** frame 0 and frame 1.5s are pixel-identical in every video checked; runtimes 35.9-42.6s sit above the completion band; every cover is a byline rather than a hook. Keep the script (TTS routing + guardrails reused); never ship its visual output again |

Two findings deliberately **not** acted on: the "video listings generate 403% more inquiries" figure
(appears verbatim across dozens of blogs, no traceable primary citation) and "talking head builds
personal brand 3-5× faster" (unsourced).

### 3.5 Hook bank — `docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md` §2

21 hooks, Rust-first with Dossie/realtor variants. Format: **on-screen text (frame 1)** / spoken line it
sets up / platform fit. Guardrails carried in: readiness sliders are 1-5 not 1-10; **no** calendar-based
deload; price is $19.99; iOS is in review / Android in closed testing — never claim "live in the store";
never invent user counts or testimonials.

*Rust — founder/solo-build:* 1. **"One guy. 121 pieces of equipment. Zero funding."** · 2. **"I'm the
only employee. Watch me find my own bug."** · 3. **"This app has one investor. Me."** · 4. **"I built the
coach that would've told me the truth four years ago."**

*Rust — problem/agitation (proof on screen within 3s):* 5. **"Told it I slept a 2 out of 5. Watch what
happens to the weight."** · 6. **"Hit your reps, it adds 5 lbs. Miss them badly, it takes 10% off. That's
the whole algorithm."** · 7. **"Every app I paid for gave me the same plan on my best day and my worst
day. This one didn't."** · 8. **"You said your shoulder hurts. Watch it swap the exercise before you
finish typing."**

*Rust — curiosity/pattern-interrupt:* 9. **"I asked my own AI coach the dumbest question I could think
of."** · 10. **"Six coaches, six real voices. This one doesn't let you off easy."** · 11. **"Watch the
number change before I even finish the sentence."** · 12. **"This is what 'AI fitness coach' actually
looks like when it's not just a chatbot bolted onto a template."**

*Rust — coach-persona:* 13. **"Val doesn't do sympathy. Val does math."** · 14. **"I told Marcus I
skipped leg day. He noticed before I said why."**

*Dossie variant:* 15. **"Every TC software I tried made me re-type the same deadline three times. This
one doesn't."** · 16. **"I asked Dossie what happens if the option period ends on a Saturday. Watch the
answer."** · 17. **"$400 a file for a TC, or this."** · 18. **"She caught the missing signature before I
did."**

*Realtor-page variant:* 19. **"I've closed enough of these to know the clause everyone skips. Watch."** ·
20. **"This is the exact text I send when an offer comes in low."** · 21. **"The MLS status changed twice
in one day. Here's what that actually means for a buyer."**

> **Rule for all 21:** the on-screen text is the claim; the first visual is the proof starting to render
> (a real slider moving, a real chat reply streaming, a real field populating) — never a static quote card
> standing in for footage that doesn't exist in the edit yet.

---

## 4. The quality gate — `api/_lib/verify-video-quality.js`

1,115 lines. Brand-agnostic: Dossie, Rust and the realtor page all go through it, same rules.

### 4.1 Where it runs, and where it can't

> IMPORTANT — Vercel cannot run ffmpeg (see api/cron-render-videos.js's own note: "Vercel serverless cannot run ffmpeg"). checkVideoQuality() is therefore meant to run where ffmpeg/ffprobe binaries actually exist — today that's scripts/queue-finished-videos.py's local/CLI invocation (via scripts/check-video-quality-cli.js) at ingestion time, NOT inside a Vercel function. cron-post-videos.js (which DOES run on Vercel) gates on the quality_status/quality_failed_rules already recorded on the row by that ingestion step instead of re-probing the file.

### 4.2 Fail-closed contract

> **FAIL-CLOSED BY DESIGN** — this deliberately differs from verify-image-match.js's fail-OPEN convention (which skips quietly if ANTHROPIC_API_KEY is missing, because that gate is a secondary safety net on an otherwise-working pipeline). This gate is the one Heath asked for specifically so a bad video CANNOT ship — a missing API key or missing ffmpeg binary must hold the video, not wave it through.

Concretely: ffprobe missing → every measurable rule fails. No usable `ANTHROPIC_API_KEY` **and** no
`CRON_SECRET` → every vision rule fails. Vision payload >3.5 MB → refuses to send and throws
(*"fail-closed, avoids a platform 413"*). Malformed vision JSON → fails. Mixed/unrecognized `platforms`
array → `orientation_determined` fails and the whole check returns immediately.

There is one deliberate backward-compat carve-out: a caller passing **neither** `platforms` nor
`orientation` defaults to `vertical` with `pass: true` on `orientation_determined`.

### 4.3 Every threshold

```js
const VISION_MODEL = 'claude-sonnet-5';
const HOLD_STATUS  = 'quality_hold';

// Vertical lane
const TIKTOK_RANGE  = [21, 34];
const IG_LOOP_RANGE = [7, 15];
const HARD_MAX_RUNTIME_S = 45;
const TARGET_ASPECT_RATIO   = 9 / 16;  // 0.5625
const ASPECT_RATIO_TOLERANCE = 0.02;

// Horizontal lane (added 2026-09-17)
const VERTICAL_PLATFORMS   = ['tiktok', 'instagram'];
const HORIZONTAL_PLATFORMS = ['facebook', 'twitter', 'linkedin', 'youtube'];
const HORIZONTAL_RUNTIME_RANGE    = [10, 90];
const HORIZONTAL_HARD_MAX_RUNTIME_S = 120;
const TARGET_ASPECT_RATIO_HORIZONTAL   = 16 / 9;
const ASPECT_RATIO_TOLERANCE_HORIZONTAL = 0.02;

// Motion
const MOTION_SAMPLE_T = 1.5;
const MOTION_SSIM_FAIL_THRESHOLD = 0.999;

// Framing
const CONTENT_COVERAGE_GRID = 128;
const CONTENT_COVERAGE_FLAT_TOL = 6;
const CONTENT_COVERAGE_SAMPLE_FRACTIONS = [0.15, 0.3, 0.45, 0.6, 0.8];
const CONTENT_COVERAGE_MIN = 0.85;
const FIRST_FRAME_MIN_LUMA_SPREAD = 24;

// Vision sampling / transport
const HOOK_CLEAR_SAMPLE_T = 3.0;
const CAPTION_SAMPLE_FRACTIONS = [0.25, 0.5, 0.75];
const MAX_VISION_FRAME_BASE64 = 900_000;
const MAX_VISION_REQUEST_BYTES = 3_500_000;
```

### 4.4 Every rule

**Measurable (ffprobe/ffmpeg, exact math, no model call):**

| Rule | Lane | Passes when | Calibration evidence |
|---|---|---|---|
| `video_file_accessible` | both | file resolves locally | — |
| `orientation_determined` | both | `platforms` maps cleanly to one family, or explicit override | fails closed on mixed/unrecognized |
| `runtime_in_platform_range` | vertical | ≤45s AND (21-34s TikTok OR 7-15s IG loop) | the 9 rejected Rust videos ran 42.6s |
| | horizontal | 10-120s | 7 real desktop feature demos measured 26.5-38.1s by ffprobe |
| `real_motion_0_to_1_5s` | both | SSIM(frame 0.0s, frame 1.5s) **< 0.999** | frozen Rust video measured **0.999966**; a genuinely-moving synthetic clip **0.936** |
| `resolution_readable` | both | ffprobe returns non-zero w/h | corrupt-file guard |
| `aspect_ratio_vertical_9x16` | vertical | \|ratio − 0.5625\| ≤ 0.02 | the two bad desktop files were 1920×1080 (1.7778) |
| `aspect_ratio_horizontal_16x9` | horizontal | \|ratio − 1.7778\| ≤ 0.02 | |
| `content_fills_frame` | both | real content ≥ **85%** of frame, intersected across 5 sample points | 6 real demos scored **1.0000**; black letterbox **0.6328**; 16:9-padded-to-9:16 **0.3281**; **white** pillarbox **0.3120** |
| `first_frame_not_uniform` | both | frame-0 luma spread ≥ **24** | the bad stage-checklist video's frame 0 was luma min == max == 235, **spread 0**; every real video measured 237-255 |
| `cover_asset_present` | both | a non-zero-byte cover file/URL was supplied | *"a missing cover fails the gate outright, it is never optional"* |

Bars are detected on a normalised **128×128 grayscale grid** — resolution-independent and, unlike
ffmpeg's `cropdetect`, **colour-agnostic**. That matters: Dossie's brand is a light/blush palette, so a
WHITE pillarbox is a realistic failure that black-only cropdetect scores as a full frame.

**Vision-checked (real Claude Sonnet 5 call on real extracted frames):**

| Rule | Lane | Blocking | Prompt (verbatim, abridged to the ask) |
|---|---|---|---|
| `hook_visible_frame0` | vertical | yes | *"Is there large, legible on-screen text that makes a specific, attention-grabbing claim — the kind of bold hook overlay that stops a scroll — clearly visible in this frame? A tiny corner byline/logo/watermark does NOT count."* |
| `hook_cleared_by_3s` | vertical | yes | *"By Frame B, has that same hook-text overlay cleared away... so the underlying footage/content is now visible and readable — NOT still covered by the same static text block sitting in the same place?"* |
| `legible_ui_frame` | horizontal | yes | *"Is real, readable application UI clearly visible in this frame — legible text, distinguishable buttons/fields/cards/data, not blurry, not cut off, not obscured by a loading state?"* |
| `opening_not_login_or_empty` | both | yes | see below |
| `captions_present` | both | **vertical only** (advisory on horizontal) | *"For EACH frame, is there a legible burned-in caption/subtitle... visible on screen?"* — passes at **≥2 of 3** |

`OPENING_MEANINGFUL_PROMPT`, verbatim — the most interesting rule because it was narrowed the same day
it shipped after it started failing the team's own designed hook cards:

> An opening frame is BAD ONLY if it is one of these:
> - a login / sign-in / sign-up / "welcome back" / password / magic-link / authentication screen — a real screen asking someone to enter or confirm credentials. **This is bad even if the credentials are already pre-filled in.**
> - a frame with NEITHER legible on-screen text NOR visible product/app UI — e.g. a blank/near-blank frame, a bare loading spinner or skeleton placeholder, or an "empty state" / "no data yet" screen with no real text or content on it.
>
> An opening frame is GOOD if it shows EITHER of these — judge generously, this is the common and desired case:
> - a designed hook/title card: large, legible on-screen text making a claim, even on a plain solid-colour background. This is a deliberate scroll-stopping opening, not a dead one, and must NOT be flagged just for having a solid-colour background.
> - real product content/UI: an actual populated app screen, chat, dashboard, or data view.

### 4.5 Publish-time gate

`gateBeforePublish(video)` runs on Vercel and does **not** re-probe the file. Anything other than
`quality_status === 'passed'` is fail-closed: PATCHes the row to `status='quality_hold'`, sends one
Telegram alert, returns `false`. The caller **MUST NOT** proceed. The alert says:

> Row status set to 'quality_hold' — will not retry into review/posting on its own. Fix and re-run the ingestion quality check (scripts/queue-finished-videos.py) to clear it.

A newer blocking rule, `cta_url_resolves`, was added on `scripts/check-video-quality-cli.js` (`--cta-url`):
DNS + HTTP <400 against the finished artefact — stronger than the compositor's DNS-only pre-check.

---

## 5. Publishing

### 5.1 `api/cron-publish-approved.js` — text/card posts (1,311 lines, `*/30`)

Ordered behaviour, from its own header:

1. For each platform with approved-and-due rows, look up today's `posting_schedule` row.
2. Skip the platform until the next slot's clock-time has arrived (now-in-platform-tz vs `time_slots`).
3. Skip the platform once `max_per_day` is reached for today.
4. `tiktok` rows flip to `status='pending_video'` — Zernio rejects text-only TikTok.
5. Zernio errors land in `social_posts.error_message` and the row flips to `failed` (replaces the prior
   "leave at approved for retry" behaviour, which **silently masked permanent failures**).

Concurrency hardening (2026-05-06): stuck-row recovery (`publishing` >10 min → back to `approved`);
conditional PATCH `?status=eq.approved` soft lock before the Zernio call; **per-iteration cap recheck**
(fixes a bug where 3 posts went out under `max_per_day=1` because all three saw the start-of-run
snapshot); content-hash dedup against the same platform in the last 24h.

`MAX_PER_RUN = 30`, bumped from 10 with a candid reason:

> the approved-and-due queue is ordered approved_at.asc with NO staleness filter, so long-permanently-stuck rows (e.g. 9 tiktok rows from 2026-07-08/09/10 wedged behind a 1/day cap that something else always claims first, plus linkedin_personal rows with no Tuesday schedule) fill every slot in a LIMIT 10 window on every single run, forever. ... Doesn't fix the zombie rows themselves — flagged separately for cleanup.

Twitter threading: max 6 chunks, drop paragraphs <20 chars (kills bare "1/" markers), min 60 chars/chunk,
no thread numbering, media only on the first tweet.

Also calls `tagOutboundLinks()` (§7) and `logAutonomousAction()` (§5.4).

### 5.2 `api/cron-post-videos.js` — Pipeline B (970 lines, `30 13 * * *`)

Review-gate flow, verbatim:

> 1. Videos with status='approved' are sent to Heath via Telegram for review. Status is set to 'pending_heath_review' — they do NOT auto-post.
> 2. Heath taps Approve → callback sets status='heath_approved'.
> 3. Heath taps Reject → callback sets status='rejected'.
> 4. On next cron run, only status='heath_approved' videos actually post to Zernio.

Schedule/cap gating is the same `posting_schedule` table, counting **`social_posts` + `video_library`
posted today** in America/Chicago. Targets the platform's next slot today via `scheduledFor`; publishes
now if every slot has passed.

Zernio account IDs are hardcoded (`ZERNIO_ACCOUNTS`), with the `zernio_accounts` table taking precedence.
YouTube's entry carries a confession:

> Was `process.env.ZERNIO_YOUTUBE_ACCOUNT_ID || null` — that env var was NEVER set in Vercel, so this resolved to null and every YouTube target failed account resolution silently. That is the whole reason YouTube has never published a single post despite the channel being connected to Zernio since 2026-05-29 with the youtube.upload scope granted.

`REALTOR_DEFAULT_PLATFORMS = ['facebook','instagram']` — the realtor Zernio profile has no
tiktok/twitter/linkedin.

### 5.3 Per-owner caps and schedules

**`posting_schedule` (live, 2026-09-18) — 49 rows, timezone `America/Chicago` throughout:**

| Platform | Owner | Days | Slots | max/day | max/slot | Active |
|---|---|---|---|---|---|---|
| facebook | (null = dossie) | all 7 | 09:00, 14:00 | 2 | 1 | ✅ |
| instagram | (null) | all 7 | 08:00, 18:00 | 2 | 1 | ✅ |
| linkedin | (null) | Mon-Fri | 07:00 | 2 | — | ✅ |
| linkedin | (null) | Sat, Sun | 12:00 | 2 | — | ✅ |
| tiktok | (null) | all 7 | 07:00, 19:00 | 1 | 1 | ✅ |
| youtube | (null) | all 7 | 14:00 | 1 | 1 | ✅ |
| **twitter** | **(null)** | **all 7** | **08:00** | **3** | **1** | **❌ `is_active=false`** |
| twitter | **rust** | all 7 | 08:00 | 1 | 1 | ✅ (no Rust account exists) |

⚠️ **Two live contradictions worth the reviewer's attention:** Dossie's Twitter schedule rows are all
`is_active=false`, yet 4 of the last 20 published posts are Twitter (§9) — publishing is reaching X
through a path that doesn't consult these rows. And `owner='rust'` has 7 active Twitter schedule rows
pointing at an account that does not exist.

**`scripts/_lib/comment-caps.js` — the engagement caps, verbatim:**

```js
const PLATFORM_DAILY_CAPS = Object.freeze({
  facebook: 15,       // initiated comments (human-pasted; see split note above)
  facebook_auto: 8,   // automated initiated comments (daily hunt; see note above)
  facebook_reply: 10, // automated threaded replies to replies-to-Heath
  facebook_group_post: 5, // automated ORIGINATED group posts (daily 5-group pipeline)
  facebook_group_post_listing: 3, // automated ORIGINATED group posts (listing-marketing rotation)
  instagram: 5,
  linkedin: 3,
  reddit: 3,
  twitter: 5,
});

const TOTAL_DAILY_CAP = 57; // sum of the above; hard ceiling across all platforms

const PER_THREAD_CAP = 1;              // 1 comment per thread / post
const PER_THREAD_CAP_IF_MENTIONED = 2; // 2 if the thread @-mentions Dossie/Heath
const PER_AUTHOR_COOLDOWN_DAYS = 7;

const MIN_GAP_MINUTES = Object.freeze({
  facebook: 45,
  facebook_auto: 45, // FLOOR only — poster adds 0-15 min random jitter so spacing is 45-60, varied, never metronomic
  facebook_reply: 30,
  facebook_group_post: 18,          // FLOOR only — +0-6 min jitter → 18-24
  facebook_group_post_listing: 30,  // FLOOR only — +0-10 min jitter → 30-40
  instagram: 20,
  twitter: 45,
  linkedin: 90,
  reddit: 60,
});

const SUBSTANCE_MIN_CHARS = 80;
```

The header is the most load-bearing prose in the repo:

> **POST-SHADOWBAN TIGHTENING 2026-07-01 (Heath green-lit):** Prior caps (FB 12 / IG 8 / LI 6 / RD 5 / TW 15 = 46/day total) got us shadowbanned in June. Slowed cron to once/day and dropped per-platform caps below platform "human agent" volume.
>
> **A banned profile ends the whole strategy. These are ceilings, not targets.**
>
> **COMBINED VOLUME NOTE:** facebook_group_post (5) + facebook_group_post_listing (3) = up to 8 automated group posts/day on ONE Facebook profile. That is still comfortably under the pre-shadowban volume that caused the June incident, **but it has not been run and observed yet — watch real results for 2 clean weeks before considering raising either cap.**

Note `facebook: 15` was raised from 5 on 2026-09-08 with an explicit risk acknowledgement: *"the June
shadowban hit at 12/day — BUT those were automated posts fired in bursts (6 inside 60 min). Today's
initiated comments are drafted-only; Heath pastes and posts them BY HAND... If ANY warning sign appears
(comment removed, temp block, reduced reach), drop straight back to 5."*

### 5.4 The approval flow and `ops_flags`

**Telegram.** Two bots: **Claudy** (`TELEGRAM_BOT_TOKEN`, personal + DONE) and **DossieMarketingBot**
(`TELEGRAM_MARKETING_BOT_TOKEN`, post approve/reject). Inline-keyboard callback data, per pipeline:
`oppc_approve/oppc_edit/oppc_skip:<id>` (comment opportunities) · `tcreply_approve/edit/skip:<id>` (TC
replies) · `video_approve_<id>` / `video_reject_<id>` (video_library, **underscore separator, not colon
— do not "normalise" it**) · `autoreply_stop:<id>` (the veto STOP button) · `lst_approve/lst_edit/lst_skip`
(listing group posts).

**`api/_lib/ops-policy.js` — the standing-authority policy. Its capability list, verbatim:**

```js
const CAPABILITIES = {
  publish_content: {
    flagKey: 'publish_content',
    defaultEnabled: true,
    description: 'Publish a post that already passed schedule/dedup/media/video-required/caption-sanitizer gates.',
    gates: ['schedule', 'dedup', 'media_required', 'caption_sanitizer'],
  },
  reply_low_risk_comments: {
    // Deliberately points at the PRE-EXISTING 'auto_reply' flag
    flagKey: 'auto_reply',
    defaultEnabled: false,
    description: 'Auto-post a reply to a comment the risk classifier scored low-risk, after a 10-minute Heath veto window with no STOP tap.',
    gates: ['risk_classifier_low_risk_high_confidence', 'content_gates', 'veto_window_10min_no_stop'],
  },
  schedule_week_ahead: {
    flagKey: 'schedule_week_ahead',
    defaultEnabled: true,
    description: 'Advance-fill the next 7 days of draft content so one failed daily run never leaves a silent gap.',
    gates: ['idempotent_per_date', 'verifier_gate'],
  },
  harvest_and_draft: {
    flagKey: 'harvest_and_draft',
    defaultEnabled: true,
    description: 'Read-only comment harvesting + drafting a reply/comment for review. Never the post/reply itself.',
    gates: ['read_only_scrape'],
  },
  batch_routine_approvals: {
    flagKey: 'batch_routine_approvals',
    defaultEnabled: true,
    description: 'Fold routine (non-time-sensitive) per-item approval pings into the one daily morning brief instead of firing individually.',
    gates: [],
  },
};

// ALWAYS HEATH. No flagKey — there is nothing to read. checkCapability()
// short-circuits to blocked before ever touching ops_flags, and the DB
// CHECK constraint (migration 20260917d) additionally makes it impossible
// to ever create an ops_flags row under one of these names.
const ALWAYS_HEATH = {
  spend_money: 'Anything that costs money — a paid API call above the pipeline\'s normal budget, a purchase, a refund.',
  contact_real_client: 'Any message to a real client, lead, or the other side of a deal — as opposed to an anonymous FB group comment.',
  irreversible_public_under_license: 'Anything public and irreversible that carries Heath\'s TX real-estate license — a live post, a signed document, a filed disclosure.',
  pricing_demo_complaint_conversation: 'Any conversation that turns to pricing, a demo request, or a complaint — escalates immediately, never auto-answered.',
  new_account_or_credential: 'Creating a new account, API key, or credential of any kind.',
};
```

Every check and every blocked attempt is written to `ops_action_log`. An unknown capability key fails
closed. A DB read failure fails closed. Logging is best-effort and never reverses the action.

**Live `ops_flags` (2026-09-18):**

| key | enabled | reason |
|---|---|---|
| `publish_content` | **true** | capability policy 2026-09-17 |
| `schedule_week_ahead` | **true** | capability policy 2026-09-17 |
| `harvest_and_draft` | **true** | capability policy 2026-09-17 |
| `batch_routine_approvals` | **true** | capability policy 2026-09-17 |
| `auto_reply` | **true** | "Heath approved 2026-09-16: turn auto-reply on for real" |
| `ack_support_ticket` | false | "OFF until Heath reads the copy and flips it." |

### 5.5 Delivery verification

`api/cron-verify-zernio-deliveries.js` (`*/30`, inside `cron-dispatch-every30`, `maxDuration: 60`) writes
per-platform Zernio results into `video_library.zernio_deliveries` via
`api/_lib/video-delivery-verify.js` (`buildDeliveryEntry` / `mergeDeliveryEntries`). It is in the
telegram-gate `ALWAYS_ALLOW` floor because:

> a video marked 'posted' that never actually delivered must not depend on TELEGRAM_CRON_NOTIFICATIONS being set

`api/cron-verify-posts.js` (`45 * * * *`) does the equivalent for `social_posts`, writing
`zernio_verified_at` / `actual_platform_url`.

⚠️ **Empirically, this is not producing data.** All 23 `video_library` rows with `status='posted'` have
`zernio_deliveries = []`, and every one of the last 20 published `social_posts` has
`actual_platform_url = null`.

---

## 6. Engagement

### 6.1 The Facebook group pipelines

**One Chrome profile drives everything:** `C:\Users\Heath\AppData\Local\DossieBot-Sage`, shared by
`fb-comment-hunt-daily.js`, `fb-comment-opp-poster.js`, `fb-group5-post-queue.js`,
`fb-listing-group-post-queue.js` and `fb-group-commenter.js`. It is **not a bot account** — audited
2026-09-17 and confirmed logged in as Heath's **personal** profile (`facebook.com/heath.shepard.75`).
A 2026-09-16 audit had concluded it was the Page; that finding was wrong and is corrected in place in
`scripts/comment-hunt-groups.json`. Several groups outright block Pages, so personal is the identity
they want. All pipelines share one circuit breaker (`scripts/_lib/comment-hunt-halt.js`) — a
checkpoint or login-redirect on any action class halts all of them.

**Pipeline 1 — comment hunting.** `fb-comment-hunt-daily.js` (Step 4, once/day) scans the 4 verified
groups, scores threads, writes `comment_opportunities`. Scan budget: `max_group_visits_per_day: 8`,
`end_key_rounds: 12`, `max_post_age_hours: 48`, `reverify_recent_posted: 3` — and **it re-verifies
recently posted comments first; a removed comment halts the whole pipeline.**
`api/cron-comment-opp-approval.js` (`*/30`) drafts and sends the Telegram card, capped at 12 sends/day.
`fb-comment-opp-poster.js` (Step 5) posts ONE per tick.

**Pipeline 2 — TC discovery replies.** `harvest-tc-discovery-responses.js` (Step 1) and
`watch-guest-thread-replies.js` (Step 2) harvest. `api/cron-tc-reply-approval.js` (moved to `*/10` on
2026-09-17) drafts, classifies, and either sends an Approve/Edit/Skip card or opens a veto window.
`fb-group-commenter.js --tc-reply-queue` (Step 3) posts.

**Pipeline 3 — originated group posts.** `api/cron-daily-group5-posts.js` (`0 9 * * *`) generates one
post per target group per day → Telegram → `fb-group5-post-queue.js` (Step 6). Listing-marketing posts
run the parallel `lst_*` path (Steps 8/9).

### 6.2 Risk classification — `scripts/_lib/auto-reply-risk-classifier.js`

Rewritten on its **third** adversarial-QA failure, with the reason stated plainly:

> named third parties and comparative/implied language keep taking new shapes ("Miguel and I were just talking about TC stuff", "dana loved the checklist feature" — lowercase name, unlisted verb; "way cheaper than what I pay now" — pricing with no $ sign and no listed keyword) that no fixed pattern list generalizes to, because the categories this classifier judges are **SEMANTIC, not lexical.** Cole's directive, verbatim: *"stop patching regexes — the approach is wrong, not the patterns... Regex will keep losing this game because the categories are semantic."*

Architecture: a two-pattern escalate-only pre-filter (`/\$\s?\d/` → pricing; `/\b(?:demo|trial)\b/i` →
demo_request) that **can never certify eligible**, then `claude-haiku-4-5`, `temperature: 0`,
`max_tokens: 200`, 8s timeout. `eligible=true` requires **both** `eligible:true` **and**
`confidence:"high"`. Every failure mode — missing key, network error, timeout, non-200, no JSON, schema
violation — returns `{eligible:false, category:'low_confidence', confidence:'low', source:'model_error'}`.

**The rubric, verbatim:**

> You are a risk classifier for an automated Facebook comment-reply system. Heath is a real, licensed Texas real estate agent. His name and license are attached to every reply this system might post. You decide whether a DRAFTED reply is safe to auto-post with zero human review, or must be escalated to Heath for a manual decision.
>
> **Default to ESCALATE. Only call something eligible when you are genuinely confident it is harmless small talk.**
>
> ESCALATE (eligible=false) whenever the COMMENT or the DRAFT touches any of these — judge the MEANING, not just specific words:
> - **pricing**: any price, cost, discount, refund, billing question, OR any comparative/implied money reference at all (e.g. "cheaper than what I pay now", "worth it", "afford", "pay for itself") — even with no dollar sign and no word like "cost".
> - **demo_request**: any request to see, try, access, or be walked through the product or how it works, in any phrasing.
> - **complaint**: negative sentiment, doubt, skepticism, or backhanded criticism — including a "thanks" that also carries doubt ("thanks, I guess, not sure it works though").
> - **legal_compliance**: anything touching TREC, legal exposure, liability, contract breach, earnest money forfeiture, or similar — even if it never says "legal" or "TREC".
> - **specific_client**: a NAMED THIRD PARTY appears AT ALL, in any phrasing, any verb, any capitalization, any word order — "Miguel and I were talking about this", "dana loved the checklist feature", "my buddy Ray asked", "told Sarah about it". Treat any personal name reference as disqualifying regardless of how casual or friendly it sounds. **This is the single most important rule: an auto-reply must never land in front of, or reference, someone Heath hasn't met.**
> - **contact_request**: asking Heath to DM, message, call, text, or otherwise reach out directly.
> - **competitor_mention**: naming any competing product, tool, or platform.
> - **low_confidence**: anything else you are not fully sure is harmless — including long or rambling comments, unclear intent, or a question/statement that doesn't cleanly resemble ordinary small talk between two working agents.
>
> ELIGIBLE (eligible=true, and ONLY with confidence="high") is reserved for: a clean thanks, a clean agreement, a neutral question about the other agent's own general practice (not Heath's, not a third party's), or a plain factual answer about how TC/transaction work goes — with NONE of the above present anywhere in the comment or the draft.

### 6.3 The 10-minute veto and the 1-hour SLA

`api/cron-auto-reply-veto-check.js` (`*/5`, in `cron-dispatch-every5`, in `ALWAYS_ALLOW`) does two jobs:

1. **Veto-window resolution.** `tc_discovery_responses` rows at `reply_status='pending_veto'` past
   `veto_deadline_at` (set 10 minutes after the STOP-button message was **delivered**) with no STOP tap
   → auto-approve (`auto_approved=true`), and the normal poster picks them up with the same
   `facebook_reply` cap, min-gap and verify-by-re-render. If the kill switch
   (`scripts/_lib/auto-reply-kill-switch.js`) has been flipped OFF since the row entered `pending_veto`,
   it falls back to `'notified'` for a manual decision instead. A STOP tap races this cron via an atomic
   status-guarded PATCH; whichever write lands first wins.
2. **SLA alert.** Any row unanswered (`new`/`flagged`/`notified`/`pending_veto`) **>60 minutes after
   `harvested_at`** gets exactly ONE Telegram alert (`sla_alerted_at` gates the repeat).

Measured worst case after the 2026-09-17 fix: harvest (≤15 min hot window) + draft/notify (≤10 min) +
veto (10 min fixed) + the poster's next 15-min tick = **~50 min typical worst case**. A burst that
collides with the 30-min `facebook_reply` anti-ban min-gap **can still exceed 60 min by design** — the
SLA alert surfaces that rather than absorbing it.

### 6.4 The group list — `scripts/comment-hunt-groups.json`

Per Heath's explicit instruction: *"unverified entries stay in the list marked unverified, never silently
deleted — the list should be honest, not short."*

**Active (4):**

| Group | Members | `existence_verified` | `acting_identity` | `identity_membership_verified` | `requires_admin_approval` |
|---|---|---|---|---|---|
| DFW Realtors - Network & Collaborate | 38.7K | ✅ 2026-09-08 | personal | **false** | unknown |
| Transaction Coordinators and Virtual Assistants for Real Estate | 10.9K | ✅ 2026-09-08 | personal | **false** | unknown |
| Keller Williams Real Estate Group | 28.6K | ✅ 2026-09-08 | personal | **false** | unknown |
| Texas Real Estate Agents | 22K | ✅ 2026-09-08 | personal | **false** | unknown |

**Skipped (4):**

| Group | Why |
|---|---|
| Transaction Coordinators and Admins for Real Estate (29.8K) | **TC-ONLY per the group's own Rule 1** — Heath is a realtor, not a TC. Rule 5 bans promotional content. A **human moderator** removed a comment posted here 2026-09-10 (FB violations page shows "No violations", Account Quality clean Aug 16-Sep 14, no checkpoint). *"Continuing to post here risks a member removal and a report, which is a real account-level risk to the shared DossieBot-Sage Facebook session the whole distribution strategy runs on."* |
| Real Estate Agents Group (108K) | almost pure listing spam |
| All Realtors and related Professionals (85K) | almost pure listing spam |
| Real Estate Agents in USA (31.3K) | almost pure listing spam |

The big three were skipped because *"scanning them burned most of that day's 25-visit budget for nothing."*
`scripts/_lib/group-resolvability-check.js` refuses to scan or post to any entry where
`existence_verified` isn't true. **Open, unclosed item: `identity_membership_verified` is `false` for all
4 active groups** — the schema was added after a live browser audit disproved two groups ("Boerne Real
Estate", "Real Estate in Austin TX") that neither existed nor happened to be in this file, *"and nothing
would have caught it if they had been."*

### 6.5 LinkedIn / Instagram engagers

`scripts/linkedin-engager.js` — searches LinkedIn for Texas real estate professionals, likes their posts,
drafts brief professional comments on every other post via Claude Haiku. Does **not** follow or connect.
Cap `linkedin: 3/day`, min-gap 90 min. `--post-approved --warm-touch-only` is Step 7 of the tick
(1 approved `linkedin_personal` post/calendar day). It carries its own fixed bug: the hardcoded fallback
profile dir pointed at Heath's **real personal Chrome profile** even though every log line said
"DossieBot profile" — a copy-paste leftover, fixed 2026-09-09.

`scripts/instagram-engager.js` exists; cap `instagram: 5/day`, min-gap 20 min. Session keepalives:
`linkedin-session-keepalive.js`, `instagram-session-keepalive.js`.

---

## 7. Analytics

### 7.1 `post_analytics` sync — two crons, both pulling from Zernio

- **`api/cron-analytics-sync.js`** — `0 2 * * 0` (Sunday 02:00 UTC). Writes one `post_analytics` row per
  (social_post, sync_date), updates `social_posts` inline metrics, and sets `top_performer=true` on posts
  whose `engagement_score` is in the **top 20%**, recomputed each run. Its header names its own defect:
  > **Zernio known issue:** zernio_post_id is NULL on many rows (response-shape mismatch in cron-publish-approved — known tech debt). For rows without a zernio_post_id we fall back to matching by accountId + posted_at window (±5 min) in the Zernio paginated response, then back-fill the ID if found.
- **`api/cron-pull-post-analytics.js`** — `0 6 * * *` daily. Last-7-days posts where `zernio_post_id IS
  NOT NULL`. Falls back to per-platform APIs (Facebook Graph, Twitter v2, LinkedIn) if Zernio unified
  doesn't have it.

**Live state (2026-09-18):** 2,439 `post_analytics` rows; **last sync 2026-09-13 02:00 UTC** — five days
stale, and the weekly cron should have fired 2026-09-14.

| Platform | Rows | Σ views | Σ likes | Σ comments | Σ clicks |
|---|---|---|---|---|---|
| facebook | 1,076 | 2,335 | 35 | 0 | 82 |
| linkedin | 847 | **0** | 40 | 77 | 13 |
| instagram | 516 | 1,159 | 60 | 34 | 0 |
| twitter | **0** | — | — | — | — |
| tiktok | **0** | — | — | — | — |
| youtube | **0** | — | — | — | — |

LinkedIn's `views` column is zero across 847 rows. Twitter, TikTok and YouTube have never produced a
single analytics row.

### 7.2 The attribution chain shipped 2026-09-17

**`api/_lib/content-tag.js`** — tags are computed at **publish** time, not generation time, so they carry
the real platform/format/date:

```
<brand>.<platform>.<format>.<shortId>.<YYYYMMDD>
e.g. "dossie.facebook.video.a1b2c3d4.20260917"
```

`shortId` = first 8 alnum chars of the `social_posts.id` uuid. `tagOutboundLinks()` stamps every outbound
link to the brand domain with `utm_source` / `utm_medium=social` / `utm_campaign` / `utm_content=<tag>`,
idempotently, and matches the bare domain with or without scheme/www — *"generated captions routinely
write 'meetdossie.com/signup' with no 'https://' prefix... a scheme-only regex silently tags nothing on
those rows."*

**Documented platform constraints, verbatim:**

> - **Instagram**: caption text is NEVER clickable. The only tappable link is the single bio link. Per-post attribution via a caption URL is structurally impossible without a link-in-bio rotator (not in this stack). Fallback: content_tag is still recorded on the row... but clicks for Instagram will always read 0/untracked for a specific post — **that is the platform, not "no interest."**
> - **TikTok**: same constraint.
> - **Facebook / Twitter(X) / LinkedIn**: plain URLs are auto-linkified and the destination's query string survives the click. Tagging works.
> - **YouTube**: the description field supports a real clickable link. Tagging works.

**`api/_lib/attribution.js`** — the chain:

```
published link (social_posts.content_tag)
  → click (PostHog pageview, utm_content = the same tag)
  → signup (founding_applications.first_touch / last_touch, captured client-side by assets/dossie-acquisition.js)
  → paid (subscriptions.first_touch / last_touch, forwarded through Stripe Checkout metadata by
          api/create-checkout-session.js, read back by api/stripe-webhook.js)
```

Last-touch wins, first-touch is the fallback. A row whose tag doesn't parse is counted in **both** "total"
and "unattributed" — *"never silently dropped."* Rust returns `supported:false` (separate Supabase
project, no cross-project credentials) *"rather than a fabricated zero."*

⚠️ **Live coverage: 1 of 501 posted `social_posts` rows carries a `content_tag`** (`dossie.linkedin.image.4868169d.20260918`).
The tagging code shipped 9/17 and only stamps at publish time, so this is expected-low — but it means the
attribution chain currently has essentially no data flowing through it.

### 7.3 The morning brief

`api/cron-silence-alarm.js` (`20 15 * * *` daily, `maxDuration: 30`, `includeFiles: '{vercel.json,api/**/*.js}'`).
Extended 2026-09-16 from an exception-only alarm into a **daily heartbeat that sends every run, healthy or
not** — Heath's explicit ask, "consistent posting" top priority. Carries posted-last-24h,
scheduled-next-7d, stuck items, comments awaiting reply, cron sanity, plus goal progress
(`social-goals.js`, `social-goals-progress.js`) and `getAttributionSummary()`.

It also carries up to 3 real Approve/Reject buttons via `pickTopDecisions()` across three
`DECISION_SOURCES` — `comment_opportunities` (status `notified`), `tc_discovery_responses`
(`reply_status='notified'`), and `video_library` (`status='pending_heath_review'`) — reusing each
pipeline's existing `callback_data` **verbatim**, sorted oldest-first. This is what
`batch_routine_approvals` replaces per-item pings with.

### 7.4 `api/_lib/silence-alarm.js` — every check

15 detectors, all run in one `Promise.all` in `runAllChecks()`. Dedup via `alert_state`,
`ALERT_COOLDOWN_HOURS = 20` (*"< 24 so a once-daily cron always re-fires next day, never skips one"*).

| # | Function | Threshold | Fires when |
|---|---|---|---|
| 1 | `checkPlatformSilence` | `SILENCE_DAYS_DEFAULT = 3` | No successful post on a tracked (platform, target_owner) pair in 3 days, where the pair still shows recent generation activity |
| 2 | `checkStaleApprovals` | `APPROVAL_STALE_HOURS = 48` | `social_posts` approved >48h and still not published |
| 3 | `checkStaleDrafts` | `DRAFT_STALE_HOURS = 24` | Drafts >24h that were never even sent to Telegram for review |
| 4 | `checkAccumulatingBacklog` | `BACKLOG_THRESHOLD = 5` | A status accumulating rows without moving (the `video_failed`/`pending_video` pattern that jammed IG/TikTok) |
| 5 | `checkVideoLibraryPendingReview` | `VIDEO_REVIEW_STALE_HOURS = 48` | `video_library` at `pending_heath_review` >48h — sent to Telegram, never tapped |
| 6 | `checkVideoLibraryPendingApprovalStale` | `PENDING_APPROVAL_STALE_DAYS = 7` | `pending_approval` >7 days — the dead-end state (§10.3) |
| 7 | `checkTcHarvestHotWindowStale` | `TC_HARVEST_HOT_STALE_HOURS = 24` (within a 48h hot window) | No host harvest in 24h |
| 8 | `checkTcHarvestScopeGap` | `TC_HARVEST_SCOPE_GAP_HOURS = 3` | A posted row hasn't gotten its first harvest pass |
| 9 | `checkCommentsAwaitingReplyStale` | `COMMENT_REPLY_STALE_HOURS = 24` | `tc_discovery_responses.reply_status='notified'` or `social_comment_replies.reply_status='draft'` sitting >24h |
| 10 | `checkNewCommentsNeverNotifiedStale` | `NEW_COMMENT_NEVER_NOTIFIED_STALE_HOURS = 3` | Rows stuck at `new`/`flagged` with `reply_notified_at` still null past 3h — **flags whether the harvester is still adding more on top.** Added after 14 real comments sat at `new` for up to 22h while `cron_runs` said 'ok' every 30 min |
| 11 | `checkUnverifiedRepliesStuck` | `REPLY_UNVERIFIED_STALE_HOURS = 24` | A reply SUBMIT happened but verification couldn't confirm it landed. **These are deliberately never auto-retried** (Heath's "never retry an unverified send" rule — a retry could double-post) |
| 12 | `checkCommentOppScannerSilence` | `COMMENT_OPP_SCANNER_STALE_HOURS = 24` | The comment-hunt scanner found zero new candidates for 24h. Added after a global halt sat 2026-09-15→17 unnoticed |
| 13 | `checkCommentOppApprovedStale` | `COMMENT_OPP_APPROVED_STALE_HOURS = 24` | Heath-approved comments not posting for 24h |
| 14 | `checkGroupPostingSilence` | `GROUP_POSTING_SILENCE_HOURS = 24` | No group post landed in 24h |
| 15 | `checkCronSanity` | — | `scanCronSanity()` over `vercel.json` (hence the `includeFiles`); reports scan failure as its own alert rather than passing silently |

**`TRACKED_PAIRS`** is 8 explicit pairs: facebook/instagram/twitter/linkedin/tiktok/**youtube** × dossie,
plus facebook/instagram × heath-realtor. The YouTube entry carries the reason it was added:

> YouTube was missing from this list until 2026-09-16, which is exactly why nobody noticed it had NEVER published a single post... An untracked platform cannot go "silent" — it just never existed as far as the alarm was concerned.

---

## 8. Strategy docs

### 8.1 `docs/DOSSIE-30-DAY-CHANNEL-PLAN.md` (249 lines, written 2026-09-17, window 9/18–10/17)

**The thesis:** 838 cold emails produced 0 customers. All 8 paying customers with a recorded source came
through Facebook or personal referral. *"We are spread across 3 businesses × 6 platforms and nothing gets
enough repetition to learn from."*

**The one channel:** agent-to-agent, on Heath's real personal Facebook profile, in Texas REALTOR/TC groups
he's already in — comments and replies first, his own discussion posts second, content only as backup
proof when a conversation asks for it.

**Heath's time:** 8-10 min/day (15-20 Telegram taps), plus one ~20-min camera sitting weekly. *"Total
Heath time across 30 days: roughly 4-5 hours. That is the number to hold him to — if it creeps past 15
min/day, the approval gate needs tightening, not more of his attention."*

**Targets, decided in advance:**

| Metric | 30-day target |
|---|---|
| Conversations started (`comment_opportunities` posted + `group_posts`) | 150-200 |
| Real replies received (`tc_discovery_responses`) | **60+** |
| Direct 1:1 DM conversations with a real TX agent | 15+ |
| Trial/signup starts (Solo or Team checkout initiated) | 3-5 |
| Paying customers (**first non-founding paid customer, ever**) | 1-2 |

**"Working" = ≥60 real replies AND ≥1 new paying Solo/Team customer** traced to this channel. Either alone
is not enough. **"Not working," decided in advance:** <20 real replies by day 21, OR any Facebook action
against the profile that isn't a same-day false-positive clear, OR 0 signup starts by day 30 despite
hitting volume.

**Its own honest attribution caveat:** the 9/17 attribution chain instruments the *scheduled post*
pipeline, **not** group comments or replies — those carry no UTM-tagged link, because a bare link in a
group comment reads as spam and the reply doctrine is explicitly "never mention Dossie in replies" during
discovery. So "which comment produced a customer" is answered by `heard_from` text plus Heath recognising
the name, *"not a clean UTM join. That's a real limitation, not a thing to paper over with a fabricated
dashboard."*

⚠️ **Internal inconsistency:** §3 states Solo is **$79/mo** and Team **$199/mo**; `CLAUDE.md` §5 and the
content verifier both say **$149** and **$349**. One of these is wrong and both are being used to generate
public copy.

**Day 0 prerequisite:** confirm `cron-comment-opp-approval.js` is actually firing — as of 2026-09-09 it was
stalled since 2026-09-08 22:21 UTC with 21 undrafted candidates sitting in `comment_opportunities`.

### 8.2 `docs/SALES-PLAYBOOK.md` (160 lines, written 2026-09-01)

Written after an upsell draft opened with *"If it's not useful just ignore this. I'd rather you not pay for
something you don't need."* Heath: *"that sounds like terrible sales."*

Ten rules: (1) **Never hand them the out** — any sentence that pre-authorises a no will be taken;
(2) lead with their problem, not your feature; (3) be specific or say nothing — *"If you don't have the
number, get it. If you can't get it, cut the claim — don't hedge it into mush"*; (4) one message, one ask;
(5) remove friction from the ask, not the offer — *"Want me to switch it on? Reply yes and it's done in a
minute"* beats a billing link, and *"it's not available at scale — which is exactly why to use it now"*;
(6) assume the sale; (7) anchor price against the cost of the problem; (8) urgency only when real;
(9) write the P.S.; (10) subject lines: curiosity or specificity, never cleverness.

Five hard overrides: never invent a fact; never invent urgency; TREC advertising rules always win; a no
ends the sequence; never send to an unverified address (33% bounce put the sending domain at risk).

The closing section, titled "The uncomfortable one":

> Good copy cannot fix a bad offer. In June–August 2026, 838 cold emails went out, 129 of them delivered to real agents at kw.com, and **zero** produced a customer. That is not a copy problem — better writing would have produced a better-written zero. Before rewriting a message that isn't converting, check whether anyone actually wants the thing. Ten conversations beat a thousand sends.

### 8.3 `DISTRIBUTION-STRATEGY.md` (repo root, 148 lines) — **STALE, still in the tree**

⚠️ **Reviewer flag: this document contradicts current reality in at least five places and nothing marks it
as superseded.** It says founding is live at $29/mo; that personas Brenda/Patricia/Victor handle daily
posting; that Victor's Friday slot routes to LinkedIn; that TikTok is *"gated locally — is_active=FALSE
until ~May 20, 2026"*; and channel status is dated "live 2026-05-07."

What is still current and useful: the **four core value props** that are the messaging spine —
1. **Cost savings**, 2. **Control** (*"Dossie does not act without your tap"*), 3. **Visibility** (*"every
TREC paragraph cited so you can verify the math yourself"*), 4. **Speed** — and the "control freak agent"
segment note: *"Lean into 'you're not giving up control, you're finally getting it'... Avoid 'let go' /
'trust the process' framing — that is exactly what this audience refuses."* That framing is visibly
driving current production output (§9).

The seven strategies, in the doc's priority order: (1) free tool as top of funnel — TREC deadline
calculator, ship one every 2 weeks; (2) programmatic SEO (10,000 pages × 30 visits = 300k/mo at 2% = 6,000
leads/mo — **an unvalidated projection**); (3) AEO — get cited by ChatGPT/Claude/Perplexity; (4) an MCP
server as an AI sales team; (5) viral artifacts (closing cards); (6) AI content repurposing; (7) [not
enumerated in the excerpt read].

### 8.4 `docs/RUST-PRELAUNCH-MARKETING-PLAN.md` (455 lines, 2026-09-14)

§0 is titled **"Read this part first: there is nowhere to send anyone"** and it outranks everything else
in the file:

| Asset | Status |
|---|---|
| Waitlist page | **Did not exist.** Zero matches for `waitlist`/`coming soon`/`early access` across `src/`, `public/`, `api/`, `index.html`. Prototyped that day |
| Custom domain | **None.** Only `rust-eight-rosy.vercel.app` and `rust-heathshepard-6590s-projects.vercel.app` |
| Social accounts | **None found** |
| Public support contact | `heath.shepard@kw.com` — **his Keller Williams real-estate address**, hardcoded in `Rust/public/support.html` |
| Analytics | `src/lib/acquisition.ts` captures first-touch UTM, but **only fires inside the app, which nobody can install** |

> if Heath posted the best fitness video of his life tomorrow, the viewer's only options are a Vercel preview URL that looks like a phishing link, or nothing. **Every impression spent before the waitlist ships is wasted inventory.**

Fix order before a single post: buy a domain (~$15-20/yr, 10-minute Heath task, blocks everything) → ship
the waitlist → move support email off `@kw.com` (*"a fitness app whose public contact is a licensed
REALTOR's brokerage address is both brand-confusing and a KW compliance smell"*) → create the accounts.

§10, "The honest part": Rust has ~5 users, all friends Heath texted. *"That is not traction and it is not
an audience — it's a favor."* First 10-20 TikToks mostly get 200-500 views (*"that's the entry fee"*).
First 100 waitlist signups = 6-10 weeks of consistent posting. 1,000 signups = a 3-6 month project
**assuming** a breakout; without one, 9-12 months **or it doesn't happen at all**. Time cost 6-10 hrs/week
for months. *"Money cost is genuinely near zero... The real currency is Heath's attention, and it is
already split across a brokerage practice, Dossie, and Sawyer."*

Two things the reviewer should weigh: the **Planet Fitness manager** who gave Heath an email address for
in-gym marketing materials — *"still not acted on... worth more than the first month of cold TikTok, and
it costs one email"* — and the named alternative: *"if 6-10 hours/week for six months isn't available, the
better play is to not run a content strategy at all — ship the waitlist, recruit the 12 Android testers,
launch, and let a small real user base generate the content. Pre-launch consumer content marketing with no
audience and no time is the most reliable way to spend months producing nothing."*

### 8.5 `docs/RUST-INFLUENCER-PROGRAM.md` (807 lines, 2026-09-16)

> **Referral codes do not exist and cannot be issued today.** There is no promo-code, coupon, affiliate or referral table anywhere in the Rust repo, and the one live billing path (Stripe Checkout, web only) is built without a promotion-code field.

**Verified economics:** price $19.99/mo, no annual SKU. 7-day free trial, **no credit card** — set by a
`create_trial_on_signup` Postgres trigger whose body is **not in tracked `migrations/`**, so the literal
`7` is not readable from the repo. Net ~$17/sub/mo; COGS ~$4/active user/mo.

**The verdict on 10% recurring:** a 30k-follower fitness creator's real rate is $200-$800/TikTok video
($300-800 realistic), with health/fitness carrying a 40-80% premium. 10% recurring is **~$41 lifetime,
arriving as a $5 first cheque.** *"Worse, the structure is backwards: the creator does all the work in
week 1 and sees the money spread across a year."* Break-even on a flat fee: 3 subs × $17 × 8 months = $408
gross − $96 COGS = **~$312 contribution against a $300 post — a loss.** *"A revenue share cannot bankrupt
you; a flat fee can."*

**What it recommends instead:** *"Run v1 on UTM links and comped accounts. Not codes."* Offer 30% of net
for 12 months (~$122 lifetime) + a comped lifetime account. Build the Stripe promo-code path (~half a day)
in the same week the app goes live, not before. And in writing to a creator: *"the honest caveat that
billing is not live yet and the first cheque cannot arrive before launch. That last sentence is not a
weakness."*

**Blocked-today table (abridged):** send people to a credible URL ❌ (`rustfitness.app` NXDOMAIN) · email
creators from a Rust address ❌ (support is `@kw.com` and *"kw.com inbound has been silently rejecting mail
since 2026-09-10"*) · issue a discount/referral code ❌ · extend a trial ❌ · pay a revenue share ❌
(nothing billing on mobile) · App Store promo codes ❌ (Paid Apps Agreement signed 2026-09-15, still
"Processing") · Play promo codes ❌ (**4 of 12 required testers opted in as of 2026-09-11 — the 14-day
clock hasn't started**). Runnable today: build the list ✅, engage genuinely ✅, comp an account ✅, UTM
tracking ✅, capture via the live waitlist ✅.

---

## 9. Recent generated content with performance

### 9.1 Last 20 published `social_posts` (all `target_owner='dossie'`, all `persona='dossie'`)

**Analytics status for every one of these 20: NO ANALYTICS SYNCED.** Zero matching `post_analytics` rows;
inline `views`/`likes`/`comments`/`clicks` on `social_posts` are all `0`; `actual_platform_url` is `null`
on all 20; `content_tag` is present on exactly **one**. Content is verbatim.

| # | Platform | Posted (UTC) | Topic | Content |
|---|---|---|---|---|
| 1 | twitter | 2026-09-18 17:45 | control_freak_agent | "Who's actually hitting send on your follow-up emails? Dossie drafts every follow-up and queues it for you. You read it, you send it. Nothing goes out without your thumb on it. Solo pricing $149/month. meetdossie.com/signup #txrealestate #realtorlife #trec" |
| 2 | facebook | 2026-09-18 17:45 | control_freak_agent | "$400 a file. That's what a lot of solo agents pay a TC every closing. Here's the part nobody talks about: paying someone doesn't stop the checking. You still open your email at midnight. You still call to make sure the option fee got sent. That's not a trust problem. That's a visibility problem. Dossie's dossier pipeline view puts every active file on one screen, with a deadline badge on each one. Option period, earnest money, survey, title review, closing date - all right there, updated the second something moves. You don't have to ask anyone if the amendment went out. You look. It's already there. This isn't about handing your files to someone else and hoping they're careful. It's about seeing everything yourself, in real time, without a phone call. Control freaks make the best Dossie users, honestly. You're not giving anything up. You're finally seeing it all in one place. Solo pricing is $149/month. Get started at meetdossie.com/signup. How many of you still double check your TC even after you've paid them?" |
| 3 | facebook | 2026-09-18 14:45 | control_freak_agent | "You don't need to trust your TC more. You need to see what they're doing. I paid $400 a file for a long time. Good TC, did the work. And I still woke up at 4:30am wondering if the option fee receipt actually went out. Wondering if the repair amendment got sent. That's not a trust problem. I trusted her. It's a visibility problem. I had no way to check without picking up the phone and asking, which felt insane at 4:30am, so I just laid there wondering instead. Paying for a TC doesn't buy you the ability to look. It buys you someone else's word. That's the whole reason Dossie exists. Not to replace the checking - to let you actually do it, in ten seconds, from your phone, without waking anyone up or feeling like you're micromanaging someone you're paying. If you've ever paid someone and still couldn't sleep, you already know the problem isn't trust. It's not being able to see. Solo pricing is $149/month. meetdossie.com/signup. Anyone else still doing the 4:30am mental checklist even with a TC on payroll?" |
| 4 | linkedin | 2026-09-18 13:45 | control_freak_agent | "Your earnest money isn't as safe as you think it is.\n\nThe third-party financing contingency period has a hard end date. Once it lapses, the buyer's earnest money is no longer protected on financing grounds. If the loan falls apart after that date, the money is at risk.\n\nMost agents know this in theory. Fewer are tracking the actual date across every active file, especially the ones they didn't personally calculate.\n\nThis is where 'trust the TC' breaks down. It's not that TCs are careless. It's that a phone call or a shared spreadsheet is the only visibility most agents have into a deadline that costs their client real money if it's wrong.\n\nDossie calculates the financing contingency deadline the moment the contract is scanned, with the paragraph cited, and puts it on the pipeline view next to every other deadline in that file.\n\nYou're not trusting someone's memory. You're looking at a date with the contract language right next to it.\n\nSolo pricing is $149/month. Team pricing is $349/month. meetdossie.com/signup.\n\nHow are you currently tracking financing contingency dates across multiple active files - spreadsheet, memory, or something else?\n\n#realestate #transactioncoordinator #texasrealestate #proptech #realtors" |
| 5 | twitter | 2026-09-18 13:45 | control_freak_agent | "50+ deals a year on a team. Most brokers can't say which 3 are at risk right now. Dossie's Team Plan flags at-risk files automatically - you see the fire before it's a fire. Team pricing $349/month. meetdossie.com/signup #txrealestate #realtorlife #trec" |
| 6 | linkedin | 2026-09-18 12:00 | control_freak_agent | **[the one tagged post — `content_tag = dossie.linkedin.image.4868169d.20260918`]** "Last month: you took your TC's word for it on the option deadline. This month: you can verify it in ten seconds.\n\nHere's the thing about agents who refuse to hire a TC - it's rarely about ego. It's about accountability. If a deadline slips, you're the one on the E&O claim, not whoever calculated it.\n\nDossie doesn't ask you to trust a calculation. It shows you the math. Scan the contract, and Dossie calculates every deadline - option period, earnest money, title review, closing date - with the exact TREC paragraph cited next to each one.\n\nYou're not taking someone's word for it. You're reading paragraph 23 yourself and confirming the count.\n\nThat's a different relationship than the one most agents have with delegation. You're not handing off the risk and hoping. You're getting a second set of eyes that shows its work.\n\nControl freaks make the best Dossie users, honestly. The whole product is built for someone who wants to check.\n\nSolo pricing is $149/month. Team pricing is $349/month. Get started at meetdossie.com/signup.\n\nWhat's your actual process for double-checking a TC's deadline math right now?\n\n#realestate #transactioncoordinator #texasrealestate #proptech #realtors" |
| 7 | facebook | 2026-09-17 23:45 | capability_oneliners | "Every missed deadline has the same cause. No one was watching. You signed the contract. You told yourself you'd track the option period, the financing deadline, the title commitment date. Then a showing ran long, a buyer called with a question, and three days later you're doing math in your head at a stoplight trying to remember when the option fee was due. Dossie scans your TREC contract in about 8 seconds. Every deadline gets calculated automatically, with the paragraph cited right there so you know exactly where it came from. No spreadsheet. No sticky note on your monitor. No stoplight math. It just sits in your pipeline, quietly correct, so the only thing you have to remember is to open the app. Solo pricing is $149 a month. meetdossie.com/signup if you want to see it on your own contract. How many of you are still tracking deadlines in your head or on a legal pad? Be honest." |
| 8 | facebook | 2026-09-17 17:45 | capability_oneliners | "What happens when your TC quits mid-deal? I found out the hard way. I was in Italy, seven or eight hours ahead of Texas, actually trying to be on vacation for once. And that's when my TC quit. Mid-deal. With active transactions sitting in escrow back home. There is no version of that time difference that works out. I was checking email at 2am local time just to catch business hours back home, trying to figure out who was tracking option periods while I was supposed to be looking at a vineyard. Vacation is the stress test your systems fail. You don't find out your process is fragile until you're the furthest away from being able to fix it. That trip is a big part of why Dossie exists. Not a person who can quit on you mid-transaction. Something that tracks every deadline, every party, whether you're at your desk or on the other side of the world. If you've ever tried to run a transaction from a beach chair or an airport gate, you know exactly what I'm talking about. Solo pricing is $149/month if you want to stop being the single point of failure in your own business. meetdossie.com/signup Anyone else ever had a transaction fall apart while you were supposed to be unreachable? Tell me about it." |
| 9 | facebook | 2026-09-17 14:45 | capability_oneliners | "Compliance shouldn't live in your inbox. Most agents have some version of the same system: a folder of PDFs, a mental list of which forms are missing, and a vague sense of dread every time a broker asks for a file audit. Dossie's Compliance Vault tracks the required document types for every file and shows you the status - what's in, what's missing, what still needs a signature. It's a $15/month add-on to Solo, and it turns 'I think I have that somewhere' into an actual answer. You don't need a better folder system. You need something that knows what's supposed to be in the folder in the first place. Solo pricing is $149/month, Compliance Vault is $15/month on top. meetdossie.com/signup Who else has had a broker ask for a document you were pretty sure you had... somewhere?" |
| 10 | linkedin | 2026-09-17 13:45 | capability_oneliners | "Three agents on a team, three different pipelines, three different ideas about what \"on track\" means. That's usually how it goes until something slips and everyone's asking who was supposed to be watching that file.\n\nDossie's Team Plan gives admins a shared risk-triage view across every transaction on the team - not just a list of files, but a flagged view of which ones need eyes on them now. TC role scoping means you control who sees and touches what. Admins can reassign a transaction in a couple clicks if someone's out or overloaded. Monthly closings get tracked in one place instead of three inboxes and a group text.\n\nIt's not about micromanaging your agents. It's about not finding out a deadline was missed after it's already a problem.\n\nTeam pricing is $349/month for 3 seats. meetdossie.com/signup\n\nIf you run a team - how do you currently get visibility into what your agents' pipelines actually look like day to day?\n\n#realestate #transactioncoordinator #texasrealestate #proptech #realtors" |
| 11 | twitter | 2026-09-17 13:45 | capability_oneliners | "Forgot when the title commitment is due? Just ask Dossie. Talk-to-Dossie chat pulls the answer straight from your contract, cited to the paragraph. No searching your inbox, no re-reading the PDF. Solo pricing is $149/month. meetdossie.com/signup\n\n#realestate #texasrealtor" |
| 12 | linkedin | 2026-09-17 12:00 | capability_oneliners | "12 follow-up emails. That's roughly what a typical file needs between option period reminders, lender check-ins, and closing coordination.\n\nMost agents either write them fresh every time or dig up an old email and hope the details still match the current deal.\n\nDossie's email draft queue keeps templated follow-ups ready to go for every transaction in your pipeline. Lender update, inspection reminder, closing coordination - the draft is sitting there, populated with the right names and dates.\n\nYou review it. You send it. Dossie doesn't send anything on its own - that's on purpose. You're still the one talking to your clients, you're just not starting from a blank page every time.\n\nThe agents who feel most in control of their pipeline aren't the ones with the best memory. They're the ones with the best system for not having to rely on memory at all.\n\nSolo pricing is $149/month, Team is $349/month for brokerages running multiple agents through one pipeline. meetdossie.com/signup\n\nWhat does your actual follow-up process look like right now - templates in a doc, or rebuilding from scratch every file?\n\n#realestate #transactioncoordinator #texasrealestate #proptech #realtors" |
| 13 | facebook | 2026-09-16 14:45 | day_in_the_life | "$400 a file. And Heath still woke up at 4:30am wondering if the option fee receipt had gone out. He was paying a TC. Real money, every file. That was supposed to buy peace of mind. Instead he'd lie there running through the list in his head - did the repair amendment get sent, did the receipt go out, is anything sitting untouched in someone's inbox. Paying someone else to watch it didn't stop him from watching it too. That's the part nobody tells you about hiring help. It doesn't remove the anxiety. It just adds a line item. Dossie was built to actually close that loop - not just do the task, but show you it's done, so the 4:30am wondering has an answer instead of a guess. Solo pricing is $149/month. meetdossie.com/signup if you want to see it. How many of you are paying for a TC and still double checking everything yourself?" |
| 14 | twitter | 2026-09-16 13:45 | day_in_the_life | "Managing transactions remotely means a constant background hum - what's falling through the cracks while I'm not watching it. That anxiety is the actual cost, not the $400 a file. Dossie was built to carry that watching part. Solo pricing is $149/month...." |
| 15 | linkedin | 2026-09-16 12:00 | day_in_the_life | "Every missed deadline has the same root cause. Nobody looked at the pipeline that morning.\n\nMost agents find out about a problem when it's already urgent - an option period closing today, an amendment nobody sent. By then you're reacting, not managing.\n\nDossie's morning brief changes when you find out.\n\nEvery morning it pulls together what's moving across every file you have open - what's due today, what's coming up, what needs your attention first. You can read it or have Luna read it to you while you're making coffee or driving to a showing.\n\nIt's not another dashboard you have to remember to check. It shows up on its own.\n\nFor an agent running 10-12 files at once, that's the difference between finding a problem three days early and finding it three hours before it becomes a client's problem.\n\nSolo pricing is $149/month. Get started at meetdossie.com/signup.\n\nWhat does your morning routine actually look like right now - are you checking every file manually, or is something surfacing this for you?\n\n#realestate #transactioncoordinator #texasrealestate #proptech #realtors" |
| 16 | facebook | 2026-09-15 23:45 | pain_points | "Last month: chasing follow-ups. Now: not. Last month: writing the same 'just checking in' email for the fifth time that week. Now: the draft is already sitting there, waiting for you to hit send. If you've ever sat down on a Friday afternoon trying to remember who you already followed up with and who you haven't, you know how much of transaction coordination is just... email you keep meaning to write. Dossie's email draft queue keeps those follow-ups ready to review and send. You still control every word - nothing goes out without you clicking send. But you're not starting from a blank screen at 4:45pm on a Friday trying to remember the lender's name. For agents doing a full pipeline of deals at once, that's the difference between a calm Friday and a Sunday spent catching up on emails you meant to send three days ago. Solo pricing is $149/month. meetdossie.com/signup How many of you are still writing the same follow-up email from scratch every single time?" |
| 17 | facebook | 2026-09-15 17:45 | pain_points | "$400 a file. Still lost sleep. $400 a file. And still waking up at 4:30am wondering if the option fee receipt actually went out. That was Heath, before Dossie existed. Paying a TC $400 a file - not cheap - and still lying awake wondering if the repair amendment got sent, if the receipt made it to the title company, if something small was quietly falling through the cracks. Paying someone doesn't fix the anxiety. It just moves it. You're still the one who has to trust that everything happened, because you can't see it happening yourself. That's the whole reason Dossie exists. Not to replace a TC's judgment, but to give you visibility into every file so you're not guessing at 4:30am whether something got sent. The deadline, the document, the status - it's all sitting right there instead of living in someone else's inbox. Vacation is the real stress test. If your business falls apart the second you're not personally checking on it, you don't have a system - you have yourself, working around the clock. Solo pricing is $149/month if you want to actually find out. meetdossie.com/signup How many of you have paid someone to handle this and still checked your phone at midnight anyway?" |
| 18 | facebook | 2026-09-15 14:45 | pain_points | "20 days. That's all buyers get. 20 days. That's the standard window a buyer has to review the title commitment and raise objections in Texas. It sounds like plenty of time until you're juggling six files and that 20-day window is buried in an email from the title company three weeks ago. Miss it, and you've lost the chance to object to something that could've been a dealbreaker - a lien, an easement, a boundary issue nobody flagged in time. Dossie tracks that deadline from the moment the commitment comes in, right alongside every other date in the file, so it's not something you're trying to remember off the top of your head on a Sunday. Weekend stress usually isn't about one deadline. It's about not being sure if you're forgetting one. If you've ever double-checked an old email at 9pm because you weren't sure a deadline had passed, you know exactly what I mean. How many of you keep a mental list of every deadline across every file, just in case? meetdossie.com/signup" |
| 19 | linkedin | 2026-09-15 13:45 | pain_points | "Vacation is the stress test.\n\nVacation is the stress test your systems fail.\n\nHeath found that out the hard way - his TC quit mid-deal while he was in Italy, seven or eight hours off from every client and lender back in Texas, with active files sitting in escrow the whole time.\n\nThere's no version of that trip that felt like a vacation after that call. He spent it checking email at 5am local time, trying to figure out what was moving and what had gone quiet, from a time zone where nobody he needed to reach was even awake yet.\n\nHere's the uncomfortable part: it wasn't really a staffing problem. It was a visibility problem. The business ran fine as long as Heath was personally watching it. The second he wasn't, there was no way to know what was happening without someone telling him.\n\nThat's the actual test most agents never run on purpose. Can your files run for a week without you checking in? If the honest answer is no, you don't have a system - you have yourself, and whoever you've hired to also personally watch things for you.\n\nDossie exists because of that trip. Not as an add-on to a TC, but as the visibility layer that means a file doesn't go quiet just because one person did.\n\nSolo pricing is $149/month. meetdossie.com/signup\n\nWhat's the longest you've gone without checking your files, and did anything actually fall through while you weren't looking?\n\n#realestate #transactioncoordinator #texasrealestate #proptech #realtors" |
| 20 | linkedin | 2026-09-15 12:00 | cost_math | "One missed contingency date. Earnest money non-refundable.\n\nThat's not an exaggeration, it's the mechanics of the third-party financing contingency in a Texas contract.\n\nThe buyer has a window to secure financing. Once that window lapses without the buyer terminating in writing, the earnest money is exposed. Nobody wants to be the agent explaining that to a client who assumed they had more time.\n\nThe problem isn't understanding the rule. Most experienced agents know it cold. The problem is tracking it accurately across six or eight files at once, especially when the executed date came in on a weekend and everyone's math is slightly different.\n\nDossie calculates the financing contingency deadline the moment a contract is scanned, cited to the paragraph, and surfaces it in the pipeline view with a deadline badge. No recalculating from memory. No arguing about which day is day one.\n\nIt's a small thing until it's the thing that costs a client their earnest money.\n\nSolo pricing is $149/month. Get started at meetdossie.com/signup.\n\nWhat's your process for double checking financing contingency dates across a full pipeline?\n\n#realestate #transactioncoordinator #texasrealestate #proptech #realtors" |

**Observations a reviewer should make for themselves:** 20 of 20 are Dossie; zero realtor-brand, zero
Rust. 9 Facebook, 7 LinkedIn, 4 Twitter, **0 Instagram, 0 TikTok, 0 YouTube**. 4 of 20 open on the same
"$400 a file / 4:30am" anchor and 3 on "vacation is the stress test." The two topic clusters
(`control_freak_agent`, `capability_oneliners`) each dominate a full day. Twitter is publishing despite
all its `posting_schedule` rows being `is_active=false`.

### 9.2 Last 5 published `video_library` rows

`status='posted'` total: **23 of 41 rows, ever**. Nothing has posted since 2026-09-16. Every one of the
23 has `zernio_deliveries = []` — **no delivery was ever verified for any video.**

| # | id | Owner | Type | Topic | Platforms | Posted | quality_status | Deliveries |
|---|---|---|---|---|---|---|---|---|
| 1 | `dossie-trec-deadlines-mobile-2026-09-16` | dossie | screen_recording | Every TREC deadline, cited to the paragraph | tiktok, instagram, youtube | 2026-09-16 17:00 | **passed** | `[]` — none confirmed |
| 2 | `23-nopalito-realtor-selfie-2026-09-15` | heath-realtor | selfie | 23-nopalito | facebook, instagram | 2026-09-15 19:02 | **unchecked** | `[]` — none confirmed |
| 3 | `feature-demo-stage-checklist-desktop-2026-09-07` | dossie | screen_recording | feature-demo-stage-checklist | facebook, twitter, linkedin | 2026-09-15 18:47 | **held** | `[]` — none confirmed |
| 4 | `feature-demo-close-day-desktop-2026-09-07` | dossie | screen_recording | feature-demo-close-day | facebook, twitter, linkedin | 2026-09-15 18:46 | **held** | `[]` — none confirmed |
| 5 | `feature-demo-dossier-detail-mobile-2026-09-07` | dossie | screen_recording | feature-demo-dossier-detail | tiktok, instagram | 2026-09-15 18:46 | **unchecked** | `[]` — none confirmed |

⚠️ **Rows 3 and 4 are the two 1920×1080 letterboxed videos from §10.4. They are marked
`quality_status='held'` and `posted_date` is set — they shipped before the gate existed.** Rows 2 and 5
are `unchecked`: they predate the gate entirely. The gate is real and works; it is not retroactive and
2 of the last 5 published videos never passed through it.

Full current `video_library` status distribution: `posted` 23 · `rejected` 9 · `pending_heath_review` 7 ·
`pending_approval` 1 · `failed` 1.

**Queued right now, gate-passed, waiting on Heath** (all `quality_status='passed'`, `zernio_deliveries=[]`):
`feature-demo-morning-brief-desktop-2026-09-17`, `dossie-d1-cap6-977d5507-2026-09-18` (+ `-desktop-`),
`dossie-d1-cap7-desktop-2026-09-17` (+ non-desktop), `realtor-r1-23-nopalito-shortform-2026-09-16`,
`dossie-d1-ask-deadline-mobile-2026-09-16`. Plus one at `pending_approval`:
`feature-demo-contract-scan-desktop-2026-09-17`.

### 9.3 Files to show the reviewer

**3 anatomy renders** (Rust muscle-highlight cards/loops, generated 2026-09-18 by
`scripts/generate-anatomy-v2.js` / `scripts/anatomy-v2/figure-lib.js`):
- `/mnt/c/Users/Heath/Projects/MeetDossie/Media/anatomy-v3/pull-up-lats-male-1080x1920-loop.mp4`
- `/mnt/c/Users/Heath/Projects/MeetDossie/Media/anatomy-v3/romanian-deadlift-hamstrings-glutes-female-1080x1920-loop.mp4`
- `/mnt/c/Users/Heath/Projects/MeetDossie/Media/anatomy-v3/seated-dumbbell-shoulder-press-front-delts-male-1080x1920-loop.mp4`

(Still-frame siblings, if a PNG is easier to show: `.../anatomy-v3/pull-up-lats-male-1080x1350.png`,
`.../romanian-deadlift-hamstrings-glutes-female-1080x1350.png`,
`.../seated-dumbbell-shoulder-press-front-delts-male-1080x1350.png`.)

**2 recent videos:**
- `/mnt/c/Users/Heath/Projects/MeetDossie/Media/finished-videos/dossie-d1-cap6-977d5507-2026-09-18.mp4`
  — newest D1, 9:16 vertical, gate-passed, awaiting Heath.
- `/mnt/c/Users/Heath/Projects/MeetDossie/Media/shortform-2026-09-16/rust-u1-readiness-marcus-brandcfg.mp4`
  — the U1 Rust format, rendered through the new brand-config path, **with nowhere to post it**.

For contrast, the two files the gate was built from:
`/mnt/c/Users/Heath/Projects/MeetDossie/Media/feature-demos/feature-demo-stage-checklist-desktop-2026-09-07.mp4`
and `.../feature-demo-close-day-desktop-2026-09-07.mp4`.

---

## 10. Known failures this week

Eleven. Each line states what it actually cost.

1. **Telegram-gate job-name collision (`api/_lib/telegram-gate.js`, 2026-09-16→17).** `install()` bound the
   gate permanently to whichever job called it first in a shared lambda, so a whole dispatcher's Telegram
   sends were gated under the *first* member's name — **14 `tc_discovery_responses` rows sat at
   `reply_status='new'` for up to 22h while `cron_runs` reported 'ok' every 30 minutes**, because
   `cron-publish-approved` (position 0, not in `ALWAYS_ALLOW`) locked the gate and `cron-tc-reply-approval`
   (which *is* in `ALWAYS_ALLOW`) was suppressed anyway. Fixed with an `AsyncLocalStorage` job context.
   **Honesty note on the "13 muted jobs" figure the auditor was given: it is not written down anywhere in
   the repo and I could not substantiate it. The number I can verify by tracing every dispatcher's
   `HANDLERS[0]` against `ALWAYS_ALLOW` is 6** — `cron-verify-zernio-deliveries`, `cron-support-ticket-alert`,
   `cron-comment-opp-approval`, `cron-retry-unsent-approvals`, `cron-tc-reply-approval` (all under
   `cron-dispatch-every30`) and `cron-unsubscribe-spike-monitor` (under `cron-dispatch-hourly`). The bug
   also ran the *other* direction in two dispatchers: `cron-dispatch-every5` and `cron-dispatch-daily-0900`
   had an `ALWAYS_ALLOW` job at position 0, which made **8 jobs that were supposed to be muted audible**.
2. **The dispatcher job-collision itself (`api/_lib/cron-multiplex.js`, shipped 2026-09-16).** Consolidating
   101 crons into 54 to clear Vercel's hard 100-entry schema cap introduced in-process fan-out — the
   mechanism that made failure #1 possible at all. Cost: one day of silent Telegram suppression across 6
   alert-floor jobs plus, separately, failure #3.
3. **Fake telemetry — `cron_runs` reported 'ok' regardless of outcome.** `cron-multiplex.js`'s response
   shim never exposed `statusCode`, but `api/_lib/cron-telemetry.js`'s `withTelemetry` reads exactly that
   to decide ok-vs-error. Every multiplexed sub-handler recorded `http_status: 0` and status 'ok' on every
   run. Cost: the monitoring layer actively *concealed* #1 while it was happening — *"a silent-failure mask
   on top of the telegram-gate bug."*
4. **4-month-stranded videos (`video_library`).** 9 real rows sat at `pending_approval` from 2026-05-27 to
   2026-08-23. Root cause: `scripts/feature-demo-publish.js` inserted directly as `pending_approval`, but
   only `api/cron-video-approval.js` sends the Telegram card and it only reads `status='ready'` —
   `pending_approval` was a dead end with no reader. Confirmed via `telegram_message_id = null` on 8 of the
   9. Cost: ~4 months of finished video never seen; on inspection all 9 had real defects and were patched
   to `rejected`. Compounding it, the quality gate as first written was 9:16-only and **would have failed
   every one of those legitimate 16:9 desktop demos "for being exactly the shape they were built to be."**
5. **Login-screen recordings shipped to Facebook/LinkedIn/Twitter (2026-09-15).** Two Dossie feature demos
   went out at 1920×1080; Facebook renders those surfaces as vertical Reels, so it letterboxed them into
   **~80% black**. The same files opened on a blank white frame and then sat on the Dossie sign-in page —
   **one with the demo account's email and password visibly filled in.** Two independent bugs: nothing
   between `feature-demo-recorder.js` and Zernio ever reframes a video (no scale/pad/crop step anywhere),
   and `login_if_visible` used `input[type=password]` / `button[type=submit]` while the auth card boots in
   magic-link mode with an untyped submit button — so sign-in silently never happened and the per-scene
   `catch` swallowed it. Cost: two live posts of a product demo showing the login page, and a credential
   exposure.
6. **Stale local scripts.** *"Twice in one day a merged fix did nothing because this machine's working tree
   was stale — Windows Task Scheduler runs local files and nothing pulls `main` into them. **Six scripts
   were found running old code**, including libs no `.cmd`/`.ps1` ever names directly."* (A sibling doc puts
   it at three times in one day.) Cost: merged fixes that were live in `main` and dead in production, twice.
   Fixed with `detect-scheduled-script-drift.js` + the pinned `MeetDossie-scheduler` checkout.
7. **Dead domain — `rustfitness.app` is NXDOMAIN** (verified: no A, no NS, Google DoH, 2026-09-16). Worse,
   the config value was **never consulted at render time** — `scripts/video-cards/cta-rust.html` hardcoded
   the string in its markup, so `cta.url` only fed the forbidden-copy regex, not the screen. Cost: every
   already-rendered Rust asset carries a CTA to a domain that does not resolve, and they were not
   regenerated.
8. **Dead waitlist.** As of 2026-09-14 the Rust waitlist page **did not exist** — zero matches for
   `waitlist`/`coming soon`/`early access` anywhere in the Rust repo. It has since been prototyped
   (`Rust/public/waitlist.html`, `Rust/api/waitlist.ts`, `migrations/029_waitlist.sql` — files present on
   disk, **uncommitted**) and the Vercel URL returns 200. Cost: every Rust impression spent before
   2026-09-16 had no destination. Dossie's own `waitlist` table holds **3 rows total**.
9. **Fabricated product claims in the Rust hook library.** `marketing/rust-hook-library.md` stated "deload
   every 5th week" and a 1-to-10 readiness slider. Code says readiness is **1-5**, there is **no calendar
   deload or week counter anywhere in the codebase**, and the real rule is +5 lb / hold / −10%. Cost: a
   generator reading that file would have produced marketing for features that do not exist. Line 1 is
   still flagged STALE inside `shortform-brands.json`.
10. **YouTube never published a single post.** `ZERNIO_ACCOUNTS.youtube` read `ZERNIO_YOUTUBE_ACCOUNT_ID`,
    an env var **never set in Vercel**, so account resolution returned `null` and every YouTube target
    failed silently — since 2026-05-29, with the channel connected and `youtube.upload` granted. It also
    wasn't in `TRACKED_PAIRS` until 2026-09-16, so the silence alarm structurally could not see it: *"An
    untracked platform cannot go 'silent' — it just never existed as far as the alarm was concerned."*
11. **79 inert Instagram/TikTok rows.** `cron-generate-posts.js` kept generating IG/TikTok slots after the
    per-post Creatomate video path was retired 2026-09-09, with `video_required=false` and no card fallback
    under the video-only policy — so every row sat inert forever. 79 accumulated before the slots were
    removed on 2026-09-15.

**The pattern worth naming for the reviewer:** in 8 of these 11, the system reported success while doing
nothing. That is why `api/_lib/silence-alarm.js` has grown to 15 detectors and why `telegram-gate.js`'s
fake-success payload carries three explicit markers (`delivered:false`, `suppressed:true`,
`suppressed_by:'telegram-gate'`) with the contract: *"ANY caller that advances state on 'the human was
notified' MUST call `wasSuppressed()` on the parsed body first."*

---

## 11. Costs

### 11.1 Fixed monthly stack (CLAUDE.md §2, verbatim)

> **Monthly fixed costs: $81.65** (Zernio $18 + ElevenLabs $18.33 + Submagic $12 + Hiscox E&O $33.32; Vercel/Supabase/Creatomate/HCTI/Resend/Pexels/Stripe = $0). Variable: Stripe 2.9%+30¢/charge, HCTI $14/mo at 1k renders.

| Line | $/mo | Notes |
|---|---|---|
| Zernio | 18.00 | 4 accounts, unlimited posts |
| ElevenLabs Creator | 18.33 | 30k credits/mo |
| Submagic Starter | 12.00 | **Manual upload only** — API needs the $60/mo Business tier |
| Hiscox E&O | 33.32 | Insurance, not marketing infra, but in the same line |
| Vercel · Supabase · Creatomate · HCTI · Resend · Pexels · Stripe | 0.00 | All free tier today |
| **Total** | **81.65** | |

Threshold to watch: HCTI goes to **$14/mo at 1,000 renders** (free 50/mo today). Card rendering is largely
moot under the video-only policy.

### 11.2 Per-video variable cost

From `docs/CONTENT-FORMAT-LIBRARY.md` §1:

| Component | Cost | Notes |
|---|---|---|
| **ElevenLabs TTS** | **~$0.0006 / character** | ≈1 credit/char on `eleven_v3`. **A 550-char VO ≈ $0.34.** This is the only real marginal cost |
| Playwright screenshot-loop capture | $0 | `page.screenshot()` at ~14fps, 390×844 @ `deviceScaleFactor:3` → true 1170×2532. **`recordVideo` does NOT work** — ignores `deviceScaleFactor` and letterboxes |
| `build-shortform-video.py` (ffmpeg/libass, WSL) | $0 | |
| `generate-listing-video.js` (Ken Burns) | $0 | |
| `listing-marketing-generate-live.js` | $0 | |
| `feature-demo-recorder.js` | $0 | |
| `record-tutorial-bite.js` | ~$0.15 | Playwright + Luna VO + ffmpeg + Supabase upload |
| Pexels stock b-roll | $0 | |
| Creatomate | $0 on current plan | |
| **fal.ai + Kling 2.5 AI b-roll** | **$0.84 / 5s clip** | **Banned for any real property footage** — models warp architecture between frames, a misrepresentation risk on a TREC-regulated ad |
| Claude Sonnet 5 (post generation) | ~cents/batch | 6 posts/day |
| Claude Haiku 4.5 (content verifier) | **~$0.001/post** | *"a few hundred ms + ~$0.001 per post"* |
| Claude Haiku 4.5 (reply risk classifier) | **<$0.001/call** | ~250 in + ~60 out tokens; *"at a few comments a day this pipeline runs, monthly cost is cents, not dollars"* |
| Claude Sonnet 5 (video quality gate vision) | not measured | 4 vision rules × compressed frames per video. **Nobody has costed this** |

> **Marginal cost of a video is essentially ElevenLabs credits.** Everything else is flat-rate or free. The real cost is *time*, and the real scarcity is Heath's attention.

**A real bottleneck that costs $0 and still blocks:** `Media/Music/` holds **two tracks** for three brands.
ElevenLabs music generation returns `missing_permissions: music_generation` on this key, and Pixabay's CDN
403s non-browser downloads and throttles after ~2 per session. *"Eight videos a week across two tracks will
sound repetitive within a month."*

---

## 12. Open items a reviewer should press on

Not editorializing — these are items the repo itself flags as unresolved, plus contradictions found while
assembling this document.

1. **TREC advertising size ratio has never been measured.** `cta-realtor.html` sets the broker name at
   0.62× the agent line against a ≥0.5 requirement, *"but that ratio has not been checked against a TREC
   reviewer's reading of 'largest contact info.'"* Every realtor video carries this.
2. **AI disclosure is a live compliance exposure.** YouTube and TikTok both require labeling AI-generated
   voices. Every format using Heath's clone is AI-generated audio. The library recommends disclosing and
   notes the uncomfortable part: platforms say disclosed AI isn't ranked down; independent analysis claims
   labeled synthetic content is quietly deprioritized — *"that specific reach-penalty claim is an
   industry-observation piece, not platform-confirmed."*
3. **Pricing disagrees across documents.** `$149`/`$349` (CLAUDE.md, content verifier, live posts) vs
   `$79`/`$199` (`DOSSIE-30-DAY-CHANNEL-PLAN.md` §3). Public copy is being generated from the first pair.
4. **`identity_membership_verified` is `false` for all 4 active Facebook groups.** Existence being verified
   is not the same claim as posting access.
5. **The entire distribution strategy runs through one Facebook profile.** `comment-caps.js` says it
   plainly: *"A banned profile ends the whole strategy."* One group already removed a comment via a human
   moderator on 2026-09-10.
6. **Dossie Settings still labels E-Signatures "COMING SOON"** while the roadmap page says it's live and the
   dossier UI has a working send modal — *"three surfaces disagreeing is a marketing-claim hazard as much
   as a UI bug."*
7. **`DISTRIBUTION-STRATEGY.md` is stale and unmarked.** Five contradictions with current reality; nothing
   in the tree flags it as superseded.
8. **`scripts/voice-select.js` — the runtime source of truth for TTS routing — is not committed on `main`.**
   `shortform-brands.json` duplicates its voice IDs solely so the compositor can refuse a wrong-voice build
   without importing an untracked file, with the caveat: *"If the two ever disagree, voice-select.js wins
   and this file is the bug."*
9. **`brokerage-mls-keepalive.cmd` and `sms-poller-hidden.vbs` are untracked**, exist only on Heath's dev
   machine, and cannot move to the pinned scheduler checkout. `Dossie-MLS-KeepAlive` is currently returning
   exit code 1.
10. **`docs/CONTENT-FORMAT-LIBRARY.md` — the document the video supply loop cites by section number for its
    rotation, runway and format specs — is not on `main`.**

---

*End of package. Every claim above is traceable to a path or a query stated inline. Where this document
disagrees with an earlier summary, this document was read directly from the source on 2026-09-18.*
