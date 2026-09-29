# Feature-Video Daily Posting Plan

Owner: Sage. Written 2026-09-07. Goal per Heath: one Dossie feature video posted daily across all socials — "this is how we show everyone what dossie can do."

Everything below is verified against the live DB and the actual cron code, not docs. Nothing has been posted, recorded, or changed yet.

---

## 1. ASPECT RATIO — DECISION: dual-capture, vertical recorded natively

**Each topic gets two cuts from the same scene script and the same voiceover:**

- **Desktop cut** — 1920x1080 landscape → Facebook, Twitter, LinkedIn (what the five existing videos already are; their `platforms` arrays are already set to exactly this).
- **Mobile cut** — 1080x1920 vertical → Instagram Reels, TikTok. Recorded natively, NOT cropped or letterboxed.

**Why this and not the alternatives:**

- `scripts/feature-demo-recorder.js` already honors a per-scene `viewport` (line 329: `scriptCfg.viewport || {1920x1080}`) and records at that size. Vertical capture is a scene-JSON copy with `"viewport": {"width": 1080, "height": 1920}` (mobile-emulated) — no recorder changes. The app is responsive React; it renders a real mobile UI, which is itself a selling point on Reels/TikTok ("Dossie on your phone").
- Cropping 1920x1080 to a 9:16 center strip makes UI text unreadable — a demo video whose demo can't be read is worthless.
- Letterboxing landscape into 9:16 is explicitly banned by `docs/VIDEO-RULES.md` ("Never letterbox/black-bar") and gets buried by the IG/TikTok algorithm anyway.
- This matches the existing `-desktop-`/`-mobile-` filename routing convention that already exists in VIDEO-RULES.md.

**Caveat, handled per-topic:** some features may demo poorly at mobile width (team dashboard tables are the likely offender). Rule: if the mobile capture looks cramped in QA, that topic ships desktop-only to FB/Twitter/LinkedIn and IG/TikTok get a different topic that day. Never force a bad vertical out the door.

Voiceover is shared between cuts (already generated per topic); only the screen recording differs. Two `video_library` rows per topic, `platforms` split: `["facebook","twitter","linkedin"]` vs `["instagram","tiktok"]`.

---

## 2. SUPPLY — inventory and production cadence

### Scene-script inventory (9 in `scripts/feature-demo-scenes/`)

| Script | Verdict |
|---|---|
| `contract-scan-desktop.json` | **Ready** — rendered 08-17, feature solid, best hook we have |
| `morning-brief-desktop.json` | **Ready** — rendered 08-17 |
| `email-drafting-desktop.json` | **Ready** — rendered 08-17 |
| `dossier-detail-desktop.json` | **Ready** — rendered 08-17 |
| `team-dashboard-desktop.json` | **Ready** — rendered 08-17; watch mobile-width QA |
| `first-dossier-desktop.json` | **Re-record** — last rendered 06-09, three months of UI drift; script exists, just re-run |
| `pipeline-view-desktop.json` | **Re-record** — same, 06-09 vintage |
| `team-sales-demo-desktop.json` | **Not public** — 17-scene internal sales walkthrough (Brittney/Natalie) |
| `team-sales-demo-2-desktop.json` | **Not public** — 57-scene internal walkthrough; its `video_library` row must not be approved for posting |

**Excluded by order:** anything e-sign/DocuSeal. The stuck `amendment-demo-desktop-2026-05-27` row gets rejected, not approved.

So: **7 public-usable topics** today (5 current + 2 re-records). Missing scripts worth writing next (features that are built and demo well): deadline tracking with paragraph citations, document upload/auto-tracking, closing milestone cards, the TREC calculator, and a "Dossie on mobile" tour (which doubles as pure vertical content).

### Cadence — and why staggering halves the supply problem

With cuts staggered (Section 3), each topic covers **two posting days** (desktop day, mobile day). Daily posting therefore needs ~15 topics/month, not 30.

**Batch run = one session, 4 topics x 2 cuts = 8 videos.** The pipeline is automated (recorder → `generate-voiceover.py` → `feature-demo-merge.js`), but honesty about throughput: every UI drift breaks selectors in scene scripts, and every output needs a human-quality watch before it enters the queue. 8 videos with QA and one or two selector fixes is roughly half a day. Do not plan a 15-video mega-session; script breakage compounds.

**Weekly rhythm:** one batch run per week (8 videos = 8 posting days) keeps supply ahead of consumption with buffer. First two runs:

- **Run 1:** vertical cuts of contract-scan, morning-brief, email-drafting, dossier-detail (mobile scene-JSON variants of proven scripts — lowest risk).
- **Run 2:** re-record first-dossier + pipeline-view (both cuts each), plus team-dashboard mobile QA attempt.
- **Run 3+:** new scene scripts from the missing-features list, 2 new + 2 refresh per run.

Standing rule: any deploy that changes app UI flags the affected scene scripts for re-record — never post a video showing a UI that no longer exists (the exact staleness problem Heath is reviewing the current five for).

---

## 3. SCHEDULING — staggered cuts, one video-post per platform-group per day

**Decision: staggered, not simulcast.** Desktop cut posts day N (FB/Twitter/LinkedIn), the same topic's mobile cut posts day N+1 (IG/TikTok). Reasons: (a) every platform still gets fresh video daily once both tracks are running; (b) it halves required topic production; (c) `cron-post-videos.js` already posts exactly one `heath_approved` row per day (`limit=1`, line 246) — staggering fits the existing mechanism with zero code, just row ordering. Cross-platform duplication isn't an algorithm concern; same-day sameness on the feed matters less than supply surviving.

**Live `posting_schedule` (DB, verified today — VIDEO-RULES.md is stale on two rows):**

| Platform | Slots (CT) | Cap/day | Active |
|---|---|---|---|
| facebook | 9:00, 14:00 | 2 | yes |
| instagram | 8:00, 18:00 | 2 (doc says 1 — DB says 2) | yes |
| linkedin | 7:00, 12:00 | 2 | yes |
| tiktok | 7:00, 19:00 | 1 | yes |
| twitter | 8:00 | 3 | **no (inactive)** |
| youtube | 14:00 | 1 | **no (inactive)** |

The daily video consumes 1 of each platform's cap; text posts from `cron-publish-approved` fill the rest. TikTok's whole cap IS the video — which finally fixes the standing "TikTok posts park as pending_video" issue.

**Two real problems found in `cron-post-videos.js` that need a Carter fix before daily volume:**

1. **It ignores `posting_schedule` entirely** — posts `publishNow: true` at 13:30 UTC (8:30am CT) to all platforms at once. It even contains a cap-checking function, `getPlatformsPostedToday()` (line 51), that is **defined but never called**. Fix: wire that check in so the video skips any platform already at its DB cap that day, and route the Zernio call through scheduled times instead of `publishNow` so videos land in the real slots (FB 9:00, IG 18:00, etc.). This respects the existing scheduler rather than running a parallel one — which is what the cron does today.
2. **`DEFAULT_PLATFORMS` includes youtube** (dead env var) and tiktok for rows with empty `platforms` arrays. Every row we queue must carry an explicit `platforms` array (the five 08-17 rows already do); rows with `platforms: []` (like team-sales-demo-2) must never reach `heath_approved`.

**Week-at-a-glance once both tracks run:**

| Day | FB/Twitter/LinkedIn (desktop cut) | IG/TikTok (mobile cut) |
|---|---|---|
| Mon | Topic A | Topic Z (from Sun) |
| Tue | Topic B | Topic A |
| Wed | Topic C | Topic B |
| ... | ... | ... |

---

## 4. THE NINE STUCK ROWS — exact state changes needed

`video_library` currently holds **9** rows at `pending_approval` (not 5 — the June and internal rows are stuck too). `pending_approval` is a dead state: `cron-video-approval.js` only picks up `status='ready'`, and `cron-post-videos.js` only picks up `approved`/`heath_approved`. Nothing will ever touch these rows without a manual PATCH.

| Row | Action |
|---|---|
| 5x `feature-demo-*-2026-08-17` | PATCH `status='ready'` |
| `feature-demo-first-dossier-desktop-2026-06-09` | PATCH `status='rejected'` (stale UI; re-record) |
| `feature-demo-pipeline-view-desktop-2026-06-09` | PATCH `status='rejected'` (same) |
| `amendment-demo-desktop-2026-05-27` | PATCH `status='rejected'` (e-sign — barred from public) |
| `team-sales-demo-2-desktop-2026-08-23` | PATCH `status='rejected'` (internal walkthrough, empty `platforms`) |

**Flow after the PATCH (gate now fixed):** `cron-video-approval` (10:00 UTC daily) sends the video with Approve/Reject buttons via DossieMarketingBot → Heath taps **Approve** → `telegram-webhook.js` (line 1075) sets `status='heath_approved'` → `cron-post-videos` (13:30 UTC) posts the oldest `heath_approved` row, one per day, then marks it `posted`.

**Note:** `cron-video-approval` sends only **1 review per run** (`limit=1`, line 72). To put all five in front of Heath in one sitting instead of one per day, trigger it five times manually: `curl -H "Authorization: Bearer $CRON_SECRET" https://meetdossie.com/api/cron-video-approval` (approved pattern, secret from `.env.local`).

Minor: the email-drafting caption contains a real em-dash (U+2014). Zernio likely passes it, but normalize captions to ASCII at queue time to match house content rules.

---

## 5. FIRST LIVE POST — verified, not trusted

The `video_library` → Zernio path has never fired in production. For post #1 (contract-scan desktop cut, the strongest opener), I verify, Heath doesn't:

1. Capture the `zernio_post_id` from the cron response/logs; query Zernio's post status endpoint for per-platform publish state and permalinks — a 200 on POST proves acceptance, not publication.
2. **Playwright with the DossieBot Chrome profile**: load facebook.com/MeetDossie and press play — confirm the video renders and audio is present, not just that a post exists. Same eyeball on linkedin.com/company/meetdossie and @meetdossie on Twitter.
3. Confirm the `video_library` row flipped to `posted` and no `failed` Telegram alert fired.
4. Only after post #1 verifies clean on every targeted platform does the daily cadence run unattended. First mobile-cut post to IG/TikTok gets the same treatment separately (different rendering path — Reels/TikTok video processing is where silent failures live).

---

## 6. WHAT HEATH PERSONALLY DOES

1. **Approve/reject the five 08-17 videos** in Telegram (DossieMarketingBot) once they're re-sent — the staleness call on each is his. A reject just means that topic moves into the next re-record batch; it doesn't stall the plan.
2. Nothing else is his. Row PATCHes, the cron cap fix (Carter), batch recording, and first-post verification are all agent work.

---

## 7. HONEST GAP — "daily" vs. week-one reality

- **Week 1:** FB/Twitter/LinkedIn get daily video for up to 5 days (however many of the five Heath approves). **Instagram and TikTok get zero** — no vertical cut exists yet. If Heath rejects several for staleness, the desktop track runs dry mid-week until batch Run 1/2 lands.
- **Week 2:** first mobile batch (Run 1) + re-records (Run 2) come online. IG/TikTok start. This is realistically when "daily across all socials" actually begins — contingent on the cron cap fix shipping and post #1 verifying.
- **Week 3+:** steady state — one weekly 8-video batch feeds a 7-day staggered calendar with ~1 week of buffer. 15 topics/month required; 7 scripts exist, so ~2 new scene scripts per week keeps the well full.

Bottom line: daily on 3 platforms can start the day Heath approves; daily on all 5 is a week-two reality, and claiming otherwise would just mean posting stale or letterboxed junk to hit a date.
