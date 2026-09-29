# Posting Engine Plan — 2026-09-09

Written by Sage. Read-only investigation, live DB queries + code read today. Nothing posted, nothing changed. Everything below is marked VERIFIED (I queried/read it myself, today) or INFERRED (reasoned from evidence, not directly confirmed).

## THE PLAN (this section stands alone — rest is appendix)

**1. Fix first: the video jam is a dead Creatomate account, not a dead cron.** `cron-render-videos` runs fine daily (VERIFIED, `cron_runs` shows "ok" every day). It's been failing since **2026-06-30** with `Creatomate render create failed: 402 Insufficient credits` (VERIFIED, live `error_message` on the oldest stuck rows). Because the query grabs the OLDEST unrendered rows first with no dead-letter skip, those 06-30 failures have blocked the whole queue for 10 weeks — today's 9/9 posts are stuck behind them, never even attempted. **Fix: check the Creatomate billing dashboard, pay/upgrade if lapsed** (human/billing action, can't verify or fix from here — API key is write-only in Vercel). Separately, Carter should add a dead-letter skip (3 failed attempts → route elsewhere) so one broken vendor never jams the queue again.

**2. Bigger fix, ship this week regardless of #1: stop routing Facebook/Instagram/TikTok's daily persona posts through Creatomate at all.** A second video pipeline — screen-recording + ElevenLabs voiceover, no Creatomate — is alive right now: 8 videos sitting `heath_approved`, 1 already posted this week (VERIFIED, `video_library` table). This is the pipeline to lean on. Recommend: pull `facebook`/`instagram`/`tiktok` out of `cron-generate-posts.js`'s `VIDEO_REQUIRED_PLATFORMS` and let the daily feature-demo video (below) carry video duty on those platforms instead of a per-post Creatomate render.

**3. Weekly rhythm, once #2 ships:**

| Page | Mon | Tue | Wed | Thu | Fri |
|---|---|---|---|---|---|
| Meet Dossie (FB/IG/TikTok) | feature-demo video (auto) | pain-point/cost-math text (auto) | feature-demo mobile cut (auto) | TREC-education hook video (auto) | Heath selfie clip (10 min, his) |
| Heath's realtor page | listing/market video from MLS photos (auto, needs current MLS status check) | — | TREC-process explainer (auto) | — | Boerne/local text or short video (auto) |

**4. What Heath does, worst case, per week: ~15-20 minutes.** Record one 30-45s selfie video Sunday or Friday (phone, script already written — pain/math/reveal/CTA), and tap Approve/Reject on Telegram for the daily video + the weekly realtor-page picks. That's it. Worth it because founder-led selfie content is the only format that reads as a real person, not a brand account, and it's the cheapest trust signal available (VERIFIED playbook: Wappkit/Spectora precedent for this exact motion, memory `dossie-social-marketing-playbook.md`).

**5. Stop doing:** stop treating LinkedIn/Twitter volume as a growth channel — 30 LinkedIn + 9 Twitter posts in 45 days produced 0 of the 5 founding applications and 0 of the 3 waitlist signups this quarter (VERIFIED, Heath's own pulled numbers). Most of the 35 rejected posts (VERIFIED breakdown: 11 IG, 9 LinkedIn, 7 FB, 4 TikTok, 3 Twitter, 1 LinkedIn-personal) were auto-caught by the fact-verifier for stale persona formatting or unverified TREC claims — that's the QA system working, not wasted effort, but it means a chunk of "daily generation" output never had a chance of posting. Stop generating in the retired persona format (Brenda/Patricia/Victor were retired 2026-06-14 per the verifier's own rejection text; nothing regenerated a clean prompt since). Also: 18 approved `linkedin_personal` posts (Heath's own voice) are sitting dead because the only thing that publishes them, `scripts/linkedin-engager.js --post-approved`, has no scheduled trigger anywhere (VERIFIED, `.claude/scheduled_tasks.lock` has no LinkedIn entry) — either wire a Windows Task Scheduler job for it or stop generating linkedin_personal drafts.

---

## APPENDIX

### Part 1 — why video is stuck (detail)

Two separate video pipelines exist and get conflated:

- **Pipeline A — Creatomate persona-video** (`cron-generate-posts` marks a post `video_required=true` → `cron-publish-approved` parks it `pending_video` if no video → `cron-render-videos` renders via Creatomate template `791117d0-665c-4cd0-ba5f-a767f8921f9b` + ElevenLabs). VERIFIED dead since 2026-06-30 (Creatomate 402). `VIDEO_REQUIRED_PLATFORMS = ["tiktok","youtube","facebook","instagram"]` (VERIFIED, `cron-generate-posts.js:1539`) means 4 of 5 platforms depend on this broken vendor. Currently 48 rows stuck (VERIFIED live count: instagram 24, tiktok 23, facebook ~3 in the visible sample), growing daily since the query never skips the permanently-failed oldest rows.
- **Pipeline B — feature-demo screen recording** (`scripts/feature-demo-recorder.js` → `generate-voiceover.py` → merge → `video_library` → `cron-video-approval` Telegram approval → `cron-post-videos`). VERIFIED working: `feature-demo-trec-deadlines-desktop-2026-09-07` already posted, 8 more sit `heath_approved` from this week (stage-checklist, close-day, talk-command, draft-amendment, chase-documents, required-docs, file-a-text, deadline-calculator), plus 4 mobile cuts (contract-scan, morning-brief, email-drafting, dossier-detail) in `pending_heath_review`. No Creatomate dependency. `cron-post-videos` posts one `heath_approved` row/day (VERIFIED code, `limit=1`) — with 8 banked, supply is currently ahead of consumption.

Verdict on Heath's (a)/(b)/(c)/(d): **it's (b), a render step fails** — Creatomate billing, not a dead cron, not something only Heath can unblock by recording. The design flaw compounding it is the FIFO queue with no dead-letter handling (INFERRED root-cause mechanism, confirmed by the error-message pattern). Selfie/Submagic (Heath-on-camera path) is a third, intentionally separate format — not what's jamming the daily feed.

### Part 2 — what can make video with zero Heath involvement, today

| Path | Works right now? | Cost/video | Needs Heath? |
|---|---|---|---|
| Feature-demo screen recording + ElevenLabs (Pipeline B) | **Yes** (VERIFIED, posting this week) | ~$0 (ElevenLabs credits only, Creator plan already paid) | No — just Approve/Reject tap |
| Creatomate persona template (Pipeline A) | **No**, 402 since 06-30 (VERIFIED) | Was near-free on template quota | No, once billing's fixed |
| Pexels stock footage | Yes, used inside the lifestyle-video generator | Free | No |
| fal.ai Kling b-roll (`/api/generate-broll`) | Endpoint exists but VERIFIED zero real usage — the only hits found are a health-check probe expecting a 400/401, not a real render | ~$0.84/5s clip | No, but unproven end-to-end |
| Submagic (selfie pipeline) | Manual-upload only, no API (Business plan needed for API) | $12/mo flat | **Yes — always needs a human to upload/export** |
| Selfie video | By design | Free | **Yes — his face is the point** |

Zero-Heath-involvement path that works today: **Pipeline B (feature-demo).** Founder-face formats (selfie) are the only thing that structurally requires Heath.

### Part 3 — what to post

**Meet Dossie page (FB/IG/TikTok) — 8 recurring formats:**

1. **Feature-demo screen recording** — "Upload a contract. Watch Dossie pull every deadline before your coffee's cold." Auto (Pipeline B). CTA: meetdossie.com/founding.
2. **Mobile-native tour** — same script, vertical cut, IG/TikTok only. Auto (Pipeline B mobile cuts, already in review). CTA: same.
3. **$400/file cost-math** — "Her TC costs $400 a file. Eight deals a month, that's $3,200. Dossie is $79." Auto, text+voiceover over b-roll. CTA: meetdossie.com.
4. **TREC-education hook** — real deadline mechanic tied to the feature that tracks it (e.g. option period start date). Auto (Pipeline B, trec-deadlines topic exists). CTA: soft, "This is what Dossie tracks."
5. **Pain-point in brand voice** — third-person Dossie narration over a screen recording of the exact pain resolving. Auto. CTA: meetdossie.com/founding.
6. **Reddit-sourced pain hook** — real scraped agent complaint language (`reddit_pain_language` table) as the opening line, resolved by a feature demo. Auto. CTA: same.
7. **Build-in-public traction post** — real number, no invention ("$291 MRR, 11 customers — here's what got one to upgrade"). Text-first, can pair with a b-roll cutaway. CTA: soft, credibility not pitch.
8. **Heath selfie clip** — pain → math → reveal → scarcity → CTA, per `scripts/SELFIE-VIDEO-WORKFLOW.md`'s proven script formula. **Needs Heath, ~30-45s, 1x/week.** CTA: meetdossie.com/founding.

**Heath's realtor page (KW, San Antonio/Boerne) — 6 recurring formats, no overt Dossie promotion, brokerage name must appear per TREC ad rules:**

1. **Listing video from MLS photos + voiceover** — only for a listing confirmed active in MLS *that day* (23 Nopalito's status is 16+ days stale per `docs/REALTOR-PAGE-CADENCE.md` — recheck before using it).
2. **Market-stat explainer** — real MLS-sourced numbers (median DOM, months of inventory, SA/Boerne), never invented.
3. **TREC-process explainer** (option period, earnest money deadline, survey period) — general/third-person, must carry the practitioner exception per memory `heath-marketing-must-pass-practitioner-test.md` (a flat "always/never" reads as non-practitioner).
4. **Boerne/Hill Country local-authority content** — neighborhoods, local color, no fabricated personal anecdotes.
5. **"What happens after you sign" TREC timeline walkthrough** — generic, educational, doubles as the deadline content already drafted for FB groups.
6. **Weekly "ask a REALTOR" FAQ** — answer one real, common buyer/seller question, literal-query-titled (YouTube keyword-intent tactic from `dossie-social-marketing-playbook.md`, works for any platform).

**Hard constraint:** only 2 personal anecdotes are cleared for use anywhere (memory `heath-verified-war-stories.md`) — the TC-went-dark story and the Low Oak earnest-money file (active dispute, must stay unidentifiable). The TC-went-dark story is Dossie's origin story — keep it on the Meet Dossie page, not the realtor page, to avoid the overt-promotion problem. Every other "personal story" a generator produces (foundation issue, soccer-game amendment, teammate near-miss) is confirmed fabricated — never ships.

### Part 4 — consistency

Crons ARE firing daily and reporting `ok` (VERIFIED, `cron_runs`: generate-posts, publish-approved, render-videos, post-videos, video-approval all ran today with 200s). The unreliability isn't uptime — it's four separate jams:

1. Creatomate billing lapse + FIFO dead-letter bug (Part 1).
2. `posting_schedule`: Twitter and YouTube rows are `is_active=false` (VERIFIED); Facebook/Instagram/LinkedIn/TikTok are active.
3. `linkedin_personal` backlog (18 approved) has no publish trigger scheduled anywhere (VERIFIED).
4. `VIDEO_REQUIRED_PLATFORMS` scope-creep ties FB/IG/TikTok's daily persona-post generation to a vendor with no monitoring.

**2026-07-12 shutdown's three kill switches — status today:** (1) `posting_schedule.is_active=false` on all rows — **partially reversed**: FB/IG/LinkedIn/TikTok back on, Twitter/YouTube still off. (2) `cron-generate-posts` on a once-a-year schedule — **fixed**, runs `0 11 * * *` daily (VERIFIED `vercel.json`). (3) Missing screen recordings breaking mobile renders — **not directly re-verified today**; Pipeline A's Creatomate failure masks whether this is still true underneath it (INFERRED risk, not confirmed either way).
