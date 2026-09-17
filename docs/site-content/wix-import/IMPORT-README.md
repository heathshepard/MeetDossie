# Wix CMS import pack — Boerne launch content

Generated 2026-09-17 on branch `content/boerne-launch`. Source of truth for the field
names is [`../seo-plan/ARCHITECTURE.md` §3](../seo-plan/ARCHITECTURE.md); the
`parentGuideUrl` requirement comes from
[`../seo-plan/SCHEMA-TEMPLATES.md` §5b](../seo-plan/SCHEMA-TEMPLATES.md).

**Regenerated 2026-09-17 (second pass).** Three structural fixes landed: internal links
now carry the real `/boerne/` prefix, slugs were normalised to the ARCHITECTURE §2 rules,
and every `body` is now HTML rather than Markdown. §6 and §8.1 below record what changed.
Re-run with `python3 build-wix-csv.py` — it is deterministic and self-verifying.

Every CSV is UTF-8, CRLF line endings, `QUOTE_ALL`. Bodies contain commas, double quotes
and newlines; they are quoted and escaped per RFC 4180. Each file was parsed back and
compared cell-for-cell against the source Markdown before being written — see
**Verification** below.

---

## 1. Which file goes into which collection

| CSV | Wix collection | Rows | Columns |
|---|---|---|---|
| `BoerneGuides.csv` | `BoerneGuides` | 10 | 16 |
| `Neighborhoods.csv` | `Neighborhoods` | 39 | 29 |
| `Answers.csv` | `Answers` | 59 | 13 |
| `Answers-faqJson-SUPPLEMENT.csv` | `Answers` — **only after you add a `faqJson` field** | 59 | 2 |

`Answers.csv` is 59 rows, not 60. See §6.

Column order in each CSV is exactly the field order in ARCHITECTURE.md §3, plus
`parentGuideUrl` appended to `Answers` per SCHEMA-TEMPLATES.md §5b.

All rows import with `status = "draft"`. Nothing becomes a live URL until you flip it,
which is the gate ARCHITECTURE.md §7.1 depends on. Do not bulk-flip to `live` before the
§9 quality gates pass — the empty fields in §4 below are part of those gates.

---

## 2. Field mapping — source frontmatter to collection field

### BoerneGuides

| Collection field | Source key | Note |
|---|---|---|
| `title` | `h1` | the on-page H1 the author wrote |
| `slug` | `slug` | |
| `metaTitle` | `title` | the author's SEO title. 8 of 10 exceed the 60-char spec — see §5 |
| `metaDescription` | `meta_description` | all 10 within 155 |
| `summary` | — | **empty, see §4** |
| `body` | Markdown body, leading `# H1` removed, **converted to HTML** — see §8.1 | |
| `heroImage`, `heroImageAlt` | — | **empty** |
| `datePublished`, `dateModified` | — | **empty** |
| `pageType` | assigned `guide` | all 10 are cornerstone guides per `boerne-hub/INDEX.md`; none is a facet |
| `faqJson` | — | empty; no FAQ JSON-LD was written into the guide sources, including 08 and 09 which declare `schema_type: FAQPage` |
| `relatedNeighborhoods`, `relatedAnswers` | — | **empty** |
| `wordCount` | `word_count` | |
| `status` | assigned `draft` | |

### Neighborhoods

| Collection field | Source key | Note |
|---|---|---|
| `name` | `neighborhood_name` | |
| `slug` | `slug` | |
| `metaTitle` | `title` | 22 of 39 exceed 60 chars — see §5 |
| `metaDescription` | `meta_description` | all within 155 |
| `summary` | — | **empty, see §4** |
| `body` | Markdown body, leading `# H1` removed, **converted to HTML** — see §8.1 | |
| `city` | parsed from `title` | controlled vocabulary `Fair Oaks Ranch` / `Comfort` / `Boerne`; all 39 resolved |
| `county` | `county` | |
| `latitude`, `longitude` | — | **empty** |
| `zipCodes` | `zip` | single value on every row |
| `schoolDistrict` | derived | filled only where the source names exactly one ISD. 7 rows left empty — see §4 |
| `elementarySchool`, `middleSchool`, `highSchool` | `schools[0..2]` | filled only where `schools` is a clean 3-campus list. 6 rows left empty — see §4 |
| `hoaFeeAnnual` | — | empty (optional). Per spec, left null rather than written as 0 |
| `hoaNotes` | `hoa_status` | |
| `priceRangeLow`, `priceRangeHigh`, `priceAsOf` | — | **empty** |
| `lotSizeTypical`, `yearBuiltRange`, `amenities` | — | empty (optional) |
| `heroImage`, `heroImageAlt` | — | **empty** |
| `nearbyNeighborhoods`, `relatedAnswers`, `parentGuide` | — | **empty** |
| `status` | assigned `draft` | |

### Answers

| Collection field | Source key | Note |
|---|---|---|
| `question` | `question` | |
| `slug` | `slug` | |
| `metaTitle` | `question` | no separate title in source. 15 of 59 exceed 60 chars — see §5 |
| `metaDescription` | `meta_description` | 10 rows run 156-160 chars — see §5 |
| `shortAnswer` | `short_answer` | **all 59 land inside the 40-60 word spec** (min 46, max 59) |
| `body` | Markdown body, minus the `# question` H1, minus the repeated short-answer paragraph, minus the trailing FAQ JSON-LD fence, **converted to HTML** — see §8.1 | the source repeats `short_answer` verbatim as body paragraph 1; the template renders it from the `shortAnswer` field (ARCHITECTURE.md §8), so leaving it in body would print it twice |
| `datePublished` | — | **empty** |
| `dateModified` | `last_reviewed` | |
| `parentGuide` | **assigned by rule** | see §3 |
| `parentGuideUrl` | derived from `parentGuide` | `https://www.theheathshepardrealestateteam.com/boerne/{guide-slug}` |
| `siblingAnswers` | `related_questions` | comma-separated answer slugs. Every row carries 4-6; spec asks 2-3 — trim in Wix |
| `sourceNote` | `sources` | newline-separated URLs, rendered visibly per spec |
| `status` | assigned `draft` | |

---

## 3. `parentGuide` / `parentGuideUrl` — assigned, not from source

The Answers source has no parent-guide field. It has a `category`. `parentGuide` is
required (breadcrumb + up-link) and `parentGuideUrl` is required for the
`BreadcrumbList` markup, so both were assigned by the rule below. **These are editorial
assignments, not source data — review and override them in Wix where you disagree.**

Category default:

| `category` | → guide |
|---|---|
| Boerne and the Hill Country | `real-estate-market` |
| Taxes and exemptions | `property-taxes` |
| Texas transaction mechanics | `buying-a-home` |
| Financing | `buying-a-home` |
| Investing | `real-estate-market` |
| Relocation | `relocation` |

Then nine per-slug overrides where the category was too coarse for a correct breadcrumb:

| Answer | → guide |
|---|---|
| `are-boerne-isd-schools-good` | `schools` |
| `boerne-vs-fair-oaks-ranch-vs-bulverde` | `vs-san-antonio` |
| `how-far-is-boerne-from-san-antonio` | `vs-san-antonio` |
| `what-are-property-taxes-like-in-boerne` | `property-taxes` |
| `can-an-hoa-ban-short-term-rentals-in-texas` | `short-term-rentals` |
| `is-boerne-good-for-short-term-rentals` | `short-term-rentals` |
| `is-hill-country-land-a-good-investment` | `land-and-acreage` |
| `what-should-i-know-about-septic-and-wells-in-the-hill-country` | `land-and-acreage` |
| `what-is-an-ag-exemption-in-texas-and-what-are-rollback-taxes` | `land-and-acreage` |

Resulting distribution: 25 buying, 12 market, 10 property taxes, 4 relocation, 3 land,
2 Boerne-vs-SA, 2 STR, 1 schools.

`parentGuideUrl` assumes guides live at `/boerne/{slug}` per ARCHITECTURE.md §2. **If the
guide URL pattern changes, this column must be regenerated** — Wix cannot rebuild it,
which is the whole reason the field exists.

---

## 4. Required fields the source does not supply

Nothing here was invented. These cells are empty and need a human or a research pass
before the affected rows can go `live`.

| Collection | Field | Rows affected | What is missing |
|---|---|---|---|
| BoerneGuides | `summary` | 10 | No 40-60 word AEO summary was written. This is the block LLMs extract (ARCHITECTURE.md §8) |
| BoerneGuides | `heroImage` / `heroImageAlt` | 10 | No images produced |
| BoerneGuides | `datePublished` / `dateModified` | 10 | Set at publish |
| BoerneGuides | `relatedNeighborhoods` (3-6) | 10 | No editorial link data. Without it every guide is an orphan (§4 of ARCHITECTURE) |
| BoerneGuides | `relatedAnswers` (3-5) | 10 | Same |
| BoerneGuides | `faqJson` | 10 | Optional, but 08 and 09 declare `schema_type: FAQPage` with no JSON written |
| Neighborhoods | `summary` | 39 | Same AEO gap as guides. Spec wants it verbatim as the first thing on the page |
| Neighborhoods | `latitude` / `longitude` | 39 | No centroids. `Place` schema `geo` cannot be emitted without them |
| Neighborhoods | `priceRangeLow` / `priceRangeHigh` / `priceAsOf` | 39 | No price band. `priceAsOf` is called "mandatory" in the spec |
| Neighborhoods | `heroImage` / `heroImageAlt` | 39 | No images produced |
| Neighborhoods | `nearbyNeighborhoods` (3-5) | 39 | Must be editorially chosen, explicitly not random (ARCHITECTURE §4) |
| Neighborhoods | `relatedAnswers` (2-3) | 39 | No link data |
| Neighborhoods | `parentGuide` | 39 | No per-neighborhood assignment in source. Suggested default: `real-estate-market` |
| Neighborhoods | `schoolDistrict` | 7 | Source names two districts for the same subdivision, so no single value is correct: `anaqua-springs-ranch`, `champee-springs-ranches`, `fair-oaks-ranch`, `highlands-ranch`, `lost-creek`, `sablechase`, `sundance-ranch` |
| Neighborhoods | `elementarySchool` / `middleSchool` / `highSchool` | 6 | Source `schools` is not a clean 3-campus list (split-district or "verify by address"): `anaqua-springs-ranch`, `champee-springs-ranches`, `fair-oaks-ranch`, `lost-creek`, `silver-hills`, `sundance-ranch` |
| Answers | `datePublished` | 59 | Set at publish. `dateModified` is populated from `last_reviewed` |

Two of these are load-bearing rather than cosmetic:

- **`summary` on 49 items** kills the AEO layer the whole architecture is built around.
- **The reference fields on every guide and neighborhood** mean 49 items import as
  orphans. ARCHITECTURE §4 calls this the difference between indexed pages and orphans.

---

## 5. Spec limits the content exceeds

Not truncated — truncating a title tag mechanically produces a worse title tag than a
long one. Tighten by hand before publish.

| Collection | Field | Over limit | Worst |
|---|---|---|---|
| BoerneGuides | `metaTitle` (≤60) | 8 of 10 | 78 chars |
| Neighborhoods | `metaTitle` (≤60) | 22 of 39 | 70 chars |
| Answers | `metaTitle` (≤60) | 15 of 59 | 82 chars |
| Answers | `metaDescription` (≤155) | 10 of 59 | 160 chars |
| Answers | `siblingAnswers` (2-3) | 59 of 59 | 6 entries (52 rows carry 5, 6 carry 4, 1 carries 6) |

The 10 over-length answer descriptions: `can-i-defer-my-property-taxes-in-texas-over-65`,
`do-i-need-a-real-estate-attorney-to-buy-a-house-in-texas`,
`do-i-need-flood-insurance-in-boerne`, `how-does-the-option-fee-work-in-texas`,
`moving-from-california-to-the-texas-hill-country`,
`texas-over-65-property-tax-exemption-and-school-tax-ceiling`,
`what-is-a-t-47-affidavit`,
`what-is-an-ag-exemption-in-texas-and-what-are-rollback-taxes`,
`what-is-earnest-money-in-texas-and-is-it-refundable`,
`who-pays-for-the-survey-in-texas`.

---

## 6. Slug conformance — done, and it is now locked

ARCHITECTURE.md §2 sets the slug rules and calls slugs permanent on write. The guide and
neighborhood slugs did not follow them. Nothing was published, so they were normalised
here rather than left to be redirected later — Wix's redirect handling on a changed
dynamic slug is manual.

| | Spec says | Was | Now |
|---|---|---|---|
| Guides | the topic, not the format | `boerne-property-taxes-explained` | `property-taxes` → `/boerne/property-taxes` |
| Neighborhoods | the subdivision name as a buyer would type it | `cordillera-ranch-boerne-tx` | `cordillera-ranch` → `/neighborhoods/cordillera-ranch` |
| Answers | the question in 4-7 words | conformed already | unchanged, all 59 |

All ten guide slugs:

| # | Was | Now | Published URL |
|---|---|---|---|
| 01 | `boerne-tx-real-estate-market` | `real-estate-market` | `/boerne/real-estate-market` |
| 02 | `buying-a-home-in-boerne-tx` | `buying-a-home` | `/boerne/buying-a-home` |
| 03 | `selling-a-home-in-boerne-tx` | `selling-a-home` | `/boerne/selling-a-home` |
| 04 | `boerne-vs-san-antonio-which-should-you-buy-in` | `vs-san-antonio` | `/boerne/vs-san-antonio` |
| 05 | `boerne-isd-schools-guide` | `schools` | `/boerne/schools` |
| 06 | `cost-of-living-in-boerne-tx` | `cost-of-living` | `/boerne/cost-of-living` |
| 07 | `moving-to-boerne-tx-relocation-guide` | `relocation` | `/boerne/relocation` |
| 08 | `boerne-property-taxes-explained` | `property-taxes` | `/boerne/property-taxes` |
| 09 | `boerne-tx-short-term-rental-rules` | `short-term-rentals` | `/boerne/short-term-rentals` |
| 10 | `buying-land-and-acreage-in-kendall-county-tx` | `land-and-acreage` | `/boerne/land-and-acreage` |

Neighborhoods: 38 of 39 dropped a trailing geographic qualifier, so the slug is now the
subdivision name and matches the source filename exactly
(`cordillera-ranch-boerne-tx` → `cordillera-ranch`, `fair-oaks-ranch-tx` →
`fair-oaks-ranch`, `front-gate-fair-oaks-ranch-boerne-tx` → `front-gate`, and so on).
`boerne-original-town-historic-district` already conformed and is unchanged.

**Internal links are fixed too.** Every internal link in the guide bodies previously
omitted the `/boerne/` prefix (`/buying-a-home-in-boerne-tx`, not
`/boerne/buying-a-home`) and would have 404'd on publish. All five were repaired. Seven
answer-body links plus one in `answers/INDEX.md` pointed at the old short-term-rental
guide slug and were repointed. Answer-to-answer links used `/answers/{slug}` and were
already correct; all 59 answer slugs are unchanged, so none of them moved.

After the pass: **320 internal links, every one resolving to a slug that exists in this
export**, verified by the exporter itself (see §9). Zero references to any old slug
survive anywhere in `docs/site-content/`.

## 7. Resolved duplicate

`answers/what-are-the-short-term-rental-rules-in-boerne.md` was cut. It duplicated the
BoerneGuides cornerstone `short-term-rentals`, which is more than twice as
long and cites Ordinance 2023-09 section by section. Its five inbound links were
repointed to the guide; the slug was removed from five `related_questions` lists and from
`answers/INDEX.md`. Detail in the commit message and in the report on this branch.

That is why `Answers.csv` has 59 rows.

---

## 8. What a human must do in Wix that a CSV cannot carry

1. ~~**Convert `body` from Markdown to HTML.**~~ **Done.** `body` is now HTML on all 108
   rows and loads straight into a Wix **Rich Text** field. The conversion runs through
   [markdown-it-py](https://github.com/executablebooks/markdown-it-py), a
   CommonMark-compliant parser, with the GFM table rule enabled — not a regex. It runs
   with `linkify` off (so no anchor is invented that the source did not contain),
   `typographer` off (so no character in the final prose is silently rewritten) and raw
   HTML disabled. Output covers `<h2>`-`<h6>`, `<table>`/`<thead>`/`<tbody>`, `<ul>`,
   `<ol>`, `<blockquote>`, `<strong>`, `<em>` and `<a href>`.

   One construct needed handling beyond the library's defaults. Several answer pages quote
   TREC forms containing literal blank-fill runs — `EXECUTED the ___ day of ___, 20___.`
   Under CommonMark's flanking rules the second and third runs are a valid emphasis pair,
   so a conforming renderer eats them and publishes `the ___ day of , 20.` on a page about
   contract mechanics. The exporter escapes every `_` outside a link destination before
   rendering, which is lossless (nothing in this corpus uses `_` for emphasis — all
   emphasis is written with `*`) and makes that class of corruption impossible.

   The Markdown sources under `../boerne-hub/`, `../boerne-neighborhoods/` and
   `../answers/` are untouched and remain the editing surface. HTML exists only in the CSV.
2. **Create the collections and fields first,** with the exact names and types in
   ARCHITECTURE.md §3. Wix matches CSV columns to existing fields by name; it will not
   create typed fields for you. In particular add `parentGuideUrl` (Text) to `Answers` —
   it is not in §3's table, it comes from SCHEMA-TEMPLATES.md §5b, and without it the
   `BreadcrumbList` markup on 59 answer pages is broken.
3. **Add `faqJson` (Text) to `Answers`** if you want the 59 hand-written `FAQPage`
   blocks, then load `Answers-faqJson-SUPPLEMENT.csv`. They are valid JSON (all 59 parse).
   Without that field they have nowhere to go — §3 gives `faqJson` to `BoerneGuides` only.
   The alternative is pasting each one per page via SCHEMA-TEMPLATES.md Path A, 59 times.
4. **Connect every reference and multi-reference field by hand.** `parentGuide`,
   `relatedNeighborhoods`, `relatedAnswers`, `nearbyNeighborhoods`, `siblingAnswers`.
   Wix CSV import does not populate multi-reference fields; the slug lists in those
   columns are carried as data for whoever wires them up (Velo, or by hand).
5. **`zipCodes` and `amenities` are Tags fields.** Confirm Wix parses the single value in
   `zipCodes` as a tag rather than a string on import; re-enter if not.
6. **Upload hero images and set `heroImage` / `heroImageAlt`.** 49 items, none supplied.
   ARCHITECTURE §9 requires 1 original image per guide and per neighborhood.
7. **Build both layouts per dynamic template** — Classic Editor keeps a separate mobile
   design (C10). Six templates, twelve layouts.
8. **Add the structured data per page type** from SCHEMA-TEMPLATES.md, using the Add
   Variable picker. Typed `{{placeholders}}` render literally.
9. **Put the sitewide contact/CTA block in the template, not in `body`.** Every page now
   publishes `830-446-3847` (`tel:+1-830-446-3847`) and `heath.shepard@kw.com`. On guides
   and neighborhoods that sits inside page-specific CTA prose and belongs in `body`. On
   the 59 answer pages it is a two-line block identical across all of them — ARCHITECTURE
   §9 wants zero shared sentences in collection text fields, so that block is the one
   thing worth lifting out of `body` and into the answers template design.
10. **Set `datePublished`** at publish. It is empty on all 108 rows.
11. **Read `../*/NEEDS-VERIFICATION.md`** in each content directory before flipping
    anything to `live`. Those are the authors' own open items.

---

## 9. Verification performed

Re-runnable and self-failing: `build-wix-csv.py` raises and writes nothing usable if any
check below fails. The exporter is deterministic.

- Each CSV is parsed back with `csv.DictReader` and compared **cell for cell** against the
  in-memory source rows. Header order and row count checked against the spec. All four
  files pass.
- **Every link is re-extracted from the written CSV** (not from memory) and compared to
  the link list of the Markdown it came from — same targets, same order. **1,069 links,
  zero lost, zero altered, zero invented.** That is the prior pass's **853** citation and
  internal links (533 external citations + 320 internal), plus the 216 `tel:`/`mailto:`
  links in the contact blocks that the earlier count did not include.
- **Every internal link resolves.** All 320 are checked against the slugs actually present
  in this export; an unresolvable one fails the build. Before this pass, 5 did not resolve.
- **Text fidelity.** The visible text of each HTML body is compared against the visible
  text of its Markdown source, computed by an independent stripper that does not use
  markdown-it. Any prose dropped, reordered or invented by the conversion fails the build.
  108 of 108 bodies match exactly.
- **No unconverted Markdown.** Each body is scanned for literal `#` headings, `|` table
  rows and `**` bold. None found.
- 1,331 block-level elements (`h2`-`h6`, `table`, `ul`, `ol`, `blockquote`) emitted across
  the 108 bodies.
- The four most structurally complex documents were additionally rendered in a real
  browser and read: `property-taxes` (8- and 6-row tables), `cost-of-living`,
  `cordillera-ranch`, and `what-is-the-amendment-to-contract-form-in-texas` (the TREC
  blank-fill case). Tables, headings, bold, blockquotes, links and the `___` runs all
  render correctly.
- All 59 `faqJson` values parse as JSON. All valid.
- Contact details: 108 of 108 content pages carry both `tel:+1-830-446-3847` and
  `mailto:heath.shepard@kw.com`. The 808 number appears nowhere in the content
  directories — the only occurrences in this tree are in `seo-plan/FIX-PRIORITY.md`,
  which documents the existing NAP inconsistency on the live site.
