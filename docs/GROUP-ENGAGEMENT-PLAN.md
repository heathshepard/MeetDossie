# FB Group Engagement Plan — Daily Posting + Commenting

Built by Sage, 2026-09-09. Research + recommendation only — nothing posted, no scripts edited.

## TL;DR

There is **one** real FB identity in play (Heath's personal profile, via the DossieBot Chrome
profile) — "KW account" and "Dossie account" are the same login today, just different topic
lanes. A second personal profile for "Dossie" is a real ToS risk and Pages can't post/comment in
these groups at all, so don't build one without Heath's explicit sign-off (see #1). The comment
pipeline Heath thinks is "fully automated" is **currently stalled** — `cron-comment-opp-approval`
hasn't run since 2026-09-08 22:21 UTC despite a 30-min schedule, so all 21 found candidates sit
undrafted (see #5, flag for Carter/Atlas). Recommended cadence: 1 discussion-style post/day
rotating across the 5 groups (never the same group twice in a week), 7-9am CST Tue-Thu or 8-10pm
Sun, plus the existing auto-commenter once it's unstuck. Group rules are genuinely unverified for
3 of the 5 target groups — treat those as value-only until recon'd.

---

## 1. Account architecture (gates everything below)

**What exists today, confirmed on disk:**

- One Chrome profile ("DossieBot", `PLAYWRIGHT_PROFILE_DIR`/`SAGE_PROFILE_DIR` env vars) is the
  single browser identity every group script launches against —
  `fb-group-poster.js`, `fb-group-commenter.js`, `fb-comment-hunt-daily.js`,
  `fb-comment-opp-poster.js` all resolve to the same profile dir (confirmed by grep across all
  four — none of them accept an account/identity parameter).
- Per `scripts/PLAYWRIGHT-SETUP.md`, that profile is logged into **Facebook as Heath personally**.
  There is no second personal FB login anywhere in the profile.
- `docs/TC-DISCOVERY-CAMPAIGN.md` (2026-09-06 verified recon, rendered pages, logged in) confirms
  this in practice: every group in that recon table is marked **"NO-GO (Pages can't post into
  groups)"** for the MeetDossie Page, and **GO — Heath personal** for the same content. The only
  group where the Page identity is usable is The Founding Files (Dossie's own group, which
  MeetDossie Page admins) — and that group has 5 members and zero posts in the last month, so it's
  not a real engagement venue.
- The MeetDossie FB **Page** exists and is Zernio-connected (`zernio_account_id
  69f253c3985e734bf3d8f9bc`, per `docs/PIPELINE.md`) — that's the feed/Reels identity, separate
  system, not usable for groups.

**What this means for Heath's ask ("for my KW account and the dossy account"):** there is no
second FB identity to target today. The realistic reading is content lane, not login — some posts
run in Heath-the-working-agent voice (market takes, client wins, Hill Country/Boerne-specific),
others run in Heath-building-Dossie voice (TC pain points, the founder story). Same profile, same
login, different topic. I'd run with that unless Heath explicitly wants option B below.

**Option B — a literal second "Dossie" personal profile:** technically buildable (new Chrome
profile, new FB signup, its own warm-up period) but flagging the real cost before anyone builds
it:
- Facebook's terms require a personal profile to represent a real individual, not a brand/persona.
  A profile impersonating "Dossie" as a person is a policy violation FB actively detects and
  purges — this is not a gray area, it's Meta's stated real-name policy, and a purge risks the
  primary account too if they're ever linked (same device fingerprint, same IP, same payment
  method downstream).
- Even if built, a brand-new profile has zero group history and most groups gate posting behind
  membership tenure/admin approval for new accounts — it would need weeks of organic warm-up
  before it could post anywhere without getting flagged, and none of that warm-up work exists yet.
- The right vehicle for a "Dossie says this" voice, if Heath wants one, is the existing MeetDossie
  Page posting into public spaces Pages CAN reach (its own feed, Founding Files, public comments
  on other Pages) — not a second fake personal profile fighting group admission rules.

**Recommendation:** stay on one identity (Heath personal) for all 5 target groups, split by
content lane not login, and don't build a second profile without Heath explicitly weighing the
ToS risk above.

---

## 2. Content types beyond questions

Ranked by expected comment volume vs. admin-flag risk. All ASCII, no em-dashes, Heath's voice
(warm, direct, first person — these are Heath's own group posts, not Zernio persona content, so
the third-person rule in `docs/PIPELINE.md` doesn't apply here, same call `TC-DISCOVERY-CAMPAIGN.md`
already made).

**1. Ask-for-advice / discovery question (proven, keep using it)**
Highest volume-to-risk ratio we have real data on: 9 comments and 3 comments respectively from
the two 2026-09-07 posts, still collecting 48h later. Zero risk — you're not selling anything, you
CAN'T be flagged for self-promo because there's nothing to promote.
> "Anyone here ever had a deal almost fall apart because of something buried in the option
> period? Not asking for tips, just want to know I'm not the only one who's had that
> stomach-drop moment. What happened?"

**2. Founder pain story (proven format per sage-engagement-rules-by-platform.md)**
Second-highest — story format outperforms generic questions because it's specific and readable.
Low-medium risk: keep the product mention soft and only in the last line, or drop it entirely for
groups that ban self-promo.
> "Had a TC quit on me at 4:30am while I was in Italy, mid-option-period on three deals. Talked a
> client through a TREC amendment from a hotel lobby on bad wifi. That's the morning I decided
> paperwork couldn't depend on one person's schedule anymore. Anyone else had the 'this can't
> happen again' moment with a transaction?"

**3. Contrarian take / "here's what I'd push back on"**
High comment volume when it's genuinely debatable (not inflammatory) - agents love arguing about
practice norms. Medium risk: a badly-worded contrarian post reads as bait and gets reported faster
than any other format, so it needs a real, defensible position, not manufactured outrage.
> "Unpopular opinion: waiving the option period to win a bid isn't brave, it's just moving the
> risk from the seller to you. I get why buyers do it in this market. I still think agents should
> push back on it harder than most of us do. Anyone actually had it blow up on a client?"

**4. Teardown / "what I got wrong"**
Builds credibility fast, moderate comment volume, very low risk (self-deprecating posts almost
never get reported). Good for a new profile or a group you haven't posted in yet.
> "Missed a repair-amendment deadline early in my career because I was tracking dates in my head
> instead of writing them anywhere. Cost my seller leverage in a negotiation that should've gone
> our way. Wasn't a system failure - I didn't have a system. What's the mistake that actually
> changed how you track deadlines?"

**5. Resource/checklist give-away**
Solid volume if the resource is genuinely useful and not a lead-gen trap (no email-gate, no "DM me
for the link" tactic - both are the exact banned behavior in `sage-engagement-rules-by-platform.md`).
Low-medium risk, but heavier admin scrutiny than pure questions because it can read as content
marketing even when it's free.
> "Made myself a one-pager of every TREC deadline that has a hard dollar consequence if missed
> (option fee, earnest money, financing addendum). Happy to drop it in the comments if people
> want it - just say the word so I'm not spamming a link nobody asked for."

**6. Celebrate someone else's win (comment format, not a group post)**
Not a post you originate - this is a comment on someone ELSE's win post ("just closed my first
deal," "hit X transactions this year"). Zero admin risk since you're not posting, and it's the
single best way to build standing in a group before you ever post there yourself. This is what
the comment-opportunity pipeline should be finding and isn't doing enough of yet (see #5 below).

**7. Poll-style either/or**
Cutting this from the active rotation. It works on Instagram/Twitter but underperforms in FB
groups specifically per `sage-engagement-rules-by-platform.md` - the algorithm rules note
long-form (200-500 words) beats short posts in real-estate groups because "the audience reads
slowly and rewards substance." A binary poll reads thin next to formats 1-4. Keep in the back
pocket for a slow week, not the default.

**Safe for a brand-new account with no group history:** #1 (ask-for-advice) and #4 (teardown) -
neither can be read as promotional, both build credibility without asking for anything. #2 and #5
need at least some standing in the group first. #3 needs the MOST standing - a contrarian take
from an unknown name reads as trolling.

---

## 3. Cadence

Current state per `comment-caps.js`: `facebook_auto` 8/day cap (automated initiated comments),
`facebook_reply` 10/day cap (automated replies-to-replies), both barely used historically
(`comment_caps_state` shows exactly 3 days with any FB activity ever: 2026-06-12, 2026-09-08,
2026-09-09). There's real headroom.

**Group POSTS (originated discussions/stories from formats #1-5 above) — 1/day, rotating, never
repeat a group same week:**

| Day | Group | Time (CST) | Format |
|---|---|---|---|
| Mon | `kw_re_group` (home turf) | 7-9am | Ask-for-advice or teardown |
| Tue | `tx_re_agents` | 7-9am | Founder pain story or discovery question |
| Wed | `tc_admins` | 7-9am | Ask-for-advice (TC-specific angle - this is Door B's actual audience) |
| Thu | `tc_vas` | 7-9am | Resource give-away or teardown |
| Fri | rest / catch-up (no new post) | - | reply to whatever's still live from Mon-Thu instead |
| Sun | `dfw_network_collab` | 8-10pm | Founder pain story (this group has the best real engagement of the five, save the strongest format for it) |

Why not daily-into-every-group: the 2026-09-07 posts were still pulling comments 48h later - a
second post into the same group before that tail dies buries your own live thread and looks like
spam-posting to the algorithm (velocity in the first 30 min is what ranks, and a fresh post
competing with your own older one for attention hurts both). One cycle/week per group also matches
the "1 self-promo post/week max" norm most of these groups run on, even for posts that aren't
overtly promotional - better to under-post than get muted.

**Comments (auto-hunt + reply pipeline) — keep running daily, no change to caps**, once the stall
in #5 is fixed. At current cap (8/day auto-initiated + 10/day auto-reply) this is already the
higher-volume half of "daily interaction" Heath asked for - it just isn't producing output right
now.

**By account:** all of the above runs through the single Heath-personal identity from #1. There's
no second account to split cadence across today.

---

## 4. Group rules check (the 5 groups in `comment-hunt-groups.json`)

| Group | Rules status | Verdict |
|---|---|---|
| `dfw_network_collab` - DFW Realtors - Network & Collaborate (38.7K) | **Verified** in `group_registry`: "No promotions or spam... includes business promotion posts, Open Houses and New Listings." | Value-only, no exceptions. Best real engagement of the five (11 of 21 live comment-opportunity candidates came from here) - protect it, never pitch here. |
| `tx_re_agents` - Texas Real Estate Agents (22K) | **Partially verified** - has a `group_registry` row (72h cool-down, last posted 2026-08-18) but `promo_policy` field is empty; never rules-recon'd. Real data point: the 2026-09-07 discovery question landed 3 comments with no pushback. | Tolerates plain questions. Treat as value-only until a real recon pass reads the rules tab. |
| `kw_re_group` - Keller Williams Real Estate Group (28.6K) | **Not in `group_registry` at all** - no rules captured, ever. "Home turf" note in `comment-hunt-groups.json` is a description, not a verified rule read. | Unverified. Product mention as a personal recommendation (not a pitch) is plausible given the KW-internal audience, but don't assume it - recon first. |
| `tc_admins` - Transaction Coordinators and Admins for RE (29.8K) | **Not in `group_registry`.** Zero comment-opportunity candidates found here yet either (0 of 21). | Unverified and currently under-scanned. This is Door B's actual audience - worth a dedicated recon pass before the Wed slot above goes live. |
| `tc_vas` - TC and VAs for RE (10.9K) | **Not in `group_registry`.** 2 of 21 candidates found here. | Same gap as `tc_admins` - recon before posting. |

**Live example of what "unverified" costs:** `group_posts` has one `blocked_group_rules` row
(Texas Real Estate Network, not one of these 5) where the post never went live because the
account had never clicked through that specific group's "agree to group rules" banner - an
account-level admission gate, separate from content policy, and it silently ate the post (first
comment was seeded against a post that was never actually live). **Action before Wed/Thu slots
above run for real:** confirm the DossieBot profile has clicked "I agree" on every rule prompt in
`tc_admins` and `tc_vas`, not just joined - the two groups with zero verified history are exactly
where this failure mode would repeat.

**Safe for anything product-adjacent:** none of the 5, today. `dfw_network_collab` explicitly bans
it. The other 4 are unverified, not confirmed-safe - default to value-only across all five until
each gets the same rendered-page recon `TC-DISCOVERY-CAMPAIGN.md` already ran for other groups.

---

## 5. The gap

**Posting is manual by design** (CLAUDE.md RULE 4): `cron-daily-fb-posts.js` runs daily at 14 UTC,
auto-drafts up to 8 group posts from the rotation, sends Telegram approval - but the actual FB
submission is a human running `node scripts/fb-group-poster.js --post-id <uuid>` locally. Nobody's
been running it: 36 `draft` rows sitting since July, 2 `approved` rows stale since 2026-08-17.

**Live finding, not from Heath's brief - commenting is ALSO currently stalled, not "fully
automated" as assumed.** `cron-comment-opp-approval` is scheduled every 30 minutes
(`vercel.json`) and is the step that turns a found candidate into a Telegram-approvable draft. Its
own run log (`cron_runs` table) shows **last successful run 2026-09-08T22:21 UTC** - it is now
2026-09-09T13:58 UTC, ~16 hours and 32+ missed scheduled runs later. All 21 `comment_opportunities`
rows (found ~2026-09-09T00:03, after that last run) sit at `status='found'` with `comment_draft`
null - nothing has been sent to Heath to approve. **Flag for Carter/Atlas to check the Vercel cron
logs for this function** - either it's erroring silently or the schedule isn't firing; either way
this is the "commenting" half of Heath's ask and it's not running right now.

**What full automation would take, and whether it's a good idea:**

- *Posting:* a serverless cron can't drive a local Playwright/Chrome session (same reason the FB
  group pipeline is local-only today - noted in `PLAYWRIGHT-SETUP.md`). Real options: (a) a
  persistent local Windows Task Scheduler job that polls `group_posts` for `status='approved'` and
  runs `fb-group-poster.js` automatically (straightforward, reuses the existing script, no new
  infra) - Heath still approves every post via Telegram, only the "run the command" step goes
  away; (b) move the whole browser session to something serverless-reachable (a hosted headless
  browser service) - bigger lift, and directly conflicts with the "no headless Chrome to
  facebook.com, most sophisticated bot detection of any platform" rule in
  `sage-engagement-rules-by-platform.md`. (a) is the sane build if Heath wants this closed.
- *Should the human tap stay on posting specifically (not commenting)?* Yes, keep it. A bad
  comment on someone else's post is low-stakes and reversible (delete it, one thread affected). A
  bad top-level GROUP POST is a standalone artifact with Heath's name on it, in front of the whole
  group, potentially the thing that triggers `blocked_group_rules` or a mute if it reads wrong -
  worth the extra 30 seconds of Heath tapping Approve before it goes out. Automate the "I already
  approved this, now go post it" step (option a above), not the approval decision itself.
