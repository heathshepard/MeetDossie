# TC Discovery Campaign — Plan Only, Nothing Posted

Built by Sage, 2026-09-06. Status: DRAFT — awaiting Heath's approval on each post before anything goes out. No posts, comments, or contacts have been made building this plan.

**2026-09-06 (later session): rules recon COMPLETE.** Every venue below was verified from rendered pages in a real logged-in browser (DossieBot Chrome profile for Facebook; fresh Chrome profile for Reddit — no login needed for public subreddit rules). Raw innerText dumps + screenshots: `scripts/.tc-rules-recon/`. Nothing was posted, commented, joined, or clicked beyond navigation. See "VERIFIED RECON RESULTS" section below — it supersedes the earlier unverified group table, and **5 of the 9 external FB group URLs turned out to be dead.**

Goal: get real agents' own words on what they want from a TC and TC software, to feed Dossie's product and marketing (same "real language, not guessed" pattern as `reddit_pain_language`).

---

## 1. The five questions, rewritten as real posts

One question per post (per the rule — a list gets scrolled past). ASCII only, Heath's voice: warm, direct, working-agent credibility, first person is correct here (these are Heath's own posts, not Zernio persona content, so the third-person persona rule in `docs/PIPELINE.md` doesn't apply).

| # | Original question | Draft post | Dossie-safe or personal-only |
|---|---|---|---|
| Q1 | What do people want in a TC? What do they look for? | "Genuine question for other agents, not selling anything - when you've hired a TC or thought about it, what actually makes you say yes to one over another? What matters most to you?" | Dossie-safe (no product mention either way) |
| Q2 | What's the #1 issue people have with a TC? | "Curious what other agents have run into - if you've used a TC before, what's the ONE thing that drove you the most crazy about the experience? Communication, timelines, something falling through the cracks? Want the real pain point, not a guess." | Dossie-safe |
| Q3 | What's something they wish a TC would do that they don't? | "If you could make your TC do ONE thing they currently don't - what would it be? Something you've always wanted but never actually got. What's missing for you?" | Dossie-safe |
| Q4 | What TC softwares do people recommend and why? | "Question for the group - what TC software or platform do y'all actually use and like? And why that one over the others? Trying to get a real read on what's working day to day." | **PERSONAL ONLY** |
| Q5 | What do people look for in a TC software? | "For agents using or shopping TC software - what actually matters to you picking one? Price, ease of use, how well it talks to your MLS/zipForm, support, something else? Trying to understand what people actually weigh." | **PERSONAL ONLY** |

**Why Q4/Q5 are personal-only, restated:** asking "what software do you recommend" from @meetdossie invites a public thread of people naming competitors directly under Dossie's own post — free advertising for ListedKit, Transactly, SkySlope, Dealia, Sellers Shield under Dossie's name. Q1-3 carry no such risk regardless of account because there's no product named to compare against.

**Zero first-comment seeding on any of these five posts.** The existing `group_posts` pipeline (`fb-group-poster.js`) supports a first-comment Dossie plug, but seeding a Dossie mention under a market-research question contaminates the answers and reads as astroturfing on his own post. This campaign runs with `first_comment_body` left null on every row.

---

## 2. VERIFIED RECON RESULTS — 2026-09-06, rendered-page reads, logged in as Heath

Method: Playwright against the DossieBot Chrome profile (logged in as Heath's personal FB — composer renders "Comment as Heath"), visiting each group's feed + `/about` page. Member counts, public/private status, activity stats, and rules text below are quoted from FB's own rendered "About this group" / "Activity" / "Group rules from the admins" blocks. Evidence: `scripts/.tc-rules-recon/<slug>-{feed,about}.{txt,png}`.

**Structural fact confirmed on-page: Heath's profile is not currently a member of ANY group below — every single one, including The Founding Files, renders a "Join group" button.** Private groups can't even be read, let alone posted to, until a join request is approved (typically days). This adds lead time in front of the whole schedule.

| Group | Members | Public/Private | Vendor-post rule (quoted) | Activity (FB's own stats) | GO/NO-GO Dossie | GO/NO-GO Heath personal |
|---|---|---|---|---|---|---|
| The Founding Files (`/groups/860956437036808/`, resolved from share link) | **5** | Private | n/a — Heath/Dossie owns it ("MeetDossie is an admin") | **"No posts today / No posts in the last month"** — dead | GO (as MeetDossie Page admin) | GO — but Heath's personal profile must first join its own group |
| Texas Realtors (`/groups/16168503259/`) | 493 | **Public** | **No written rules exist** — the about page renders no "Group rules from the admins" block at all (DFW's page proves FB renders that block when rules are set) | "10 in the last month, +8 members in the last week" — alive but thin; visible feed is vendor spam (IRS-appeals video, HOA Report ads) with no visible engagement | NO-GO (Pages can't post into groups) | **GO** — no rule to violate; expect low response volume given the spam-heavy feed |
| DFW Realtors (`/groups/dfwrealtorgroup/`) | **8,091** | Private | Rule 3: **"Vendors - No Blatant Promotion — Share client stories, before/after pics, or bring value to the group. Boring azz promotion will get post approval turned on."** (also: "No open houses", "Don't post listings from the MLS") | **"3 new posts today, 167 in the last month"** — the liveliest verified group by far | NO-GO | **GO** — Q1-Q5 are questions, not promotion; rule 3 only throttles blatant promo. Must request to join first (private) |
| Real Estate Agents Mastermind (`/groups/realestateagentsmastermind/`) | 56 | Private | Not visible to non-members | **"No posts in the last month"** — dead | NO-GO | **NO-GO — dead, not worth a slot** |
| New Real Estate Agents (`/groups/newrealestateagents/`) | 35 | Public | No rules block rendered | **"No posts in the last month"** — dead; feed is one admin posting YouTube links | NO-GO | **NO-GO — dead** |
| Greater Houston Area Realtors (`/groups/houstonarearealtors/`) | — | — | — | — | **URL DEAD** — "This content isn't available right now" | URL DEAD |
| The Giving Agents (`/groups/thegivingagents/`) | — | — | — | — | **URL DEAD** | URL DEAD |
| San Antonio Real Estate Agent Forum (`/groups/sanantoniorealestateforum/`) | — | — | — | — | **URL DEAD** | URL DEAD |
| Real Estate Agents in USA (`/groups/realestateagentsinusa/`) | — | — | — | — | **URL DEAD** | URL DEAD |
| Top Real Estate Agents (`/groups/toprealestateagents/`) | — | — | — | — | **URL DEAD** | URL DEAD |
| r/realtors | **263K** (2.9K online at read time) | Public | Rule 1: **"No Promotional Posts (SPAM), Recruitment, or Referral Seeking"**. Rule 7: **"No Technology, Vendor and Educator Discussions - try r/RealEstateTechnology"** | Very alive — posts 29 min / 32 min / 10 hr old on front page; a 10-hr-old post ("Growing pains") is literally an agent drowning in post-contract ops asking for help, i.e. exactly this campaign's territory | NO-GO (rule 1) | **Q1-Q3: GO with caution** (frame as hiring/ops question, never "what vendor/software" — a strict mod could read TC talk as rule-7 vendor discussion). **Q4/Q5: NO-GO — rule 7 bans software/vendor discussions outright.** |
| r/RealEstateAgents | **57** (9 participating at read time — yes, fifty-seven; sidebar rendered "57 Real Estate Agents / 9 Participating", screenshot on file) | Public | Rule 3: **"Marketing/Vendor discussions are encouraged"**; sidebar: **"LEAD GEN TOPICS ENCOURAGED — we allow posts that discuss vendors, as long as they're not overly self-promotional"** | Near-dead — front page is 6-days-old, then 1-7 months old | Rules permit it, but | Rules-GO / **value-NO-GO** — 57 members and month-old front-page posts make it worthless as a research venue |

### What changed vs. the original plan
1. **5 of 9 external FB groups don't exist at their registry URLs** (all five render FB's "This content isn't available right now" page). They came from `group_registry`'s unverified "(alt URL)" guesses. Remove or re-discover them via `fb-group-discovery.js` before they appear in any future plan.
2. **The Week 4/5 Reddit slots for Q4/Q5 in r/realtors are killed by rule 7** ("No Technology, Vendor and Educator Discussions"). The rule even names the redirect: r/RealEstateTechnology — that subreddit was NOT verified this session and needs its own rules read before it inherits those slots.
3. **r/RealEstateAgents is not a real venue** (57 members). The doc previously treated it as a peer of r/realtors.
4. **Founding Files is 5 members and has had zero posts in a month** — the "pilot round" there will produce approximately nothing, and Heath's personal profile isn't even a member (the group is admined by the MeetDossie Page). Also note: rendered count is 5 members, vs. 8 active founding customers in `docs/CUSTOMERS.md` — most founding members never joined the group.
5. **Heath is a member of zero target groups.** DFW Realtors (private) needs a join request approved before anything can run there.

### Unverified / still open
- Rules-tab contents for private groups Heath isn't in (DFW's rules DID render publicly and are quoted above; Mastermind's did not — moot, it's dead).
- r/RealEstateTechnology rules (candidate replacement venue for Q4/Q5) — not read this session.
- Whether Texas Realtors' admins apply unwritten moderation despite having no posted rules — unknowable from outside; low risk for question posts.

---

## 3. Reddit — r/realtors (r/RealEstateAgents removed)

Must run from Heath's **personal** Reddit account, never the automation account already wired for `comment-caps.js`'s Reddit engagement (3/day cap, existing scripts `reddit-poster.js`/`reddit-scanner.js`).

**Open item, human action required:** no confirmed personal Reddit username for Heath on file (checked `docs/ENV.md`, `docs/PIPELINE.md`, memory). Confirm one exists before scheduling anything here; if not, one needs post/comment history before a cold post to r/realtors won't read as a throwaway.

**Rules now verified (2026-09-06, rendered sidebar, dumps in `scripts/.tc-rules-recon/r-realtors2.txt` + `.png`):**
- r/realtors rule 1: "No Promotional Posts (SPAM), Recruitment, or Referral Seeking"
- r/realtors rule 6: "No Repetitive Topic or Question"
- r/realtors rule 7: "No Technology, Vendor and Educator Discussions - try r/RealEstateTechnology" — **this bans Q4/Q5 there, full stop.**
- Q1-Q3 fit as hiring/ops questions (the sub organically carries them — a front-page post at read time was an agent at 25+ transactions/yr asking how to handle everything "post BRBC/Listing Agreement"). Keep TC framed as "hiring help," never "choosing a vendor," and check recent history first per rule 6.

---

## 4. Schedule — REVISED after recon (was: 5 weeks across 9 FB groups + 2 subreddits; now: 2 live FB venues + 1 subreddit survive)

Prerequisites before Week 1: (a) Heath's profile requests to join DFW Realtors + Texas Realtors + The Founding Files; (b) personal Reddit account confirmed; (c) each post individually approved by Heath.

| Week | Day | Question | Account/venue | Group/subreddit | Notes |
|---|---|---|---|---|---|
| 1 | Tue | Q2 | Heath personal (Reddit) | r/realtors | Lead venue — see section 6 |
| 1 | Fri | Q1 | Heath personal | Texas Realtors (public, no posted rules) | Low expectations; costs nothing |
| 2 | Tue | Q1 | Heath personal | DFW Realtors | Only after join approved; liveliest FB group verified |
| 2 | Fri | Q3 | Heath personal (Reddit) | r/realtors | Space per rule 6 (no repetitive topics) |
| 3 | Tue | Q3 | Heath personal | DFW Realtors | |
| 4 | — | Q4/Q5 | **BLOCKED pending new venue** | r/RealEstateTechnology (rules unread) or DFW Realtors | r/realtors rule 7 bans software questions; verify r/RealEstateTechnology rules first. DFW's rule 3 permits vendor discussion that "brings value." |

Founding Files: post Q1-Q5 freely as admin whenever — but with 5 members and zero recent activity, treat it as a bonus, not a pilot gate.

Dead-URL groups (Houston, Giving Agents, SA Forum, RE Agents in USA, Top RE Agents) and dead groups (Mastermind, New Real Estate Agents) are dropped entirely. If SA/Houston coverage matters, run `fb-group-discovery.js` for fresh candidates and rules-check them the same way before adding.

---

## 5. Capture plan

**Recommendation: extend `reddit_pain_language`'s pattern with a new table, don't overload the existing one.**

`reddit_pain_language` is purpose-built for unprompted pain language scraped passively from Reddit, feeding `cron-generate-posts.js`. Its schema is shaped around ranking organically-discovered posts, not campaign-question responses across two platforms.

**New table: `tc_discovery_responses`** (recommend, don't build — Carter's call to actually migrate):
- `id`, `campaign_question` (Q1-Q5 enum or literal text), `platform` ('facebook' | 'reddit'), `source_group_or_subreddit`, `post_url`, `respondent_name_or_handle`, `response_text` (verbatim), `posted_at`, `captured_at`, `tags` (free-text array, tagged during review, same shape as `pain_categories`).
- Populate manually at first — low volume, and the value is in actually reading every response.
- Once populated, becomes content fuel the same way `reddit_pain_language` already is.

---

## 6. If Heath only runs one

**Q2 in r/realtors.** (Changed from "San Antonio Real Estate Agent Forum" — that group's URL is dead.) The case: 263K members vs. 8.1K in the best FB group; posts landing every half hour at read time; the exact question type already lives there organically (a front-page post at recon time was an agent asking how to survive post-contract ops volume); it needs no join-approval lead time; and Q2 as drafted names no product and asks for no vendor recommendation, so it clears rule 1 and stays out of rule 7's software/vendor territory. Only dependency: Heath's personal Reddit account. If FB-first is preferred instead: DFW Realtors after the join request clears — 167 posts/month and a vendor rule that explicitly only targets "blatant promotion."

---

## Open items before anything goes live
1. ~~FB group vendor rules~~ **DONE 2026-09-06** — verified from rendered pages, quoted above.
2. ~~Reddit rules~~ **DONE 2026-09-06** for r/realtors + r/RealEstateAgents. **NOT done** for r/RealEstateTechnology (the only surviving Reddit venue for Q4/Q5).
3. **Personal Reddit account** — still unconfirmed. Human action required.
4. **Join requests** — Heath's profile is in none of the target groups; DFW Realtors (private) is the gating one.
5. Every post still needs Heath's explicit approve before it goes anywhere — nothing is auto-scheduled or queued.

---

## 2026-09-06 EXECUTION UPDATE (Sage) — supersedes schedule + open items above

Heath authorized posting (relayed via Cole, campaign-level approval, no per-post gate).

**Reddit is dead as a venue until an account exists. u/Icy_Response3978 is BANNED by Reddit** — rendered profile says "This account has been banned" (`scripts/.tc-rules-recon/icy-user-profile.{txt,png}`). Independently, its credentials are gone everywhere: no REDDIT_* in `.env.local`, none in Vercel dev/prod (pulled 2026-09-06), none in Bitwarden (33 items listed), DossieBot profile `reddit_session` cookie absent. Q1-Q3 in r/realtors and Q4/Q5 in r/RealEstateTechnology all require a real account with some karma — r/RealEstateTechnology rule 5 is literally "New posts require some karma" (rules verified from rendered sidebar: 1 Give more than you get, 2 Be kind and courteous, 3 Questions are just fine, 4 Marketing/Vendor discussions are encouraged, 5 New posts require some karma, 6 No Spam — `scripts/.tc-rules-recon/r-retech-rules.txt`). A fresh zero-karma account posting market research = auto-removed. **Human action: Heath needs a personal Reddit account (or confirm an existing one).** Once one exists, Q4/Q5 are rules-legal in r/RealEstateTechnology.

**Founding Files: dropped entirely** (5 members, zero posts in a month, Heath: "founding files does nothing").

**Facebook execution state:**
- `scripts/.sage-tc-fb-login-driver.cjs` running (Windows node, real Chrome window on DossieBot-Sage profile) — sitting at FB login for Heath's credentials. On login: identity screenshot -> Sage verifies personal-vs-page -> DFW Realtors join request with truthful membership answers (KW City View, San Antonio). Control file: `scripts/.sage-tc-driver-control.json`; status: `.sage-tc-driver-status.json`; shots: `.sage-tc-driver-shots/`.
- After identity confirms personal: `scripts/.sage-tc-join-texas-realtors.cjs` joins the public Texas Realtors group, then Q1 posts there via the standard `group_posts` row + `fb-group-poster.js --post-id` flow. `first_comment_body` stays null (no seeding on research posts).

**Firing order once venues open (final copy = Section 1 table, unchanged):**
| Order | Q | Venue | Account | Gate |
|---|---|---|---|---|
| 1 | Q1 | Texas Realtors (public FB) | Heath personal | FB login done + instant join |
| 2 | Q1 (then Q3 ~1wk later) | DFW Realtors | Heath personal | join approval (days) |
| 3 | Q2 | r/realtors | Heath personal Reddit | account exists |
| 4 | Q3 | r/realtors | Heath personal Reddit | ~1 wk after Q2 (rule 6 spacing) |
| 5 | Q4, Q5 | r/RealEstateTechnology + DFW Realtors | Heath personal | account w/ karma / join approval |

---

# 2026-09-07 EXPANSION (Sage) — 13 questions, 17 verified venues, 2-week / 4-per-day calendar

**Supersedes the schedule sections above.** Built plan-only: NOTHING in this section has been posted. Today's quota (4 posts) was already spent before this plan was built — Q1 live in Texas Realtors (posted 2026-09-06), Q2 live in DFW Realtors - Network & Collaborate, Q3 live in Texas Real Estate Agents (cleared that group's admin approval), Q4 live in Texas Transaction Coordinator (all verified from rendered feeds, `scripts/.sage-tc-day3-verify.json`).

**The venue problem from the earlier plan is solved.** The earlier recon assumed Heath was in zero groups because it checked 9 stale registry URLs. The verified membership dump (`scripts/.sage-tc-day2-result.json`, rendered from /groups/joins/ logged in as Heath) shows **117 joined groups**, ~35 of them real-estate audiences. On 2026-09-07 every plausible agent/TC candidate among them was verified by rendering its /about page in a real logged-in browser (DossieBot-Sage profile, read-only, no posts/joins/clicks). Raw dump: `scripts/.sage-tc-day4-venue-recon.json`; screenshots: `scripts/.sage-tc-driver-shots/day4-*-about.png`; recon script: `scripts/.sage-tc-day4-venue-recon.cjs`.

## A. Questions Q6-Q13 — the commercial layer (pricing, switching, hiring moment)

Same rules as Q1-Q5: one question per post, ASCII only, Heath's working-agent voice, first person, no product mention, no links, `first_comment_body` null (no seeding on research posts). Variant B exists so the same question never posts with identical text in two groups — vary further per group at queue time (swap opener, region mention, clause order).

| # | Question | AUDIENCE | Draft post (variant A) | Variant B opener | Dossie-safe? |
|---|---|---|---|---|---|
| Q6 | What do you actually pay your TC? | **Agents** | "For the agents using a TC - what do y'all actually pay? Per file, flat monthly, something else? Trying to get a real feel for the going rate, not what the websites say." | "Honest money question, since nobody ever posts real numbers - if you use a TC, what does it actually run you per file or per month?" | Dossie-safe (no vendor naming invited) |
| Q7 | How did you find your TC? | **Agents** | "How did you find your TC? Referral from another agent, through your brokerage, a Facebook group, one of those TC agencies? Curious what actually worked for people." | "For those with a TC you trust - where did they come from? Did you shop around or just take a referral?" | **PERSONAL ONLY** — invites naming TC agencies/vendors |
| Q8 | What would make you switch or fire a TC? | **Agents ONLY — never a TC group** (this is the exact miss from before: a bad-TC question in a room of TCs) | "Has anyone ever fired a TC or switched to a new one? What was the final straw? Not looking to bash anybody - just curious what actually pushes people to make a change." | "What would it actually take for you to leave a TC you have used for a while? Curious where the line is for people." | Dossie-safe |
| Q9 | Do you NOT use a TC, and why not? | **Agents** (the unasked segment) | "For the agents who do NOT use a TC - what keeps you doing your own contract-to-close? Cost, control, been burned before, just never felt the need? No wrong answers, genuinely curious." | "Rough guess says most agents handle their own files solo. If that is you - is it a money thing, a control thing, or something else?" | Dossie-safe |
| Q10 | At what volume did you finally hire one? | **Agents** | "At what point did you finally hire a TC? Was there a deal count where doing it all yourself stopped making sense, or one specific transaction that broke you? Trying to figure out where that line really is." | "How many files a month were you carrying when you finally handed off contract-to-close? Or are you past that point and still doing it all?" | Dossie-safe |
| Q11 | What do you still do yourself? | **Agents ONLY — not TC groups** (implies TC shortfall) | "For agents with a TC - what do you still end up doing yourself that you kind of assumed they would handle? Where does the handoff actually stop in practice?" | "Real question - even with a TC on the file, what part of contract-to-close never actually leaves your plate?" | Dossie-safe |
| Q12 | What do you wish agents understood before hiring you? | **TCs** | "Question for the TCs in here - what do you wish agents understood BEFORE they hired you? The thing you find yourself explaining over and over on every new file." | "TCs - what is the one expectation agents show up with that you always have to reset on day one?" | Dossie-safe |
| Q13 | How many files can you actually carry? | **TCs** | "For the TCs - how many active files can you realistically carry at once before quality starts to slip? And what actually caps it - the paperwork, the communication, the chasing signatures?" | "TCs, real capacity question - what is your honest max file count, and what is the bottleneck that sets it?" | Dossie-safe |

Note on "Dossie-safe": academic for this campaign — every scheduled post runs from Heath's personal profile because FB Pages cannot post into groups at all. The tags matter only if any question is ever reused as Dossie-account content elsewhere. Q4/Q5/Q7 stay personal-only forever (they invite competitor/vendor naming under a Dossie post).

## B. VERIFIED VENUE TABLE — rendered /about pages, 2026-09-07, logged in as Heath

All groups below: Heath is a confirmed member ("Joined" rendered). Activity numbers are FB's own "Activity" block, quoted same-day.

### GO — primary rotation (agents)

| Code | Group | Members | Pub/Priv | Activity (posts today / month) | Rules that matter (quoted) |
|---|---|---|---|---|---|
| A | DFW Realtors - Network & Collaborate (`/groups/531847711158328/`) | 38.7K | Public | 27 / 682 | R4: "No promotions or spam... includes business promotion posts, Open Houses and New Listings." Questions are not promotion. |
| B | Texas Real Estate Agents (`/groups/texasusarealestateagents/`) | 22.0K | Public | 14 / 716 | No rules block rendered. **Posts require admin approval** (Q3 sat "Pending admin approval" before going live) — build approval lag into expectations. |
| C | Real Estate Agents in USA (`/groups/2071832753093090/`) | 31.3K | Public | 156 / 4,790 | R4: "No Over Promotions or Spam... Over Self-promotion, spam and irrelevant links aren't allowed." |
| D | All Realtors and related Professionals (`/groups/350007408391439/`) | 85.0K | Public | 279 / 6,768 | No rules block rendered. Audience is mixed pros (realtors, brokers, PMs, investors) — expect some noise. |
| E | Real Estate Agents Group (`/groups/LizLuxuryRealEstateAgent/`) | 108.1K | Public | 51 / 1,568 | R3: "No Promotions or Spam"; R5: "MUST BE A LICENSED REAL ESTATE AGENT/ BROKER" — purest big agent audience on the list. |
| F | Dallas Fort Worth Area Realtors (`/groups/dfwrealestategroup/`) | 36.1K | Public | 69 / 2,684 | Desc: "advertise service and properties and ask questions." R1: "No Irrelevant Material or Spam." |
| G | Dallas, Texas Realtors (`/groups/dallasrealtors/`) | 46.5K | Public | 26 / 959 | Kindness/privacy rules only. |
| H | Realtor Networking Group DFW (`/groups/2031932517088794/`) | 14.1K | Public | 28 / 1,370 | No rules block. Desc: "for realtors by realtors... tips and advice." |
| I | DFW Real Estate Group (`/groups/2328098604145675/`) | 21.4K | Public | 41 / 2,069 | Kindness/privacy rules only. |
| J | San Antonio and Boerne Area RE Agent Network (`/groups/504517559676747/`) | 7.5K | Public | 20 / 699 | R2/R4: "No Promotions or Spam." Desc: agents "share information... and just vent if you need to" — venting is literally the format. Home turf. |
| K | San Antonio Real Estate Agent Forum (`/groups/SanAntonioRealEstateAgentForum/`) | 4.2K | Public | 3 / 112 | No rules block. Desc: "Realtor topics and discussions for realtors by realtors. This is not an area to post listings." Exactly right audience; modest volume. (The "dead URL" in the earlier recon was a different slug — this one is live and Heath is in it.) |
| L | All about Real Estate Houston (`/groups/1649764785300053/`) | 24.4K | Public | 24 / 685 | No rules block. Desc: "share best practices, questions." |
| M | D/FW REALTORS(R) (`/groups/1678001739174296/`) | 3.8K | Public | 11 / 730 | No rules block. Desc: "seek recommendations, gain advice." |
| N | Austin Texas Real Estate Agents (`/groups/470026499869867/`) | 2.3K | Private | 2 / 128 | Not visible (private) — question posts are the group's normal format per feed. |
| O | Keller Williams Real Estate Group (`/groups/kwrealestategroup/`) | 28.6K | Private | 49 / 1,854 | R2: "Keep posts real estate related"; R4: "Share value, not just promotions." Unofficial KW community — Heath's natural room. |
| T | Texas Transaction Coordinator (`/groups/495797981693614/`) | 70 | Public | 0 / 2 | No rules block. **Only TC-audience venue Heath is currently in.** Near-dead but Q4 already drew placement; the ONLY room for Q12/Q13 until bigger TC groups are joined. |

### GO with caution (backup slots)

| Group | Members | Activity/mo | Why caution |
|---|---|---|---|
| San Antonio Real Estate (Realtors, Investors, Lenders) (`/groups/438602583955514/`) | 28.1K | 2,505 | R2: "DO NOT post your services unless someone makes a post specifically asking"; R3: one warning then "$5 get out of jail fee." A question is not a service post, but this admin monetizes enforcement — use gentlest copy (Q1), one shot. |
| Texas Realtors (`/groups/16168503259/`) | 493 | 10 | Already used (Q1). Thin, vendor-spam feed, no rules. Bonus only. |
| Top Real Estate Agents (`/groups/toprealestateagent/`) | 30.7K | 136 | Low activity for size; R2 bans links (we post none); rules double as CallTend ads. Backup. |
| South Texas Realtors, Brokers, LOs, Builders (`/groups/5159910517462444/`) | 7.2K | 531 | Mixed pro audience (lenders/builders/credit repair). Backup. |
| Central Texas Realtors (`/groups/centraltexasrealtors/`) | 1.3K | 236 | Small but real. Backup. |
| Dallas Real Estate Agents (`/groups/dallasrealestateagents/`) | 1.5K | 171 | Small. Backup. |
| Your San Antonio Real Estate Agent (`/groups/500355691832841/`) | 607 | 161 | Small, local. Backup. |
| New Real Estate Agents TEXAS (`/groups/614122487084637/`) | 697 | 49 | Small; new agents = mostly pre-TC — good Q9/Q10 target if a backup slot is needed. |
| Texas Realtors & Lenders (`/groups/795659645955106/`) | 1.5K | 103 | Small, lender-mixed. Backup. |
| KW City View #LifeAtKWCV (`/groups/kwcityview/`) | 612 | 234 | Heath's own office — answers real but KW-skewed, and colleagues see the research. Heath's call, not scheduled. |
| Realtor & Builders (`/groups/740098209379964/`) | 9.2K | 496 | Listing-swap format ("Post Listings But NO SPAM"). Backup. |
| RE Agents & New Home Sales Consultants - Houston (`/groups/229483207082445/`) | 16.0K | 1,277 | Active and realtor-heavy, but NHS-counselor mix (the SA-411 problem, diluted). R2 limits service ads, not questions. Backup only. |

### EXCLUDED — and why (verified, not inferred)

| Group | Members | Why excluded |
|---|---|---|
| Texas Real Estate (`/groups/148196945552917/`) | 71.9K | Investor/flooring-company group. R1: "Please add 10-20 or more people before posting"; R4: "Off-market or investment deals only." (Already excluded, reconfirmed.) |
| Realtors SA/Boerne/Bulverde/NB - 411 New Homes (`/groups/752142151598217/`) | 6.8K | New-home inventory board ("inventory information from on site New Home Sales Counselors"). (Already excluded, reconfirmed.) |
| Real Estate Agents x Real Estate Investors (`/groups/offmarketpropertiespuregeniusmethod/`) | 85.6K | Investor-deal group, and effectively dead for its size (0 today / 55 per month). |
| Dallas/Fort Worth Realtor/Investor Network (`/groups/44555569140/`) | 22.7K | Investor-deal hybrid — wrong audience for TC pricing/hiring questions. |
| Dallas Real Estate Network DREN (`/groups/dallasrealestatenetwork/`) | 67.1K | Listing-dump board with consumers: R2 "Post the property's address in your post. All posts of properties without an address will be deleted." A question post is deletable on its face. |
| The Texas RE Network: Classifieds & Support (`/groups/texasrealestategroup/`) | 22.9K | Classifieds-ad format ("Classified Ads for Real Estate"); crypto/wholesaler-spam ruleset; not a discussion room. |
| Real Estate Agent Referral Group (`/groups/realestateagentus/`) | 7.9K | Dead: 0 posts today, 7 in the last month. |
| Broker Agent Advisor (`/groups/brokeragent/`) | 31.7K | Dead: 2 posts in the last month despite 31.7K members. |
| BREW: Boerne Real Estate netWorking (`/groups/brewmeetup/`) | 359 | Dead: 1 post in the last month. |
| Dalton Wade Texas Agents (`/groups/9453639261380671/`) | 277 | Another brokerage's house group + near-dead (14/mo). Wrong room for a KW agent's research. |
| DFW Real Estate Network (`/groups/dfwrealestatenetwork/`) | 12.4K | Consumer-leaning news/living group, not an agent room. |
| Phyllis Browning Company Agents | — | Another brokerage's internal group (excluded by name, not scanned). |
| Everything else in the 117 (consumer homes-for-sale, garage sale, Boerne community, MLM, hobby, military groups) | — | Not real-estate-professional audiences (excluded by name, not scanned). |

## C. 2-WEEK CALENDAR — Sep 8-21, 4 posts/day, Sundays off (~48 posts)

Rules enforced in this grid: max 4/day from Heath's personal profile; never the same question twice in one group; never two posts in one group on one day; same question spaced >= 2 days between appearances; max 3 posts per group across the fortnight; every post uses a distinct wording variant (A/B above + per-group tweaks) so no identical text crosses groups. Q12/Q13 (TC audience) go ONLY to venue T. Q8/Q11 never go to T.

| Date | Post 1 | Post 2 | Post 3 | Post 4 |
|---|---|---|---|---|
| Tue 9/8 | Q6 -> E (RE Agents Group) | Q8 -> F (DFW Area Realtors) | Q9 -> C (Agents in USA) | Q11 -> H (Realtor Networking DFW) |
| Wed 9/9 | Q7 -> D (All Realtors Prof) | Q10 -> G (Dallas TX Realtors) | Q2 -> L (Houston) | Q3 -> J (SA-Boerne Network) |
| Thu 9/10 | Q6 -> A (DFW N&C) | Q8 -> I (DFW RE Group) | Q9 -> K (SA Agent Forum) | Q1 -> M (D/FW REALTORS) |
| Fri 9/11 | Q7 -> E | Q10 -> C | Q2 -> N (Austin) | Q13 -> T (TX Transaction Coordinator) |
| Sat 9/12 | Q6 -> J | Q9 -> F | Q11 -> D | Q1 -> O (KW RE Group) |
| Sun 9/13 | — rest — | | | |
| Mon 9/14 | Q7 -> A | Q10 -> L | Q3 -> C | Q8 -> G |
| Tue 9/15 | Q6 -> B (TX RE Agents) | Q9 -> H | Q2 -> E | Q11 -> K |
| Wed 9/16 | Q7 -> I | Q10 -> J | Q3 -> F | Q5 -> M |
| Thu 9/17 | Q6 -> D | Q8 -> L | Q9 -> N | Q1 -> P (SA RE mixed — gentlest question only) |
| Fri 9/18 | Q7 -> O | Q10 -> M | Q2 -> H | Q11 -> G |
| Sat 9/19 | Q6 -> N | Q8 -> O | Q9 -> I | Q12 -> T |
| Sun 9/20 | — rest — | | | |
| Mon 9/21 | Q6 -> P | Q10 -> B | Q3 -> K | Q11 -> A |

Execution per post: insert `group_posts` row (group_name, group_url, post_body = that group's variant, status='approved', template_id='direct', first_comment_body=null), then `node scripts/fb-group-poster.js --post-id [uuid]`. Group B posts sit in admin approval — don't re-post if not instantly visible; check next day. If any post is admin-removed, drop that group from the remaining grid and pull a caution-list backup.

Question coverage across the fortnight: Q6 x7 groups, Q9/Q10 x6, Q7/Q8/Q11 x5, Q2/Q3 x4, Q1 x3, Q5 x1, Q12/Q13 x1 each (TC venue scarcity — see open item 2).

## D. CAPTURE — the answers are the deliverable

1. **Table:** `tc_discovery_responses` still does NOT exist (2026-09-07 grep: referenced nowhere but this doc). Carter builds it before Week 1 harvests: `id, question_id (Q1-Q13), platform, source_group, post_url, respondent_name, response_text (verbatim), responded_at, captured_at, replied (bool), tags text[]`. Unique on (post_url, respondent_name, md5(response_text)).
2. **Harvest script:** extend the proven permalink-verify pattern (`scripts/.sage-tc-day3-verify.json` flow) into `.sage-tc-harvest.cjs`: for every `group_posts` row in this campaign with a post_url, open the permalink, expand all "View more comments"/"See more", dump commenter + text verbatim, upsert into the table. Run at +24h and +72h after each post, then every 3 days while the thread moves. VERBATIM only — no paraphrase, the whole point is real language (same doctrine as `reddit_pain_language`).
3. **Reply to commenters — built in, not optional.** Every substantive comment gets a Heath-voice reply within ~24h: thank + ONE follow-up probe ("was that per file or monthly?", "what finally made you switch?"). Replies bump the post back into members' feeds and typically multiply response volume; a fire-and-forget question post dies at 3 comments. Route: harvest rows -> existing engagement pipeline (`engagement_candidates` -> `cron-sage-draft-engagements` -> DossieMarketingBot approval -> poster), respecting `_lib/comment-caps.js` limits. Never mention Dossie in replies.
4. Weekly rollup of themes + verbatim pull-quotes goes into the weekly review, and high-signal quotes become `cron-generate-posts.js` fuel exactly like `reddit_pain_language`.

## E. Open items

1. **DFW Realtors (`/groups/dfwrealtorgroup/`, 8.1K private)** — join request pending since 9/6; the membership-questions dialog automation grabbed the Messenger panel instead of the questions (`.sage-tc-day2-result.json` dfw_submit: "STILL DISABLED"). Needs a manual 60-second answer from Heath or a fixed driver pass. When approved, it joins the caution list (its R3 throttles "blatant promotion" only).
2. **TC-audience venues are the gap.** One 70-member group carries all TC-side questions. Next expansion: `fb-group-discovery.js` for national TC groups (e.g. transaction-coordinator networking groups), join, rules-check, then rerun Q12/Q13 there. Join approvals take days — start now.
3. **Reddit** unchanged: no personal account exists (u/Icy_Response3978 banned); r/realtors Q1-Q3 and r/RealEstateTechnology Q4/Q5 unlock only when Heath makes one.
4. Heath says go before anything in Section C posts. Nothing is queued in `group_posts`.

---

## 2026-09-07 EVENING EXECUTION UPDATE (Sage) — 2 posts pulled forward, DFW fixed, 3 TC venues added

Heath authorized posting (via Cole). Daily total from Heath's personal profile is now **5/5 — ceiling hit, nothing more posts today.**

**Posted + verified from rendered articles (permalink itself re-rendered with post text under "Heath Shepard"):**
| Q | Group | Variant | Posted (UTC) | Permalink |
|---|---|---|---|---|
| Q6 (what do you pay a TC) | E — Real Estate Agents Group (108.1K, agents/brokers only per R5) | A | 22:16 | https://www.facebook.com/groups/LizLuxuryRealEstateAgent/posts/2518056095375455/ |
| Q8 (fire/switch trigger) | F — Dallas Fort Worth Area Realtors (36.1K, desc invites questions) | A | 22:32 | https://www.facebook.com/groups/dfwrealestategroup/posts/28386009574328965/ |

Both agent-audience venues (audience check passed; Q8 never near the TC group). Rules re-read same-day from day4 /about dumps. Variant B of Q6/Q8 remains unused — REQUIRED for their next appearance. Poster bug note: on the Q8 run `fb-group-poster.js` posted successfully but hung forever on confirmation (killed after 12 min; DB row said `approved` while the post was live). **Always verify the feed before retrying a "failed" run — this was 3 clicks from a double-post.**

**Calendar C adjustments:** Tue 9/8 slots 1-2 (Q6->E, Q8->F) are DONE. Run only Q9->C and Q11->H on 9/8, optionally pulling Q7->D / Q10->G forward from Wed 9/9 to keep 4/day. E and F each now carry 1 of their max-3 fortnight posts; Q6/Q8 next allowed 9/9+ (2-day spacing).

**DFW Realtors (8.1K private, `/groups/dfwrealtorgroup/`):** day2b had submitted the join with the WRONG trivia answer (fallback text, not the mascot). Cancelled that request and resubmitted with answer "Big Tex" + rules agreed, 22:22 UTC. Verified from rendered dialog screenshot (`day5-dfw-redo-filled.png`) and pending banner. Awaiting admin approval.

**New TC venues — Heath is now a MEMBER of all three (public groups, instant join, 22:26-22:27 UTC):**
| Group | Members | Notes |
|---|---|---|
| Transaction Coordinators and Admins for Real Estate (`/groups/transactioncoordinatorsforrealestate/`) | 29.8K | Rules: US TCs, no job posts except Fri, no promo. First post/comment requires an unanswered "Participant questions" gate (Agent? Yes / TC? No) — it re-prompts at first post attempt; answer truthfully then. Activity thin (31/mo). |
| Transaction Coordinators and Virtual Assistants for Real Estate (`/groups/transactioncoordinatorsandvirtualassistants/`) | 10.9K | 170 posts/mo, 8 today — most active TC room found. Generic kindness/no-promo rules. VA-heavy mix; weigh that when reading answers. |
| Transaction Coordinator Referral Group (`/groups/tcreferral/`) | 7.3K | About text explicitly welcomes "a real estate agent looking for a Transaction Coordinator." 150/mo. Composer already renders — postable now. |

Excluded: TCs Empowering TCs (7K) — its rule 1 bars Realtors not principally in support roles. Backup next-wave: TC Collective (7.8K private, 47/mo). Full search dump: `scripts/.sage-tc-day5-tc-search.json`; /about recon: `.sage-tc-day5-tc-about.json`.

**Q12/Q13 are no longer T-only** — reroute them to the three new TC venues (respecting participant gate in the 29.8K group) instead of burning them on the 70-member Texas TC group.
