# Dossie — 30-Day Single-Channel Focus

**Written:** 2026-09-17, by Sage. **Window:** 2026-09-18 through 2026-10-17.
**Why this exists:** 838 cold emails produced 0 customers (`cold-email-queue-fills-but-never-drains`
memory). Every one of Dossie's 8 real paying customers where a source is on record
(`docs/CUSTOMERS.md`) came through Facebook or a personal referral — Brittney (FB search),
Natalie (Facebook), Lisa Nilsson (friend/colleague), Suzanne (friend). Zero came from cold email,
zero from a persona post (Brenda/Patricia/Victor), zero from a static card, zero confirmed from
paid. We are spread across 3 businesses x 6 platforms and nothing gets enough repetition to learn
from. This plan puts one channel under a magnifying glass for 30 days.

Read alongside: `docs/PIPELINE.md` (daily posting mechanics — unaffected), `docs/WEEKLY-MARKETING-
PLAN.md` (retention/lifecycle cadence, Pierce's, unaffected), `docs/GROUP-ENGAGEMENT-PLAN.md` +
`docs/TC-DISCOVERY-CAMPAIGN.md` (the account-architecture and group-recon work this plan runs on
top of), `scripts/_lib/comment-caps.js` (hard ceilings, do not exceed).

---

## 1. The one channel

**Agent-to-agent, on Heath's real personal Facebook profile, in Texas REALTOR/TC groups he's
already in — comments and replies first, his own discussion posts second, content only as backup
proof when a conversation asks for it.**

This is Heath's pick and it's the right one. Reasoning:

- **It's the only channel with a real signal.** N=8 is thin, but it's the entire dataset, and 4 of
  4 customers with a recorded source trace to Facebook-group-adjacent discovery or a personal
  referral. Cold email has a confirmed negative result (0/838, 33% bounce). Paid ads and LinkedIn
  build-in-public are untested guesses. YouTube keyword-intent has the best *external* evidence
  (`dossie-social-marketing-playbook.md` #2) but needs Heath on camera regularly and the raw
  material for that is nearly exhausted (`CONTENT-FORMAT-LIBRARY.md` 0.2 — one screen-recording
  folder, 13 demos all from one day, only 2 verified real war stories).
- **The infrastructure already exists and is proven, not theoretical.** One real FB login
  (Heath's own, via the DossieBot-Sage Chrome profile — confirmed in `GROUP-ENGAGEMENT-PLAN.md`
  §1, not a bot account), a scored comment-opportunity finder, a Telegram approve/edit/skip gate,
  daily caps, a circuit breaker, and 4 verified-active groups plus 3 joined TC-audience groups.
  Nothing here needs to be built from scratch — it needs to be pointed at one goal for 30 days
  instead of running as one lane among many.
- **It matches the precedent this business already researched and trusts.** Spectora, Deel,
  Wappkit — vertical SaaS to a licensed-professional or skeptical technical audience, all grew via
  a founder personally, genuinely answering in the rooms the audience already occupies, months not
  days, 70% value / 30% mention (`dossie-social-marketing-playbook.md` #1).
- **It's the only channel where the audience-trust data cuts our way.** Buyer trust in AI fell to
  16% in 2026, down from 30% (`CONTENT-FORMAT-LIBRARY.md` D3, Cotality/Inman). A real agent
  answering real agents beats any AI-generated post on trust, structurally.

**What I'd have to see to abandon it, decided now so it can't be rationalized later:**
1. **A Facebook action against the profile** — a removal, a temp block, or a checkpoint that isn't
   a one-time false positive. This is the single point of failure: one profile carries the entire
   strategy (`comment-caps.js`: "A banned profile ends the whole strategy"). One group already
   removed a comment on 2026-09-10 (human moderator, not a spam filter) — that's a yellow flag
   already on record, not a new one.
2. **Zero real replies to Heath's initiated comments/posts by day 14** despite hitting the daily
   volume targets in §3 — that means the room isn't listening, not that we need more volume.
3. **A side-channel outperforming with less effort.** If 2-3 YouTube answer videos (already
   scripted, near-zero incremental build per `CONTENT-FORMAT-LIBRARY.md` R2/D1) produce more real
   conversations than 30 days of group work, that's the signal to shift, not a reason to add a
   6th channel on top.

---

## 2. Daily operating rhythm — what runs without Heath, and his exact minutes

**System does, unattended, every day:**

| Step | Script | What it does |
|---|---|---|
| 1. Find | `scripts/fb-comment-hunt-daily.js` (30-min Task Scheduler tick, self-gates to once/day) | Scans the 4 verified-active groups in `scripts/comment-hunt-groups.json` for real threads worth a comment. |
| 2. Draft + score | `api/cron-comment-opp-approval.js` (Vercel cron, `*/30 * * * *`) | Scores candidates, drafts a comment in Heath's voice, sends to Telegram. |
| 3. Approve gate | DossieMarketingBot, Telegram | Heath taps Approve / Edit / Skip. **This is the only step that needs him.** |
| 4. Post | `scripts/fb-comment-opp-poster.js` (same tick) | Posts approved comments, 45-60min varied spacing, cap 8/day (`facebook_auto`). |
| 5. Watch for replies | `scripts/watch-guest-thread-replies.js` (45min for 48h, then every 3 days to 45 days) | Detects replies to Heath's comments. |
| 6. Draft the reply-to-reply | `api/cron-tc-reply-approval.js` (Vercel cron, `*/30`) | Drafts a threaded reply, sends to Telegram. |
| 7. Approve gate | DossieMarketingBot, Telegram | Heath taps Approve / Edit / Skip. |
| 8. Post | `scripts/fb-group-commenter.js --tc-reply-queue` | Posts, cap 10/day, 30-min gaps (`facebook_reply`). |
| 9. One discussion post/day | Existing `group_posts` pipeline, rotated across the 4 verified groups, never the same group twice in a week | A genuine ask-for-advice/discovery-style post in Heath's own voice — proven format, 9 and 3 comments on the two 2026-09-07 test posts. Cap 1/day for this 30-day window (down from the 4-5/day burst calendar already run 9/8-9/17 — see §5). |
| 10. Supporting content, as needed, not as volume | Existing Telegram-approved persona pipeline (`docs/PIPELINE.md`) | Only when a real conversation asks "does it actually do X" — a real-question demo clip (D1) or a founder clip (D3) gets linked in reply. Not a daily quota. |

**Heath's personal daily minutes: 8-10.** That's roughly 15-20 Telegram taps (up to 8 comment
approvals + up to 10 reply approvals + 1 discussion-post approval), ~15 seconds each, plus 2-3
edits at ~30 seconds when a draft needs a real detail only he has. No typing a comment from
scratch, no scrolling groups himself, no manual posting.

**Weekly, not daily:** one ~20-minute camera sitting (format R3/D3, per `CONTENT-FORMAT-LIBRARY.md`
— batch of 3-4 real-question answers). This is the only format that can't be automated and it's
capped at once a week specifically so it doesn't become a daily ask.

**Total Heath time across 30 days: roughly 4-5 hours** (≈8 min/day x 30 + 4 x 20-min sittings).
That is the number to hold him to — if it creeps past 15 min/day, the approval gate needs
tightening (batch review once in the morning, not real-time), not more of his attention.

**Day 0 prerequisite (must happen before Day 1 counts):** confirm `cron-comment-opp-approval.js`
is actually firing. `docs/GROUP-ENGAGEMENT-PLAN.md` (2026-09-09) found it stalled since
2026-09-08 22:21 UTC with 21 undrafted candidates sitting in `comment_opportunities`. If that's
still true today, this is a Day 1 fix, not a Week-2 discovery.

---

## 3. 30-day targets — decided now, not rationalized later

**Honest attribution caveat first:** the attribution system that shipped today (`api/_lib/
attribution.js`, `content-tag.js`) tracks the *scheduled persona-post pipeline*
(`cron-publish-approved.js` → `social_posts.content_tag` → PostHog click → signup → paid). It does
**not** instrument group comments or replies — those don't carry a UTM-tagged link (a bare link in
a group comment reads as spam and the reply doctrine in `TC-DISCOVERY-CAMPAIGN.md` is explicitly
"never mention Dossie in replies" during the discovery phase). So for *this* channel, "which
comment produced a customer" is answered the way Brittney's and Natalie's actually were —
`founding_applications`/new-signup `heard_from` text plus Heath recognizing the name — not a
clean UTM join. That's a real limitation, not a thing to paper over with a fabricated dashboard.
Where supporting *content* (D1/D2 clips linked in a reply) does carry a `meetdossie.com/signup`
link, that link DOES get a real `content_tag` and DOES show up in `getAttributionSummary()`.

**Also grounding:** Founding is closed permanently (8 members locked for life, `docs/CUSTOMERS.md`).
Any new signup this channel produces goes through `meetdossie.com/signup` → Solo ($79/mo) or Team
($199/mo) checkout (`api/create-checkout-session.js`, plans `solo`/`team`) — never `/founding`.
That's a materially harder ask than the $29 founding rate the 8 existing customers got, and the
targets below are sized for that reality.

| Metric | Definition | 30-day target | Source |
|---|---|---|---|
| Conversations started | `comment_opportunities` rows posted (status→posted) + `group_posts` discussion posts | 150-200 (≈5-7/day avg across the two lanes, under the 8+1 daily ceiling) | direct count |
| Real replies received | `tc_discovery_responses` rows, both `thread_role` values, deduped | 60+ | direct count |
| Direct DM/1:1 conversations with a real TX agent | manual log, new file `docs/DOSSIE-CHANNEL-LOG.md` | 15+ | manual, Heath self-reports weekly |
| Trial/signup starts (Solo or Team checkout initiated) | `subscriptions` rows created, `plan` in ('solo','team'), regardless of `status` | 3-5 | direct count |
| Paying customers (first non-founding paid customer, ever) | `subscriptions` where `plan` in ('solo','team') and `status='active'` after first invoice | 1-2 | direct count |

**"Working" at day 30, numerically:** ≥60 real replies AND ≥1 new paying Solo/Team customer whose
`heard_from` or first-touch traces to this channel. Either alone is not enough — replies without a
single new dollar means the room likes Heath but the offer/ask isn't landing; a customer with no
real reply-volume history would be a fluke, not a channel.

**"Not working," decided in advance:** <20 real replies by day 21 (two-thirds through with a third
of the target), OR any Facebook action against the profile that isn't a same-day false-positive
clear, OR 0 signup starts by day 30 despite hitting the conversation-volume targets. Any one of
these triggers the review in §4, not silent continuation.

---

## 4. Weekly review — a query, not a vibe

Run every Monday against real data, ~15 minutes, Sage owns it:

```sql
-- conversations + replies this week (run against the live Supabase project)
select count(*) from comment_opportunities where status='posted' and created_at >= now() - interval '7 days';
select count(*) from group_posts where status='posted' and posted_at >= now() - interval '7 days'
  and group_name in (select name from json_array_elements_text('["DFW Realtors - Network & Collaborate","Transaction Coordinators and Virtual Assistants for Real Estate","Keller Williams Real Estate Group","Texas Real Estate Agents"]'::json));
select count(*) from tc_discovery_responses where captured_at >= now() - interval '7 days';
select count(*) from subscriptions where plan in ('solo','team') and created_at >= now() - interval '7 days';
```

Plus: `GET` the attribution summary for the supporting-content slice (`getAttributionSummary({days:7})`
in `api/_lib/attribution.js`) — top/bottom content by paid > signups > clicks, and the explicit
`clicks_tracking` health flag (never trust a silent 0).

**What kills a tactic:**
- A specific group producing 0 replies across 2 full weeks of posting → drop it from
  `comment-hunt-groups.json`'s active list, same treatment the 3 dead groups already got.
- A specific question/hook producing 0 replies across 3 uses → retire it, same as the Q1-Q13
  rotation in `TC-DISCOVERY-CAMPAIGN.md` already does.
- Any single removed comment or admin warning → immediate re-read of that group's `/about` rules
  before posting there again; a second incident in the same group drops it to the skip list.

**What doubles down:**
- A group or question producing replies at 2x the average → increase its share of the daily 8+1
  budget (never the hard cap itself — reallocate within it).
- A real reply that names a specific pain matching a `DOSSIE-VERIFIED-CAPABILITIES.md` WORKS item
  → that becomes next week's D1/D2 supporting-content clip, same mechanism already proven for
  Reddit pain language.

---

## 5. What stops for 30 days — and what does not

**Goes dormant (Dossie acquisition activity only — this does not touch Heath's own realtor-brand
posting, which is a different business):**
- Cold email (`cold-email-queue-fills-but-never-drains` — already a proven negative, and the
  33% bounce rate is a live domain-reputation risk that should stay parked regardless of this
  plan).
- Paid FB/IG ad tests (`dossie-social-marketing-playbook.md` #4) — untested, real spend, wrong
  moment to add a second experiment.
- LinkedIn/X/TikTok persona-post *volume push* — Brenda/Patricia/Victor content keeps posting at
  its existing scheduled cadence (`docs/PIPELINE.md`) since that's a sunk, working cron with its
  own cadence and daily caps, but no NEW push, no new formats, no reallocated attention here for
  30 days. It is explicitly not "switched off" — see below.
- The 4-5/day multi-group discussion-post burst calendar (`TC-DISCOVERY-CAMPAIGN.md` §C) — drops
  to 1/day for this window. That calendar already produced the group-recon and question bank this
  plan runs on; it doesn't need to keep running at burst volume to keep paying off.
- Any new Rust or Heath-realtor-brand marketing build that would compete for Carter/Atlas/Sage
  attention this window — those don't stop existing, they just don't get new asks from this
  effort.

**Confirmed NOT switched off (nothing currently working gets killed):**
- Scheduled persona content (`cron-generate-posts.js` → `cron-publish-approved.js`) keeps running
  on its existing schedule and caps — it's the supporting-content source in §2 step 10 and the
  only channel with real click/signup/paid attribution wired today. Turning it off would also kill
  the one clean attribution signal we have.
- Pierce's retention/lifecycle cadence (`docs/WEEKLY-MARKETING-PLAN.md`) — Monday retention pulse,
  Tuesday activation triage, Thursday lifecycle audit, Friday expansion/referral. Losing 1 of 8
  existing customers is a bigger swing than this channel's whole target; retention doesn't pause
  for acquisition.
- Reddit pain-scraping (`scripts/reddit-pain-scraper.js`) — feeds content fuel, near-zero
  attention cost, keep it running.
- Heath's own realtor-brand FB/IG/YouTube posting — separate business, separate audience, not in
  scope for this Dossie-specific plan.

---

## 6. Week 1, day by day — executable tomorrow morning (2026-09-18)

**Thu 2026-09-18**
- Sage/Carter: verify `cron-comment-opp-approval.js` is firing (check Vercel cron logs / most
  recent `comment_opportunities` row with `status != 'found'`). If stalled since 9/8 as last
  found, that's the fix before anything else in this plan counts.
- Sage: create `docs/DOSSIE-CHANNEL-LOG.md` (manual 1:1/DM conversation log — date, group/context,
  agent name if given, outcome).
- System runs steps 1-8 in §2 automatically. Heath: approve/edit/skip whatever DossieMarketingBot
  sends (target ≤10 min).
- Heath: 1 discussion post approved for one of the 4 verified groups (never one already posted to
  this week per the TC-DISCOVERY-CAMPAIGN 2-post-per-group-per-week discipline carried forward).

**Fri 2026-09-19**
- Same daily loop. Sage: pull the first `comment_opportunities`/`tc_discovery_responses` counts
  from 9/18 as the baseline row for the Monday review.
- Heath: 1 discussion post, different group from Thursday's.

**Sat 2026-09-20 / Sun 2026-09-21**
- Comment/reply pipeline keeps running (real agents post on weekends). Discussion-post cadence
  pauses — the proven calendar already ran rest days on Sundays and there's no evidence weekend
  posts in these groups outperform.

**Mon 2026-09-22 — first weekly review**
- Run the §4 queries for 2026-09-15 through 2026-09-22 (partial week, establishes the baseline —
  don't judge against the 30-day target yet, just confirm the pipeline produced real numbers).
- Heath: first camera sitting, ~20 min, 3-4 real questions (R3/D3 format) if any accumulated from
  group threads or his own SMS/Gmail archive.

**Tue 2026-09-23**
- Sage: check `docs/comment-hunt-groups.json` active-group activity against this week's actual
  reply counts per group — first per-group signal, too early to cut anything yet.

**Wed 2026-09-24**
- Daily loop continues. No new tactic added this week — the point of Week 1 is clean baseline
  data, not iteration.

**Thu 2026-09-25 / Fri 2026-09-26**
- Daily loop continues. Sage: draft the first real weekly review writeup for Heath (per §4 format)
  ahead of the first full-week Monday review on 2026-09-29.
