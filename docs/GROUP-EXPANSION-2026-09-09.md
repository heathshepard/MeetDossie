# FB Group Expansion Research — 2026-09-09

Read-only research pass. Nothing was posted, joined, or commented. Requested by
Heath, executed by Sage. **Do not edit `scripts/comment-hunt-groups.json` from
this file — Heath approves the list first.**

## Method

1. **Old-list validation** (`scripts/fb-commenter-groups.json`, ~20 entries):
   ran FB's own group-name search for each listed group name and checked
   whether a same-named real group turned up, and at what URL. This is a
   search-page technique, not a full deep visit, so it doesn't burn the daily
   group-visit budget.
2. **New-candidate discovery**: same search technique against ~52 queries —
   12 covering brokerage-specific (KW/eXp/Compass/Real/LPT), TC/VA, and the
   big-4 metro categories, plus 40 covering Heath's mid-task addition of
   smaller TX markets (Lubbock, McAllen/RGV, Tyler, Corpus Christi, El Paso,
   Amarillo, Midland-Odessa, Waco, College Station/Bryan, Beaumont,
   Killeen-Temple, Abilene, Wichita Falls, Laredo, Longview, New Braunfels,
   San Marcos, Boerne, Hill Country).
3. **Deep visit** (budget: 8, per Heath's instruction referencing the
   config's `max_group_visits_per_day: 8`): navigated directly to the 8
   highest-priority candidates, extracted member count, public/private, and
   a membership signal (Join Group button = not a member). Counted against
   the shared `scripts/_lib/scan-caps.js` daily ceiling (used 5+8=13 of 32
   today — well inside budget).

**Known limitation, reported honestly rather than glossed over:** the
post-content sample (spam vs. real conversation, thread depth) that
`fb-comment-hunt-daily.js` reliably extracts from groups Heath is **already a
member of** did NOT transfer to these 8 deep visits — all 8 returned DOM
placeholder noise ("Facebook" repeated) instead of real post text. This is a
different code path than the proven daily-hunt extractor (member-view feed vs.
a non-member public-group preview page render differently). **Net: member
count / public-private / membership status below is reliable. Spam-vs-real
conversation scoring for the 8 deep-visited groups is NOT yet verified** — call
that out explicitly before adding any of them to the live posting rotation.

---

## Part 1 — Old list validation (`fb-commenter-groups.json`, 20 entries)

Confirms Heath's suspicion: the file is guessed slugs, not verified groups.
**0 of 20 listed URLs matched a real group at that exact URL.**

| Listed name | Listed URL | Verdict |
|---|---|---|
| Texas Real Estate Agents | /groups/texasrealestateagents/ | NO MATCH — likely dead/never existed (the exact example Heath flagged) |
| Texas Real Estate Network | /groups/texasrealestatenetwork/ | REAL group exists under this name, but at a different URL (`/groups/640969912677141/`) |
| Real Estate Agents Mastermind Group | /groups/realestateagentsmastermind/ | **REAL, wrong URL** → actual: `/groups/152569472013647/` (75.6K members, PRIVATE — see Part 3, high spam risk) |
| New Real Estate Agents | /groups/newrealestateagents/ | NO MATCH |
| Club Wealth Real Estate Agent Mastermind | /groups/clubwealthmastermind/ | **REAL, wrong URL** → actual: `/groups/ClubWealth/` |
| San Antonio Real Estate Agent Forum | /groups/sanantoniorealestateforum/ | NO MATCH |
| Texas Realtors & Lenders | /groups/texasrealtorsandlenders/ | NO MATCH |
| Greater Houston Area Realtors | /groups/houstonarearealtors/ | **REAL, wrong URL (near-miss slug)** → actual: `/groups/greaterhoustonarearealtors/` |
| The Giving Agents - Referral Network and Mastermind | /groups/thegivingagents/ | **REAL, wrong URL** → actual: `/groups/2935652563179933/` |
| Real Estate Agents in USA | /groups/realestateagentsinusa/ | NO MATCH (a similarly-named but distinct group exists) |
| All Realtors and related Professionals | /groups/allrealtors/ | NO MATCH |
| Real Estate Agent Referral Network & Marketing Tips | /groups/realestateagentreferralnetwork/ | NO MATCH (a different-state version of this name exists — Florida) |
| Top Real Estate Agents | /groups/toprealestateagents/ | NO MATCH |
| Real Estate Agents & New Home Sales Consultants - Houston TX | /groups/houstonrealestateagents/ | NO MATCH |
| TEXAS REAL ESTATE | /groups/texasrealestate/ | NO MATCH |
| DFW Realtors | /groups/dfwrealtors/ | NO MATCH |
| D/FW REALTORS | /groups/dfwrealtorgroup/ | NO MATCH |
| Dallas Fort Worth Area Realtors | /groups/dallasfortworthrealtors/ | NO MATCH |
| Real Estate Agents Group | /groups/realestateagentsgroup/ | NO MATCH |
| San Antonio Real Estate Group | /groups/sanantoniorealestate/ | NO MATCH |

**4 of 20 have a real analog** (Real Estate Agents Mastermind Group, Club
Wealth Real Estate Agent Mastermind, Greater Houston Area Realtors, The Giving
Agents), all at completely different URLs than listed. **16 of 20 show no
real-group match in FB's own name search** — treat as dead/hallucinated
pending a direct-URL check (not done this session, budget went to new
candidates + deep visits instead). Recommend: retire `fb-commenter-groups.json`
entirely rather than patch it — it's not a usable source of leads.

---

## Part 2 — New candidates surfaced (name/existence-level, not yet deep-visited)

78 unique agent/TC/VA-relevant candidates survived filtering across both
search passes (out of 447+162 raw hits — most of the raw volume was investor/
wholesaler/rental marketplace groups, correctly excluded). Below are the
strongest by category. "Nx" = number of distinct search queries that surfaced
it (rough relevance/centrality signal, not a quality signal).

**Brokerage-specific (Door A — agents who'd want to own their own paperwork):**
- KW REFERRAL GROUP (KELLER WILLIAMS AGENTS ONLY) — `/groups/484787457704329/` — **deep-visited, see Part 3**
- REAL BROKER - Agents Only — `/groups/2048390029000935/`
- EXP Realty Friends and Agents — `/groups/1573916889572549/`
- Exp Realty — `/groups/557908673538246/`
- Compass Real Estate Agents — `/groups/1342557509859434/`
- Agent Network at LPT Realty - Unofficial — `/groups/1016534902617904/`
- Real Broker TEXAS State Hub — `/groups/2255330371964432/`
- REAL Broker DFW — `/groups/realbrokerdfw/`

**TC/VA-specific (Door B — TCs scaling solo), beyond the 2 already active:**
- Transaction Coordinator Success — `/groups/transactioncoordinatorsuccess/` — **deep-visited, see Part 3**
- Real Estate Transaction Coordinator — `/groups/1699561520489672/`
- Transaction Coordinators — `/groups/TransactionCoordinator/`
- Real Estate Virtual Transaction Coordinator Job and Social Group — `/groups/1672926946148427/`
- Real Estate Transaction Coordinator Training Group For Beginners — `/groups/1365399750981691/`
- Transaction Coordinator Training for Beginners — `/groups/1367574071431014/`
- Transaction Coordinator Blueprint — `/groups/2734798263525407/`

**Metro/local agent networks (big-4):**
- THE UNOFFICIAL HOUSTON AREA REALTORS GROUP! — `/groups/houstonarearealtor/`
- Northwest Houston Realtor Network — `/groups/2263699020431775/`
- Katy Realtor Network (Houston suburb) — `/groups/2605258163053983/`
- I Need CE Credit! - San Antonio area RE classes — `/groups/ineedcesatx/`
- Realtor Connect - San Antonio — `/groups/realtorconnectsa/`
- SAN ANTONIO'S REALTORS FORUM — `/groups/zgreenwoodrealtor/`

**Small/mid TX markets (Heath's mid-task addition — weighted higher per his
note that big groups were the worthless ones on 09-08):**
- Boerne Unified Realty Network (BURN) — `/groups/1167821530902399/` — **deep-visited, see Part 3**
- South Texas RGV, Properties, Realtors, Lenders — `/groups/2414216455371963/` — **deep-visited, see Part 3**
- Lubbock Association of REALTORS Members — `/groups/lubbockrealtorsmembers/` — **deep-visited, see Part 3**
- Lubbock REALTOR Network — `/groups/Lubbockhomebuyers/` (name is odd for a REALTOR-facing group — not visited, verify before trusting)
- Odessa-Midland Realtors — `/groups/1423443985841250/` — **deep-visited, see Part 3**
- El Paso Realtors — `/groups/1822137258027470/` — **deep-visited, see Part 3**
- Real Estate Professionals Group El Paso (REPGEP.com) — `/groups/1695448234083924/`
- Amarillo Realtors (Only) — `/groups/amarillorealtors/`
- Corpus Christi Realtors — `/groups/584039931986467/` — **deep-visited, see Part 3**
- Abilene Association of Realtors Members — `/groups/1605492093076324/`
- Killeen Real Estate Networking Group — `/groups/402739723157057/`
- Central Texas Realtors — `/groups/centraltexasrealtors/` (could span Killeen/Temple/Waco)
- South Texas Realtors, Brokers, Loan Officers, Builders & Credit Repair — `/groups/5159910517462444/` (RGV-adjacent, cross-professional)
- Realtors San Antonio, Boerne, Bulverde, New Braunfels - 411 New Homes — `/groups/752142151598217/` (builder-liaison flavor, not pure agent discussion)

Not yet found: a distinct Tyler, Waco, College Station/Bryan, Beaumont, Wichita
Falls, Laredo, Longview, or San Marcos **agent-specific** group — those
searches mostly surfaced DFW/Houston groups (FB's search leans on popularity)
or consumer buy/sell groups that got filtered out. Worth a second, narrower
search pass per city if Heath wants full small-market coverage.

---

## Part 3 — Deep-visit results (8 groups, live member data)

| Group | Members | Public/Private | Already a member? | Content quality |
|---|---|---|---|---|
| Boerne Unified Realty Network (BURN) | 206 | Public | No | Not verified (extractor limitation, see Method) |
| South Texas RGV, Properties, Realtors, Lenders | 8,700 | Public | No | Not verified |
| Lubbock Association of REALTORS Members | 1,100 | **Private** | No | Can't preview — feed gated until admin approves join |
| Odessa-Midland Realtors | 102 | Public | No | Not verified — very small, watch for low post volume |
| El Paso Realtors | 767 | **Private** | No | Can't preview — feed gated |
| Corpus Christi Realtors | 7,800 | Public | No | Not verified |
| Real Estate Agents Mastermind Group (old-list's real analog) | **75,600** | **Private** | No | Can't preview. Bigger than all 3 known-spam skip groups (108K/85K/31K were the spam benchmark) — **high risk, do not add without inspection** |
| KW REFERRAL GROUP (KELLER WILLIAMS AGENTS ONLY) | 16,700 | Public | No | Not verified, but brokerage-gated ("agents only") — same shape as `kw_re_group`, which is one of the 5 currently-active good groups |

---

## Ranked shortlist — recommendation

**Add now (public, right size, right audience signal, low risk):**
1. **KW REFERRAL GROUP (Keller Williams agents only)** — `/groups/484787457704329/`. 16.7K, public, brokerage-gated exactly like the already-proven `kw_re_group`. Highest confidence of the batch.
2. **South Texas RGV, Properties, Realtors, Lenders** — `/groups/2414216455371963/`. 8.7K, public. Directly answers Heath's McAllen/RGV ask.
3. **Corpus Christi Realtors** — `/groups/584039931986467/`. 7.8K, public, right size band (same ballpark as the 5 currently-active groups).
4. **Boerne Unified Realty Network (BURN)** — `/groups/1167821530902399/`. 206 members — small, but hyperlocal to Heath's own market, and small groups were explicitly under-weighted before this correction. Worth the seat even if post volume is light.

All 4 need one more pass — either a fixed post-sampler or a manual eyeball —
to confirm real conversation before they go live in `comment-hunt-groups.json`.
None require joining to scan (all public); posting later would.

**Requires joining to even evaluate (private) — hold, don't add blind:**
- Lubbock Association of REALTORS Members (1,100) — official-association framing is a good sign, but can't verify content without an approved join. If Heath wants Lubbock covered, this is the best lead; flag for a join-and-scan follow-up (`fb-join-and-scan.js` exists for exactly this).
- El Paso Realtors (767) — same situation.

**Explicit skip, with reason recorded (matches the 09-08 pattern):**
- Real Estate Agents Mastermind Group — `/groups/152569472013647/`. 75.6K members, private. Bigger than all three groups already proven to be listing/recruiting spam. Do not add without a joined-member inspection first.

**Not deep-visited this session (name/search-signal only, prioritize next):**
REAL BROKER - Agents Only, EXP Realty Friends and Agents, Transaction
Coordinator Success (and the 5 other TC-specific candidates in Part 2), THE
UNOFFICIAL HOUSTON AREA REALTORS GROUP!, Realtor Connect - San Antonio,
Amarillo Realtors (Only), Abilene Association of Realtors Members, Killeen
Real Estate Networking Group. Budget (8 visits) ran out before reaching these
— next session should burn the remaining ~19 of today's 32 shared scan-cap
slots on this list, prioritizing the TC-specific ones (Door B) and Amarillo/
Abilene/Killeen (small markets, per Heath's correction) before the Houston/SA
ones (biggest markets already have coverage via `dfw_network_collab` +
`tx_re_agents`).

---

## What's left unverified

1. **Spam-vs-real-conversation scoring for all 8 deep-visited groups** — the
   extraction technique that works for member-view feeds didn't return real
   post text on these non-member preview pages. Needs a fix to the
   deep-visit script (`scripts/.sage-group-expansion-deepvisit.cjs`, kept for
   reuse) or a manual eyeball before any of the "add now" 4 go live.
2. **16 of the 20 old-list URLs** — not directly navigated (search absence
   used as the dead/hallucinated signal instead, to conserve visit budget).
3. **Direct-URL confirmation** that `texasrealestateagents` (Heath's flagged
   example) literally 404s — inferred from search absence, not loaded directly.
4. **Tyler, Waco, College Station/Bryan, Beaumont, Wichita Falls, Laredo,
   Longview, San Marcos** — no distinct agent-specific group surfaced yet;
   needs a narrower second search pass per city.
5. **~19 named candidates in Part 2** never got a deep visit (member
   count/privacy/content) — name-level signal only.

## Files produced this session (scratch, not committed to the live config)

- `scripts/.sage-group-expansion-2026-09-09.cjs` — old-list search-validation + round-1 new-candidate search
- `scripts/.sage-group-expansion-round2-cities.cjs` — round-2 small-market city search
- `scripts/.sage-group-expansion-deepvisit.cjs` — deep-visit (member count/privacy/membership/post-sample) against a target list
- `scripts/.group-expansion-results.json`, `.group-expansion-round2-results.json`, `.group-expansion-deepvisit-results.json`, `.group-expansion-deepvisit-targets.json` — raw output, dot-prefixed and gitignored like the other `.audit-*`/`.sage-*` scratch files
