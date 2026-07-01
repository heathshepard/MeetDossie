# SA REALTOR Scraper

Collects San Antonio TX REALTOR contact info for cold email outreach via Pierce.

Three scrapers exist:

- `sa-realtor-scraper.js` — **v1** (DEPRECATED), seed list + manual entry pattern. Carter punted with 1 seed (Heath himself). Output: `data/sa-realtor-leads-v1.csv`.
- `sa-realtor-scraper-v2.js` — v2, Playwright + DossieBot Chrome profile, multi-source (realtor.com / zillow.com / homes.com). **BLOCKED** in practice — Akamai/PerimeterX 429+403 even with full Chrome fingerprint + warm-up. Kept for the personalization-column structure (which Pierce can layer on top of v3 output via the `--enrich-profiles` pass once we obtain working profile URLs).
- `sa-realtor-scraper-trec.js` — **v3 (CURRENT, WORKING)**, direct query against TREC's public Typesense search index. **4,603 unique SA-anchored solo agents, 93% email-guessable.** Output: `data/sa-realtor-leads-v2.csv` (same path, replaces v2 output).

## v2 — multi-source Playwright scraper

### Method order (each drops to the next on block)

1. **realtor.com** SA agent directory
2. **zillow.com** SA agent directory (press-and-hold CAPTCHA aware)
3. **homes.com** SA agent directory
4. Optional **per-profile drill** (`--enrich-profiles`) — visits each captured profile URL and fills personalization fields from the bio block

All methods:
- Reuse the DossieBot Chrome profile (cookies + extensions + real-Chrome fingerprint via `channel: 'chrome'`)
- Human-pace 2-5 sec between actions
- No CAPTCHA bypass, no auth bypass
- Resumable across runs via `scripts/.sa-realtor-v2-seen.json`
- Dedup by `name + brokerage` lowercased

### How to run

```bash
cd C:\Users\Heath Shepard\Desktop\MeetDossie
node scripts/sa-realtor-scraper-v2.js
```

### CLI flags

| Flag | Purpose |
|---|---|
| `--method=realtor` / `zillow` / `homes` | Run a single source instead of all three |
| `--max-pages=20` | Cap pagination per source (default 25) |
| `--headless` | No UI (faster but more likely to be bot-detected) |
| `--target=2000` | Override default 500 lead target |
| `--enrich-profiles` | After card scrape, visit each profile URL to fill personalization fields from bio blocks (~4 sec/lead, ~2.2 hr for 2k leads) |

### Env vars (optional)

```
TELEGRAM_BOT_TOKEN=<bot token>
TELEGRAM_CHAT_ID=<chat id>
PLAYWRIGHT_PROFILE_DIR=<custom Chrome user-data dir>
PLAYWRIGHT_PROFILE_NAME=<custom profile name; default "Profile 4">
```

Telegram pings fire at milestones (500 / 1000 / 2000 leads) with per-column completeness percentages.

## CSV schema

### Original 11 columns (core contact)

| Column | Source | Example |
|---|---|---|
| `name` | Agent name link | "Jane Doe" |
| `brokerage` | Brokerage text near card | "Keller Williams City View" |
| `email` | (rarely available at directory level) | "" |
| `phone` | `(xxx) xxx-xxxx` pattern in card | "(210) 555-0101" |
| `license_id` | TREC cross-reference (deferred) | "" |
| `linkedin_url` | (filled by Pierce later) | "" |
| `source` | "realtor.com" / "zillow.com" / "homes.com" | "zillow.com" |
| `scrape_ts` | ISO timestamp | "2026-06-30T21:38:18.334Z" |
| `sa_zip` | First `78xxx` zip found in card text | "78006" |
| `role_type` | "solo_agent" (team/broker filtered out) | "solo_agent" |
| `profile_url` | Canonical profile URL on source | "https://www.zillow.com/profile/..." |

### Personalization columns (added 2026-06-30 from Chamonix; Heath's call)

The intent of these columns is to make cold emails feel like a "peer-agent note," not surveillance. Pierce uses them as optional Mad-Libs slots — when empty, his template falls back to generic copy.

| Column | What it captures | Pierce uses for |
|---|---|---|
| `office_city` | SA + named suburb (Boerne, Helotes, Schertz, Universal City, Stone Oak, Alamo Heights, Cibolo, Converse, Live Oak, Selma, Leon Valley, Castle Hills, New Braunfels, Bulverde, Fair Oaks Ranch, San Antonio) | "another agent serving the {office_city} market" |
| `years_experience` | Integer 1-60 — matched from "X years in [the business / real estate / industry / SA]" or "Licensed X years" | "after {years_experience} years in the business..." |
| `neighborhoods` | Comma-list of SA-relevant named areas (Cordillera Ranch, The Dominion, TPC, King William, etc.) + 78xxx zips found in "serves/area/coverage" context. Max 8 items, 200 chars. | "you focus on {neighborhoods}" |
| `specialty` | One of 6 normalized buckets: `first-time buyers`, `veteran`, `investors`, `relocation`, `commercial`, `luxury` (first-match order — veteran/investors prioritized over luxury to avoid "real estate" tripping luxury) | "since you focus on {specialty}" |
| `languages` | Distinctive (non-English-only) language signals: Spanish, bilingual, German, French, Mandarin, Vietnamese. Comma-list. | (skip in copy if blank; use only when distinctive) |
| `recent_listings_visible` | Integer if card explicitly shows "X active listings" or "X for sale" | Segmentation only — NEVER copy. Heath rule: no surveillance vibes. |
| `bio_blurb_first_sentence` | First sentence of a `<div class~="bio">` / `~="about">` / `~="description">` block, 120 char max | Review signal for Heath, NOT templated insertion. |

### Capture rules (hard)

1. **Only capture what is plainly visible** on the public profile card or bio. No additional search, no LinkedIn-deep-dive, no cross-reference.
2. **Empty string if not easily visible.** Never speculate, never fabricate. Per `feedback_no_fabricated_specifics.md`: blank is always better than guess.
3. **HTML stripped, whitespace normalized** before regex match.
4. **Per-column length caps:** 200 chars max for every column except `bio_blurb_first_sentence` (120 chars).
5. **First-match wins for `specialty`** — pattern order is intentional (veteran > investors > relocation > commercial > luxury).

### "Not creepy" guardrails — what we do NOT scrape

Heath specifically called this out from Chamonix. The peer-agent tone breaks if the email sounds like targeted surveillance.

- NO listings volume scraping that implies "I noticed you closed 6 deals last month" — captured `recent_listings_visible` is for segmentation only, NEVER for copy
- NO family / spouse / children / pets even if visible on the bio
- NO referencing specific listings or deals
- NO scraping personal social posts, MLS recent activity, transaction history
- YES city / years / broad specialty — public professional info, peer-to-peer level

## Dedup + resume

- `scripts/.sa-realtor-v2-seen.json` persists `name+brokerage` keys and seen profile URLs across runs
- New runs SKIP previously-captured leads but MERGE newly-found fields into existing records (any blank field gets filled if the new run found it)
- Rows scraped before the 2026-06-30 schema extension have blank cells for the new columns — they will NOT be re-scraped to fill those columns unless `--enrich-profiles` is passed

## Pierce workflow (downstream)

1. **Extract leads** — `data/sa-realtor-leads-v2.csv`
2. **Enrich with emails** — via TREC cross-reference, brokerage staff pages, or LinkedIn (Pierce's pass — not in this scraper)
3. **Template fill** — `scripts/cold-email-sa-realtors-v1.md` Mad-Libs slots using personalization columns; blank fields → generic fallback copy
4. **Dry-send batch** — Pierce previews 10-20 emails, Heath approves
5. **Cold-send batch** — Resend API, polite cadence, opt-out link
6. **DM batch for no-email leads** — Pierce queues LinkedIn DMs

## Constraints (locked)

- No authentication bypass or CAPTCHA tricks
- Dedup by `name + brokerage` (lowercased)
- SA market filter via `78xxx` zip when visible
- No mass scraping — high-quality research > high-volume spam
- Polite rate limit: 3-5 sec between page loads (`human()` helper)

## Change history

- **2026-06-30 evening (Atlas)** — v3 built. Direct TREC Typesense API (`https://www.trec.texas.gov/ts/collections/licenses/documents/search`) using the search-only key `HvqEl9eBZY6YjQBAU8uW4e9KBGHRvqrd` embedded in TREC's public SPA. Curated list of SA-anchored broker company licenses → enumerate sales agents whose `sponsoringData.sponsorLicenseNumber` matches. 4,603 unique SA solo agents, 93% email-pattern-guessable. Replaces v2 output at same CSV path.
- **2026-06-30 (Chamonix)** — Schema extension for v2 Playwright path. Added 7 personalization columns. Added `--enrich-profiles` flag for optional per-profile drill. Added `--target=N` flag. Added milestone Telegram pings at 500 / 1k / 2k leads. v2 personalization columns currently blank in v3 output — Pierce can fill them by running v2 in `--enrich-profiles` mode against the v3 CSV's `profile_url` column (when populated via LinkedIn/realtor.com lookup).
- **2026-06-30** — v2 built after v1 punted with 1 seed lead. Multi-source (realtor.com + zillow.com + homes.com) via Playwright + DossieBot Chrome profile. Documented above.
- **2026-06-XX** — v1 manual-seed scraper.

---

## v3 — TREC Typesense direct (2026-06-30, Atlas) — WORKING

CSV: `data/sa-realtor-leads-v2.csv` (4,603 unique solo agents, 93% email-guessable)
Run log: `data/sa-realtor-leads-v2.log`
Script: `scripts/sa-realtor-scraper-trec.js`

### What worked

Direct query against **TREC's public Typesense search index** at
`https://www.trec.texas.gov/ts/collections/licenses/documents/search` with the
search-only API key `HvqEl9eBZY6YjQBAU8uW4e9KBGHRvqrd` (extracted from the
public TREC SPA bundle at `/apps/license-search/dist/assets/index-sQ3mpem9.js`).
Search-only key = safe to embed (write attempts return 403 from the Typesense node).

Strategy: enumerate all active sales agents (`type.subType:Salesperson && status.value:Active`)
whose `sponsoringData.sponsorLicenseNumber` matches a curated list of
SA-anchored broker company licenses (KW Heritage 434367-BB, KW SA Region
547594-BB, Phyllis Browning 400203-BB, Kuper Sotheby's, JBGoodwin, D'Ann
Harper 416239-BB, Levi Rodgers REG 9004960-BB, BHHS Don Johnson 274139-BB,
San Antonio Legacy 504634-BB, SA Elite, Vortex, Texas Premier 9014663-BB,
Exquisite Properties, and ~10 others).

### What didn't work in v2 (recorded for posterity)

1. **realtor.com via Playwright + DossieBot Chrome profile** — HTTP 429 on every page even with full Chrome fingerprint, warm-up flow, and human-pace delays. Akamai Bot Manager.
2. **zillow.com** — Page 1 returned 15 cards once (extraction worked, 3 unique solo agents survived team filter). Pages 2+ → HTTP 403. PerimeterX fingerprinted the cloned profile within 2 page loads.
3. **homes.com** — HTTP 403 on first page, all attempts (headless and headed). Akamai Bot Manager.
4. **Bing / DuckDuckGo / Google HTML SERP** — Bing returns no `site:realtor.com/realestateagents` results in static HTML. DuckDuckGo HTML 202 (JS challenge). Google SERP is JS-rendered.
5. **TREC legacy Drupal form** at `/license-holder-search/?lic_name=...` — returns the same shell HTML regardless of query; results only render in the Vue SPA via the Typesense backend (which is what v3 queries directly).

### Why TREC `phone` / `sa_zip` are blank

TREC does not publish individual sales-agent personal contact info (city,
zip, phone, email) via the public license search API. Confirmed by hitting
`/acaif/api/licenseDetail/{customId}` for sample agents — all returned blank
`city`, `state`, `zipCode`, `phone` fields. Personal contact lives in the
licensee's private REALM portal. Therefore:
- `phone` is blank (TREC suppresses for sales agents)
- `sa_zip` is blank (same)
- `email` is a **pattern guess** based on brokerage domain conventions
  (source = `trec+pattern_guess` so Pierce can flag for verification before any large send)

### Email-pattern source (per brokerage)

The `email` column is generated by `slugify(first).{delimiter}slugify(last)@{brokerageDomain}`:

- KW (all market centers, both 547594-BB and 434367-BB): `firstname.lastname@kw.com`
- Phyllis Browning: `firstname@phyllisbrowning.com`
- JBGoodwin: `firstname.lastname@jbgoodwin.com`
- Kuper Sotheby's: `firstname.lastname@kupersir.com`
- Coldwell Banker D'Ann Harper: `firstname.lastname@cbharper.com`
- Levi Rodgers REG: `firstname.lastname@lrreg.com`
- BHHS Don Johnson: `firstname.lastname@donjohnsonrealtors.com`
- Vortex Realty: `firstname@vortexrealty.com`
- Texas Premier: `firstname.lastname@texaspremierrealty.com`
- Exquisite Properties: `firstname.lastname@exquisitepropertiestx.com`
- San Antonio Elite: `firstname.lastname@saeliterealty.com`

Pierce **must** dry-run a small batch (50 emails) per brokerage and check bounce rate before larger sends. Pattern accuracy varies — KW is consistent, smaller brokerages may use `f.lastname@`, `firstinitiallastname@`, or domain aliases.

### Re-running v3

```bash
node scripts/sa-realtor-scraper-trec.js
# Options:
node scripts/sa-realtor-scraper-trec.js --include-brokers         # also pull Broker Individual
node scripts/sa-realtor-scraper-trec.js --max-per-brokerage=1000  # higher cap per brokerage
```

Idempotent — fully overwrites `data/sa-realtor-leads-v2.csv` on each run. Telegram completion ping uses `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (defaults to Heath's chat 7874782923).

### Adding brokerages

Edit `BROKERAGE_SEEDS` in `scripts/sa-realtor-scraper-trec.js`. Each entry uses an explicit `brokerLicense` (preferred, no fuzzy match) or `orgQuery` + `containsRequired` (fuzzy match with substring filter).

To find a brokerage's TREC license number:
```bash
curl -sL --get "https://www.trec.texas.gov/ts/collections/licenses/documents/search" \
  --data-urlencode "q=BROKERAGE NAME" \
  --data-urlencode "query_by=organizationName,dbas" \
  --data-urlencode "filter_by=type.subType:Broker Company && status.value:Active" \
  --data-urlencode "per_page=10" \
  -H "x-typesense-api-key: HvqEl9eBZY6YjQBAU8uW4e9KBGHRvqrd"
```

### Top brokerages in v3 output (per-broker agent counts)

```
600 KW Heritage (Hill Country, Canyon Lake, New Braunfels)
600 JBGoodwin REALTORS (SA + Austin)
587 Texas Premier Realty
520 KW SA Region (Boerne, CityView, Dominion, Kerrville, Bandera, Fredericksburg)
382 Vortex Realty
378 Coldwell Banker D'Ann Harper, REALTORS
325 Levi Rodgers Real Estate Group
317 Phyllis Browning Company
273 Kuper Sotheby's International Realty
247 San Antonio Legacy Group
170 BHHS Don Johnson REALTORS
 88 Exquisite Properties
 58 Reliance Residential Realty
 35 San Antonio Elite Realty
... (long tail of smaller SA brokerages)
```

### Caveats / known limitations

- **JBGoodwin** (600 agents) is SA + Austin + DFW. Pierce should send to SA-named offices first or de-dupe by manual office filter.
- **KW Heritage 434367-BB** scope extends slightly beyond Bexar (Canyon Lake, New Braunfels). Still SA metro for cold-outreach purposes.
- **Texas Premier Realty 9014663-BB** is SA-HQ but covers a broader Texas footprint via partner offices.
- All other brokerages in the seed list are SA-only.

### Compliance note

TREC ToS prohibits using public license data for "telephone solicitation." TREC has no rule against email outreach using publicly-derived brokerage-domain emails (which is what v3 does — we never use TREC's licensee personal email field, which is suppressed anyway). **Verify with Hadley before any send > 100 emails.**
