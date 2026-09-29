# FB Community/Neighborhood Group Vetting — 2026-09-10

Read-only research pass, requested by Heath, executed by Sage. **Nothing was
joined, posted, or commented.** DossieBot-Sage Chrome profile, headed, fixed
extractor (`[data-ad-preview="message"]` for post body — the 2026-09-10
Carter fix, not the dead `div[aria-posinset]` path). No live config edited.

**This is a different audience than every other group Sage has vetted.**
`docs/GROUP-EXPANSION-2026-09-09.md` and `scripts/comment-hunt-groups.json`
vet AGENT/TC groups for Dossie's software pitch. Everything below is
HOMEOWNER/RESIDENT community groups for Heath's own listings — starting with
702 Fawndale, $330,000, listed today, Windcrest. Do not merge these two
lists.

## Method

1. **Search phase** (cheap, not counted against the shared 32/day
   `scan-caps` group-visit ceiling): FB group-name search across 26 queries —
   Windcrest (5), Boerne/Hill Country (10, spanning Fair Oaks Ranch,
   Bulverde, Canyon Lake, New Braunfels, Comfort), San Antonio metro (5),
   military/JBSA (6). Raw hits: ~250+ across all queries after de-dupe.
2. **Deep visit** (24 of today's remaining 27-visit budget — state file
   showed 5/32 used before this session): navigated directly to the 24
   highest-priority candidates, extracted member count, public/private,
   membership signal, a real post sample (fixed extractor — this DID work
   this time, unlike the 09-09 session's agent-group deep-visits), and a
   best-effort "Group rules" text block.
3. **Rules extraction is honest-limited.** The rules widget only rendered in
   the captured DOM for 2 of 24 groups (both generic Facebook default
   templates — "be kind," "no hate speech" — no realtor-specific line
   visible in either, and both are too small to matter anyway). For every
   other group, **no stated rule was recoverable this pass** — either FB
   didn't render that widget in this DOM snapshot, or the rule lives as an
   image (very common for local groups — a graphic reading "NO BUSINESS
   ADS EXCEPT SATURDAYS," posted as a picture, not text). **Do not read
   "no rules found" as "no rules exist."** Where I have no stated-rule
   evidence, I substituted the next best thing: **revealed preference** —
   what is actually sitting in the live feed right now. If an agent's open
   house or a lender's VA-loan post is live in the sample, the group
   tolerates it in practice, rule or no rule. Where I have neither, I say so
   and mark it "verify manually before the first post."

## Windcrest — top priority (live 702 Fawndale listing)

| Group | Members | Type | Verdict |
|---|---|---|---|
| **Windcrest Community** | 4.8K | Public | **ADD** |
| **Windcrest Community Garage Sale** | 3.1K | Public | **ADD** |
| **Windcrest/Live Oak/Converse/Schertz/Cibolo/Selma Online Sales** | 10.4K | Public | **ADD** |
| Windcrest Neighbors (`cityofwindcrest`) | 60 | Private | SKIP — too small |
| Windcrest Neighbors (`windcrestneighbors`) | 2 | Private | SKIP — dead |
| LOCAL PLUG IN WINDCREST TEXAS | 1 | Public | SKIP — dead (1 member) |
| Windcrest Small Business Supporters | 2 | Public | SKIP for now, watch — just launched, welcome-post only |

**Windcrest Community** (4.8K) — real, current neighbor chatter: a school
color-run fundraiser, a new local pool-maintenance owner introducing his
business, a coffee shop announcing its Windcrest address. Real conversation,
business intros already tolerated. No stated rule captured — verify on first
post, but nothing here suggests hostility to a local business post.

**Windcrest Community Garage Sale** (3.1K) — live posts: a childcare
business hiring, custom apparel ads, and a storm-cleanup service pitch.
Genuinely transactional/marketplace-flavored — a "just listed" post fits the
existing culture better than a "market update" would.

**Windcrest/Live Oak/Converse/Schertz/Cibolo/Selma Online Sales** (10.4K) —
widest reach of the three, same marketplace flavor, spans five adjacent
suburbs plus Windcrest itself. Real small-business ads live in the sample
(hair accessories, a food stand). Good second-ring reach beyond Windcrest
proper.

## Boerne / Hill Country (home market)

| Group | Members | Type | Verdict |
|---|---|---|---|
| **Tx Hill Country Buy-Sell-Trade-Barter** | 13.7K | Public | **ADD — realtor posts already live** |
| **Buy Buy Boerne** | 903 | Public | **ADD — explicitly business-friendly by name and content** |
| Boerne Breaking News | 32.2K | Public | ADD, but test soft first — biggest reach, no business post seen in sample |
| Boerne Recommends | 6.3K | Private | JOIN-TO-VERIFY — name says "recommend a business," best lead of the private tier |
| MARKET PLACE: Boerne, Texas (TX) | 958 | Private | JOIN-TO-VERIFY — run by "Red Fish Media Group," an admin-branded marketplace, plausibly business-friendly by design |

**Tx Hill Country Buy-Sell-Trade-Barter** (13.7K) is the standout find in
this tier: the live sample has an agent (Hannah Childs-Curro) posting a
"MASSIVE $50K PRICE DROP ALERT" and a separate "Canyon Lake Market Alert,"
plus a land listing and a firewood-for-sale post. **Direct revealed-preference
evidence that real estate marketing is not just tolerated but already
happening here, unremoved.** No stated rule needed — the behavior speaks.

**Buy Buy Boerne** (903) — name and content ("THE BEST ADVERTISING TELLS
PEOPLE WHO YOU ARE," a cleaning-service open-availability post, an estate
sale) show this group exists FOR local business promotion. Small but exactly
on-thesis.

**Boerne Breaking News** (32.2K) is the biggest true-conversation group
found this session — real, heated local political/news threads (Kendall
County commissioners court, a viral quote-tweet screenshot) — but the sample
had zero business or listing posts, so I have no evidence either way on
tolerance. Recommend a soft post (market-update commentary, not a raw
listing) before ever trying a direct "just listed."

## Fair Oaks Ranch / Bulverde / Canyon Lake / New Braunfels / Comfort

| Group | Members | Type | Verdict |
|---|---|---|---|
| **Canyon Lake Neighbors** | 3.1K | Public | **ADD — realtor open-house post already live** |
| **What's Happening in New Braunfels** | 23.4K | Public | **ADD — biggest NB group, confirmed real conversation** |
| Fair Oaks Ranch, Texas | 4.6K | Public | ADD — community-newsletter flavor, good for market-update/helpful-answer content |
| New Braunfels Neighbors | 11.0K | Public | ADD — real chatter, no real-estate signal either way |
| Bulverde,TX Friends | 471 | Public | ADD — small but genuine (charity walk, community event chatter) |
| Fair Oaks Ranch Residents And Neighbors | 121 | Public | Low priority — dominated by one repeat advertiser (a pet-spa business), thin real-conversation ratio |
| The Official Bulverde/Spring Branch Marketplace | 4.0K | Private | JOIN-TO-VERIFY |
| Comfort TX Community | 8.7K | Private | JOIN-TO-VERIFY — only generic FB boilerplate rules captured (be kind / no hate speech), nothing realtor-specific visible in what rendered |

**Canyon Lake Neighbors** (3.1K) is the second standout: the live sample
has an agent (Rudy Flores Jr.) posting a full open-house announcement with
address, date, and acreage details, sitting next to a genuine
"looking for flooring recommendations" neighbor post. Confirmed live,
un-removed, real estate content in a homeowner group.

## San Antonio metro

| Group | Members | Type | Verdict |
|---|---|---|---|
| San Antonio TX Community - Buy, Sell, Trade, Jobs, Events | 55.6K | Private | JOIN-TO-VERIFY — biggest reach found, run by a "Share The Jobs" admin account, name itself signals commerce-tolerant |
| San Antonio - Ask A Local | — | — | **SKIP by name alone** — "(Not a place to sell things!)" is in the group's own title; didn't burn a visit confirming what the name already says |

Only one SA-metro group got a full deep visit this session (budget went to
Windcrest/Hill Country first, per Heath's priority order). The generic
"San Antonio buy sell trade" search surfaced mostly household-goods
marketplaces (used cars, garage sales) with no listing/real-estate signal —
lower priority than the hyperlocal groups above. Worth a second pass focused
on SA neighborhood-specific groups (Alamo Heights, Stone Oak, Terrell Hills,
etc.) if Heath wants deeper SA-proper coverage beyond Windcrest.

## Military / veteran (JBSA) — real affinity, not a gimmick

| Group | Members | Type | Verdict |
|---|---|---|---|
| **Your Military Realtor** | 20.9K | Public | **ADD — explicitly realtor-friendly, highest-value find of the whole session** |
| **Joint Base San Antonio Connect** | 740 | Public | **ADD — realtor + lender posts already live** |
| **San Antonio & JBSA Families Connect** | 477 | Public | **ADD — VA-loan educational post already live, direct veteran-relevant angle** |

**Your Military Realtor** (20.9K) is the single best find in this entire
report. The live sample is ALL real-estate marketing — a New Braunfels
new-construction price post, a Saturday open-house invite, a San Antonio
townhouse listing — from multiple different agents. This group functions as
a standing listings marketplace for the military-relocation audience. It is
not a quiet homeowner-chatter group; it's closer to a realtor-to-consumer
listing board built for exactly this. Treat it like the highest-confidence
slot in the whole list.

**Joint Base San Antonio Connect** (740) and **San Antonio & JBSA Families
Connect** (477) are smaller but genuinely mixed — real family-support asks
(a mother's-helper request, a dental-patient search) sitting next to an
agent/lender duo ("Maria Finds, Ariel finances!") already marketing there,
including a VA-loan-specific educational post in the Families Connect group.
That VA-loan angle is the sharpest fit for Heath's own veteran status — a
post explaining VA loan terms (zero down, no PMI, seller-paid closing) reads
as a genuine value-add here, not just a listing drop.

## Explicit-skip / dead groups (recorded so nobody re-adds them)

- Windcrest Neighbors (`windcrestneighbors`, 2 members) — dead
- LOCAL PLUG IN WINDCREST TEXAS (1 member) — dead
- Windcrest Small Business Supporters (2 members) — too new to score, revisit in a month
- Windcrest Neighbors (`cityofwindcrest`, 60 members, private) — too small to matter even though it's the one group with fully-legible (generic) rules
- Fair Oaks Ranch Residents And Neighbors (121 members) — thin, one advertiser dominates
- San Antonio - Ask A Local — name says "not a place to sell things," skip by design

## What's still unverified

1. **5 private groups never previewed** (need a join-and-scan pass, same
   caveat as the 09-09 agent-group report): Boerne Recommends (6.3K),
   MARKET PLACE: Boerne (958), The Official Bulverde/Spring Branch
   Marketplace (4.0K), Comfort TX Community (8.7K), San Antonio TX Community
   (55.6K). Boerne Recommends and the 55.6K SA group are the two worth
   joining first if Heath wants that tier resolved.
2. **No group's actual admin-set rules on realtor/listing posts were fully
   recoverable as text** — 22 of 24 groups rendered no rules widget at all
   in this DOM snapshot; the 2 that did are both generic FB defaults, not
   real vetting signal. Every "ADD" verdict above rests on **live-feed
   revealed preference**, not a confirmed written rule. Before the FIRST
   post to any group, do a 60-second manual look at the group's "About" tab
   for a "Group rules" section — some are only visible from that separate
   tab, not the main feed page this pass captured.
3. **No designated "realtor day" was found anywhere.** Nothing said "post
   your listings on Tuesdays" or similar. The two groups that behave like
   they have one (Tx Hill Country Buy-Sell-Trade-Barter, Your Military
   Realtor) simply run open — no visible cadence restriction.
4. Deeper San Antonio-proper neighborhood coverage (Stone Oak, Alamo
   Heights, Terrell Hills, Northwest SA subdivisions) not attempted —
   budget went to Windcrest/Hill Country/military first per stated priority.

## Ranked recommendation — 12 to add now

In priority order (Windcrest first, then revealed-preference realtor-tolerant
groups, then broad reach):

1. Windcrest Community (4.8K) — "just listed" post for 702 Fawndale
2. Tx Hill Country Buy-Sell-Trade-Barter (13.7K) — realtor posts already live
3. Canyon Lake Neighbors (3.1K) — open-house posts already live
4. Your Military Realtor (20.9K) — explicitly realtor-friendly, biggest clean fit
5. San Antonio & JBSA Families Connect (477) — VA-loan angle, veteran affinity
6. Joint Base San Antonio Connect (740) — realtor/lender activity already live
7. Windcrest/Live Oak/Converse/Schertz/Cibolo/Selma Online Sales (10.4K)
8. Windcrest Community Garage Sale (3.1K)
9. Buy Buy Boerne (903) — explicitly business-friendly
10. What's Happening in New Braunfels (23.4K) — confirmed real conversation, biggest NB group
11. Fair Oaks Ranch, Texas (4.6K) — newsletter/community flavor, market-update fit
12. Boerne Breaking News (32.2K) — biggest reach, test with a soft post first

**What kind of post works where:**
- **"Just listed" (702 Fawndale, direct listing copy + photos):** Windcrest
  Community, Windcrest Community Garage Sale, Windcrest/Live Oak/etc.,
  Tx Hill Country Buy-Sell-Trade-Barter, Canyon Lake Neighbors, Your
  Military Realtor, Joint Base San Antonio Connect. These are the groups
  with revealed-preference or explicit business-post tolerance — a raw
  listing post fits the existing culture.
- **Market update / "here's what homes near you are selling for" (softer,
  value-first):** Boerne Breaking News, What's Happening in New Braunfels,
  New Braunfels Neighbors, Fair Oaks Ranch Texas. No listing-post evidence
  either way in these — lead with value, not a pitch, and see how it lands
  before trying a direct listing post.
- **Helpful answer (a real question someone asked, answered in Heath's
  voice, no pitch):** San Antonio & JBSA Families Connect (VA-loan
  education fits naturally — there's already a precedent post doing exactly
  this), Bulverde,TX Friends, Fair Oaks Ranch Residents And Neighbors.
  Veteran-specific value content (how a VA loan actually works, what "zero
  down" really means) is the single sharpest angle Heath has that a generic
  agent doesn't — lead with that, not with "here's my listing."

## Mechanism — deliberately NOT the Dossie comment pipeline

**Do not wire these into `group_registry` / `fb-comment-hunt-daily.js` /
`fb-group-commenter.js`.** That pipeline exists to post AS Heath about
Dossie/TC pain into AGENT groups, drafted by Haiku on a keyword trigger, on
a daily automated cadence, with a 30-minute Telegram veto window. Everything
about that shape is wrong for this job:

- **Wrong trigger.** A listing post fires off a real-world event (new
  listing, price drop, open house, closing) — maybe 4-8 times a year, not
  daily. There's no keyword to scan for; there's nothing to "discover," Heath
  already knows when he has news.
- **Wrong author.** Haiku drafting generic TC-pain replies is fine because
  it's low-stakes chatter. A listing post is Heath's actual real estate
  advertising, under his TREC license (#751964). It needs the real address,
  real price, real photos, and — per the same compliance gap already flagged
  on his GBP listing (`heath-google-business-profile.md`) — **the brokerage
  name, Keller Williams City View, has to be in the post to satisfy TREC
  §535.155.** An LLM should not be autonomously generating that copy
  unsupervised.
- **Wrong risk profile.** A bad TC-pain comment gets deleted and nobody
  notices. A listing post that gets an agent removed from a homeowner group
  costs Heath a standing local channel, and a TREC-noncompliant post is a
  license-level problem, not a bounced comment.

**What to use instead: the existing `fb-group-poster.js` + `group_posts`
table, exactly the way the Founding Files flow already works (CLAUDE.md
RULE 4)** — insert a row with `group_name`, `group_url`, `post_body`,
`status='approved'`, `template_id='direct'` (no `group_registry` row
required, confirmed from the existing Founding Files pattern), then
`node scripts/fb-group-poster.js --post-id [uuid]`. This gives you:
- A human (Heath, or Cole drafting for his approval) writes the actual
  post body per real event — not an automated daily loop.
- Every post includes the brokerage-name line by default (add it to the
  template so it's never missed).
- No keyword-scan/discovery layer needed — this is a push, not a pull.
- Same DossieBot-Sage Chrome profile, same posting mechanics already proven
  working — no new automation to build.

One more distinction worth stating plainly: use a **separate**
`group_name`/`group_url` pair per post (this table already supports ad-hoc
targets with no registry row), rather than repurposing `group_registry` —
that table's schema (`cool_down_hours`, `blitz_count`, `last_blitzed_at`) is
built for Dossie's repeated-comment cadence into the same fixed 5 agent
groups, not a low-frequency listing announcement into a growing list of
homeowner groups. If this scales past a handful of listings a year, a light
`community_group_registry` table (group name/url/category/last-posted) would
be the right next step — not worth building for one listing today.

## Files produced this session (scratch, gitignored, not committed)

- `scripts/.sage-community-group-search-2026-09-10.cjs` — search-phase script
- `scripts/.sage-community-group-deepvisit-2026-09-10.cjs` — deep-visit script (fixed extractor)
- `scripts/.community-group-search-results.json` — raw search results, 26 queries
- `scripts/.community-group-deepvisit-targets.json` — the 24 prioritized targets
- `scripts/.community-group-deepvisit-results.json` — raw deep-visit output (member counts, post samples, rules text where captured)

## Proposed entries — same schema as `scripts/comment-hunt-groups.json`

**Not written to any live config.** Shown in the identical `key`/`name`/`url`/`note`
shape for consistency, but per the Mechanism section above, these belong in
`group_posts` rows per real event, not in a scanned `group_registry`/
`comment-hunt-groups.json`-style always-on list. If Heath wants a persistent
reference list anyway (e.g. a future `community-groups.json`), this is the
ready-to-paste content:

```json
{
  "groups": [
    {
      "key": "windcrest_community",
      "name": "Windcrest Community (4.8K)",
      "url": "https://www.facebook.com/groups/393376354463562/",
      "category": "windcrest",
      "note": "Real neighbor chatter + local biz intros; public; top priority for 702 Fawndale"
    },
    {
      "key": "hill_country_bst",
      "name": "Tx Hill Country Buy-Sell-Trade-Barter (13.7K)",
      "url": "https://www.facebook.com/groups/292942460804583/",
      "category": "hill_country",
      "note": "Agent price-drop + Canyon Lake market-alert posts already live in feed"
    },
    {
      "key": "canyon_lake_neighbors",
      "name": "Canyon Lake Neighbors (3.1K)",
      "url": "https://www.facebook.com/groups/244633557725425/",
      "category": "canyon_lake",
      "note": "Agent open-house post already live alongside genuine neighbor asks"
    },
    {
      "key": "your_military_realtor",
      "name": "Your Military Realtor (20.9K)",
      "url": "https://www.facebook.com/groups/1563257057262955/",
      "category": "military_jbsa",
      "note": "Explicitly realtor-friendly, functions as a listings board for military-relocation audience; highest-confidence add"
    },
    {
      "key": "jbsa_families_connect",
      "name": "San Antonio & JBSA Families Connect (477)",
      "url": "https://www.facebook.com/groups/3481107345360037/",
      "category": "military_jbsa",
      "note": "VA-loan educational post already live; sharpest fit for Heath's own veteran status"
    },
    {
      "key": "jbsa_connect",
      "name": "Joint Base San Antonio Connect (740)",
      "url": "https://www.facebook.com/groups/1343102520750222/",
      "category": "military_jbsa",
      "note": "Realtor + lender posts already live, unremoved"
    },
    {
      "key": "windcrest_liveoak_online_sales",
      "name": "Windcrest/Live Oak/Converse/Schertz/Cibolo/Selma Online Sales (10.4K)",
      "url": "https://www.facebook.com/groups/738973446279839/",
      "category": "windcrest",
      "note": "Marketplace-flavored, widest reach beyond Windcrest proper"
    },
    {
      "key": "windcrest_garage_sale",
      "name": "Windcrest Community Garage Sale (3.1K)",
      "url": "https://www.facebook.com/groups/299532927183343/",
      "category": "windcrest",
      "note": "Business ads already tolerated (childcare, apparel, cleanup services)"
    },
    {
      "key": "buy_buy_boerne",
      "name": "Buy Buy Boerne (903)",
      "url": "https://www.facebook.com/groups/thinklocalshopsmall/",
      "category": "boerne",
      "note": "Explicitly business-promotion-friendly by name and live content"
    },
    {
      "key": "whats_happening_new_braunfels",
      "name": "What's Happening in New Braunfels (23.4K)",
      "url": "https://www.facebook.com/groups/1088127545336885/",
      "category": "new_braunfels",
      "note": "Biggest NB group, confirmed real conversation, service-recommendation culture"
    },
    {
      "key": "fair_oaks_ranch_tx",
      "name": "Fair Oaks Ranch, Texas (4.6K)",
      "url": "https://www.facebook.com/groups/119084148725/",
      "category": "fair_oaks_ranch",
      "note": "Community-newsletter flavor; market-update/helpful-answer fit, not a raw-listing test yet"
    },
    {
      "key": "boerne_breaking_news",
      "name": "Boerne Breaking News (32.2K)",
      "url": "https://www.facebook.com/groups/boernebreakingnews/",
      "category": "boerne",
      "note": "Biggest single-market reach; no business-post evidence either way, test with a soft post first"
    }
  ],
  "join_to_verify": [
    { "name": "Boerne Recommends (6.3K, private)", "url": "https://www.facebook.com/groups/boernerecommends/", "why": "name signals business-recommendation culture, best private-tier lead" },
    { "name": "San Antonio TX Community - Buy, Sell, Trade, Jobs, Events (55.6K, private)", "url": "https://www.facebook.com/groups/SanAntonioTXCommunity/", "why": "biggest reach found this session, commerce-signaling name" },
    { "name": "MARKET PLACE: Boerne, Texas (958, private)", "url": "https://www.facebook.com/groups/BoerneTx/", "why": "admin-run by a media company, plausibly business-friendly by design" },
    { "name": "Comfort TX Community (8.7K, private)", "url": "https://www.facebook.com/groups/350586399538482/", "why": "only generic FB-default rules captured, real content unverified" },
    { "name": "The Official Bulverde/Spring Branch Marketplace (4.0K, private)", "url": "https://www.facebook.com/groups/395881967273667/", "why": "marketplace framing, content unverified" }
  ],
  "skip_groups": [
    { "name": "Windcrest Neighbors (windcrestneighbors)", "url": "https://www.facebook.com/groups/windcrestneighbors/", "why": "2 members, dead" },
    { "name": "LOCAL PLUG IN WINDCREST TEXAS", "url": "https://www.facebook.com/groups/1028518546658070/", "why": "1 member, dead" },
    { "name": "Windcrest Small Business Supporters", "url": "https://www.facebook.com/groups/28100783206226570/", "why": "2 members, just launched, welcome-post only — revisit in a month" },
    { "name": "Windcrest Neighbors (cityofwindcrest)", "url": "https://www.facebook.com/groups/cityofwindcrest/", "why": "60 members, too small despite legible generic rules" },
    { "name": "Fair Oaks Ranch Residents And Neighbors", "url": "https://www.facebook.com/groups/2073409749786672/", "why": "121 members, dominated by one repeat advertiser, thin real-conversation ratio" },
    { "name": "San Antonio - Ask A Local", "url": "https://www.facebook.com/groups/saaskalocal/", "why": "group's own name states \"Not a place to sell things!\" — skip by design, no visit needed" }
  ]
}
```
