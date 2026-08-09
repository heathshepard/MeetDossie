# Citation trail — new TREC guide pages, batch 6 (2026-08-08)

One new guide: SB 1968 (89th Leg., R.S., 2025) — the new written-agreement requirement before a
Texas agent shows residential property or submits a buyer's offer — plus TREC's companion IABS
1-2 form update. This is a statute change *and* a form change governed by the same statute, so it
follows the same pattern as the repo's `texas-hoa-addendum-guide.json` (form + governing rule in
one page) rather than the split pattern used for `texas-sellers-disclosure-notice-guide.json` /
`texas-sellers-disclosure-notice-exemptions.json` (those were split because the exemptions are a
large, separate statutory topic in their own right — § 5.008(e)'s eleven categories don't fit on
the form-focused 55-1 page). Here, the IABS 1-2 form *is* the direct implementing artifact of the
same statute the written-agreement requirement comes from — TREC updated the form specifically to
carry the new § 1101.562/§ 1101.563 disclosures. One page, not two.

**Slug chosen:** `sb-1968-texas-buyer-agreement-guide`. Reasoning: agents are going to search "SB
1968" by bill number (it's the most-searched term in the trade press right now — License
Classroom, GFWAR, MetroTex, TAR-affiliated sites all use it as the headline term), so the bill
number needed to be in the slug and title, not just the statute citation, unlike the disclosure
guides which lead with the Property Code section number because that's how that topic gets
searched.

---

## Primary sources used, and exactly how each was reached

### 1. The bill itself — SB 1968, 89th Leg., R.S. (2025), enrolled version

**New access method for a bill (not a codified statute section) — documented here because batch5's
`tcss.legis.texas.gov` method is for *codified* statute chapters, and a bill's as-passed text is a
different document that doesn't live at that path.**

`capitol.texas.gov` bill text URLs follow a predictable pattern per version:
`https://capitol.texas.gov/tlodocs/<SESSION>/billtext/html/<BILLID><VERSION>.HTM`, where
`<VERSION>` is a single letter — `I` = introduced, `S` = engrossed (Senate-passed), `E` = engrossed
(House-passed, when it started in the other chamber), `F` = enrolled (the final version actually
signed/filed and sent to the Secretary of State — this is the authoritative "what became law" text).
For SB 1968: `https://capitol.texas.gov/tlodocs/89R/billtext/html/SB01968F.HTM`. Unlike
`statutes.capitol.texas.gov`, this bill-text path is **not** behind an Angular SPA wall — it's
server-rendered HTML directly, fetchable with a plain `curl -A "Mozilla/5.0" <url>` (no browser
needed, no API detour required). The `F`-suffix URL is quoted directly, verbatim, inside the
codified Occupations Code chapter file itself as the authority citation for every section SB 1968
touched (e.g. "Acts 2025, 89th Leg., R.S., Ch. 1172 (S.B. 1968), Sec. 10, eff. January 1, 2026" —
confirmed the bill-text hyperlink embedded in that citation resolves to the same `SB01968F.HTM`
URL used here), which cross-confirms this is in fact the enacted version, not a superseded draft.

The raw HTML is a page-line-numbered legislative print (`<table>`-based, one line per `<td>`, with
`PGLN` metadata markers) — stripped to plain text with `sed -e 's/<[^>]*>//g' -e 's/&#xA0;/ /g'`
for readable SECTION-by-SECTION reading. Confirmed via `capitol.texas.gov/BillLookup/History.aspx?
LegSess=89R&Bill=SB1968`: filed 03/05/2025, passed Senate 04/16/2025, passed House with amendment
05/09/2025, Senate concurred 05/21/2025, reported enrolled 05/22/2025, **filed without the
Governor's signature 06/22/2025** (became law without a signature, not vetoed), enrolled version
code `89R 11266 RAL-F`. SECTION 19 of the enrolled text: "This Act takes effect January 1, 2026."

### 2. The codified statute — TRELA, Texas Occupations Code Chapter 1101 (post-SB-1968)

Same method batch5 documented: `GET https://tcss.legis.texas.gov/api/GetStatute/GetStatute/OC/
<section>/<section>/null/null/null/null/null/null/null/htm` (section passed twice, e.g.
`1101.560/1101.560`) resolves to `https://tcss.legis.texas.gov/resources/OC/htm/OC.1101.htm#
<section>` — one file for the whole chapter, fetched once with `curl`, sections isolated by their
`<a name="1101.XXX">` anchors. Confirmed this chapter file's own embedded "Amended by:" /
"Added by:" history blocks are the authoritative source of which bill section added or amended
which statute section — cross-checked every one against the bill's own SECTION-by-SECTION text
(see the section-by-section table below) and they match exactly.

### 3. TREC's own published guidance (not third-party summaries)

- `https://www.trec.texas.gov/article/what-changes-2026-about-buyertenant-representation-texas` —
  TREC's own article, "What Changes in 2026 About Buyer/Tenant Representation in Texas," byline
  Summer Mandell, dated 01-07-2026. This page is server-rendered (unlike a second TREC article
  found in search, `/article/brokers-what-sb-1968-means-you`, which returned only nav-shell
  boilerplate on a plain `curl` — that page's body appears to require JS to render and was **not**
  used as a source; nothing from it is cited in the guide). The Mandell article was fetched with
  `curl -A "Mozilla/5.0"`, HTML tags stripped, and the full article body read directly — this is
  the source for: the two-new-sections framing, the non-representation showing requirements list,
  the "does not apply to commercial purchasers or residential/commercial tenants" scope statement,
  the representation-vs-non-representation two-path framing, the open-house nuance (verbatim
  quotes), and the subagency note (verbatim quote).
- `https://www.trec.texas.gov/does-trec-have-promulgated-listing-agreement-form` — TREC's general
  FAQ page (fetched the same way), which contains the verbatim answer to "Does TREC have a
  promulgated buyer representation agreement?" — "No... is a private contract between a real
  estate broker and a buyer and is not promulgated or regulated by TREC" — and the verbatim answer
  on IABS mandatory-reproduction rules citing "[Rule 531.20(e)]."
- `https://www.trec.texas.gov/sites/default/files/pdf-forms/IABS%201-2.pdf` — the actual live,
  current IABS PDF, linked directly off TREC's FAQ/IABS pages. Downloaded and read in full. Form
  number **IABS 1-2** appears in the bottom-right corner of the form itself; revision date
  **11-03-2025** appears in the top-right corner. Full text of every section on the form was read
  directly from this PDF, not inferred from a description.

---

## sb-1968-texas-buyer-agreement-guide.json — claim table

| Claim | Source |
|---|---|
| SB 1968 = Acts 2025, 89th Leg., R.S., Ch. 1172; filed without Governor's signature 06/22/2025; eff. Jan 1, 2026 | Enrolled bill text SECTION 19 + `capitol.texas.gov/BillLookup/History.aspx` legislative history, both fetched directly |
| § 1101.562 (Real Property Showings Without Representation) and § 1101.563 (Written Agreement Required) added, full text of both, verbatim | Enrolled bill text SECTION 10, cross-confirmed against codified chapter file `OC.1101.htm#1101.562` / `#1101.563`, which shows "Added by Acts 2025, 89th Leg., R.S., Ch. 1172 (S.B. 1968), Sec. 10, eff. January 1, 2026" for both |
| § 1101.558(b-1) amended to add subdivision (3) — obligations disclosure for non-represented parties | Enrolled bill text SECTION 9, cross-confirmed against codified `#1101.558` |
| § 1101.652(b)(34) added — failing to enter into the § 1101.563 written agreement is a disciplinary ground | Enrolled bill text SECTION 11, verbatim: "fails to enter into a written agreement with a prospective buyer as required by Section 1101.563" |
| § 1101.653 (certificate holders) parallel amendment | Enrolled bill text SECTION 12 |
| § 1101.002(8) and § 1101.805(f) repealed | Enrolled bill text SECTION 13; codified chapter file confirms both show "Repealed by Acts 2025, 89th Leg., R.S., Ch. 1172 (S.B. 1968), Sec. 13(1)/(2), eff. January 1, 2026" |
| § 1101.563(a) "residential real property" definition — single-family house; duplex/triplex/quadraplex; condo/co-op unit — verbatim | Codified `#1101.563`, cross-confirmed against enrolled bill SECTION 10 |
| § 1101.563(c) required content list, verbatim | Codified `#1101.563` |
| § 1101.563(d) — separate agreement required if more brokerage acts follow a showing-only engagement | Codified `#1101.563`, subsection (d) |
| § 1101.563(e) — showing-only agreement may not be exclusive, may not exceed 14 days | Codified `#1101.563`, subsection (e), verbatim |
| § 1101.562(a)–(c) — four conditions for showing without representation; may confirm size/price/terms | Codified `#1101.562`, verbatim |
| "does not apply to commercial purchasers or residential/commercial tenants" | TREC article (Mandell, 01-07-2026), quoted verbatim |
| § 1101.562 covers "residential, farm and ranch, and commercial" property (broader than § 1101.563) | TREC article, quoted verbatim |
| Two-path framing: representation agreement vs. non-representation showing-only agreement; representation agreements "cannot waive the minimum duties owed to clients" | TREC article, quoted/paraphrased directly |
| IABS form updated to reflect SB 1968; current edition is IABS 1-2, dated 11-03-2025, effective/required Jan 1, 2026; prior edition was IABS 1-1 | Live IABS 1-2 PDF (form number + date read directly off the document) + TREC article's statement "the new IABS form is effective and required for use beginning January 1, 2026" + TREC FAQ's older reference to a prior "IABS 1-0" edition, which independently confirms TREC's edition-numbering convention (form number increments with content revisions) |
| Full content of the current IABS 1-2 form — all six section headers, the "WRITTEN AGREEMENTS ARE REQUIRED" paragraph naming § 1101.563, the "CAN SHOW PROPERTY... WITHOUT REPRESENTING" section mirroring § 1101.562's four conditions, no subagency section present | Live IABS 1-2 PDF, read in full |
| IABS form mandatory "for all practical purposes"; verbatim-reproduction rule citing Rule 531.20(e) | TREC FAQ page, quoted verbatim |
| TREC does not promulgate a buyer representation agreement form ("private contract... not promulgated or regulated by TREC") | TREC FAQ page, quoted verbatim |
| No separate TREC-promulgated non-representation/showing-only form exists | Absence of any such form anywhere in TREC's SB 1968 guidance, forms library, or FAQ — see "flagged as confirmed, not guessed" note below |
| § 1101.558(c)(3) open-house exception to the IABS notice, verbatim | Codified `#1101.558`, subsection (c) |
| Open-house scenario: listing-side agent doesn't need IABS/written agreement, just oral/written disclosure of representing the owner | TREC article, paraphrased from its "For Agents with the Listing Brokerage" section |
| Open-house scenario: non-listing-side agent (incl. showing agent bringing own buyer) must provide IABS and § 1101.563 agreement before the showing, even if buyer has an agreement with another broker | TREC article, quoted/paraphrased directly, including the "even when a prospective buyer has a written representation agreement with another broker" quote |
| "If a buyer refuses to sign the agreement, then the agent cannot show the property, meaning a consumer cannot view the open house" | TREC article, quoted verbatim |
| Subagency: two references removed from TRELA, but "not been eliminated generally as a legal concept" | TREC article, quoted verbatim |
| Comparison to Seller's Disclosure Notice's explicit 7-day buyer termination right (§ 5.008(f)) as a contrast point — § 1101.563 has no comparable stated buyer remedy | § 5.008(f) verbatim text already sourced and cited in batch5's citation trail (`new-trec-guides-citations-batch5.md`); re-used for comparison, not re-verified this session since batch5 already carries its own citation |

---

## Flagged as ambiguous / needing attorney judgment — intentionally left undecided in the guide

- **What counts as "showing" a property.** Neither § 1101.562 nor § 1101.563 defines the term.
  Whether a virtual/video walkthrough, an unaccompanied lockbox self-tour, or a drive-by consult
  triggers the written-agreement requirement the same way an in-person walkthrough does is not
  addressed in the statute text as fetched, and no TREC guidance found in this research addresses
  it either. The guide states this as an open question rather than picking an answer.
- **Electronic signature.** § 1101.563 requires a "written agreement" but the statute text located
  says nothing about e-signature platforms specifically. Texas generally recognizes electronic
  signatures under separate law (the Texas Uniform Electronic Transactions Act), but SB 1968 itself
  doesn't cross-reference that or otherwise address the interaction — this session did not fetch
  UETA text to confirm applicability to this specific agreement type, so the guide flags this as
  unresolved rather than asserting e-signature is fine.
- **Farm-and-ranch classification under § 1101.563(a)(1).** "A single-family house" is not defined
  further in the section, and it's genuinely unclear from the statute's text alone whether a ranch
  or acreage property with a residence on it is a "single-family house" for purposes of triggering
  the written-agreement mandate, versus falling outside it as non-"residential real property" the
  way raw land or a pure working ranch would. TREC's guidance states § 1101.562 (conduct rules)
  covers farm and ranch broadly, but never states whether § 1101.563 (the mandatory written
  agreement) does. The guide states this as a gray area rather than picking a side — this matters
  in practice for the repo's existing farm-and-ranch audience, which is why it's called out and
  linked from that guide.
- **Contract-enforceability consequence of a missing agreement.** § 1101.652(b)(34) is clearly a
  *licensing/disciplinary* consequence. Nothing in the statute text fetched states whether a
  missing written agreement also affects the underlying transaction's validity, or a broker's
  right to compensation, the way the Seller's Disclosure statute expressly gives buyers a
  termination right when that notice is missing. The guide explicitly declines to answer this and
  frames it as a contract-enforcement question for an attorney — this is treated as the single
  highest-stakes ambiguity on the page, since agents are likely to ask "so is the deal still valid
  if I forgot the paperwork," and the honest answer from primary sources is "the statute doesn't
  say."

## Not flagged as ambiguous — confirmed clean

- **No separate TREC-promulgated "non-representation" or "showing-only" form exists.** This was the
  specific open question flagged by the prior scoping pass. Confirmed via two independent,
  convergent primary sources: (1) TREC's own FAQ stating buyer representation agreements generally
  are private contracts "not promulgated or regulated by TREC," and (2) the complete absence of any
  such form anywhere in TREC's own SB 1968 guidance article, its FAQ, or its live forms library —
  the only document TREC actually promulgates and publishes in this space is the IABS 1-2 notice.
  This is a confirmed **no**, not an assumption.
- **IABS 1-2 is in fact the current, live, in-force edition** — confirmed by reading the actual PDF
  hosted at TREC's own domain (not a mirror or third-party copy), which shows the form number and
  revision date directly on the document, and by TREC's own article independently stating the
  updated form "is effective and required for use beginning January 1, 2026."
- **The open-house exception does not extend to SB 1968's written-agreement requirement for a
  non-listing-side agent** — this is directly and explicitly stated by TREC's own guidance, not an
  inference; quoted verbatim in the claim table above.

---

## Method note (for future batches researching a bill rather than a codified statute section)

Two source types, two different access paths on `*.legis.texas.gov` / `*.capitol.texas.gov`:

1. **A codified statute section already in force** (e.g. Property Code § 5.008, Occupations Code
   § 1101.563) → use batch5's method: `tcss.legis.texas.gov/api/GetStatute/GetStatute/<CODE>/
   <section>/<section>/null×7/htm` to resolve the chapter file URL, then fetch that chapter file
   directly.
2. **A bill's as-passed/enrolled text** (needed when you want the legislature's own framing, the
   effective-date clause, the section-by-section structure showing exactly what each SECTION of
   the bill did, or bill history/vote/signature status) → `capitol.texas.gov/tlodocs/<session>/
   billtext/html/<BILLID><version-letter>.HTM` — server-rendered, no SPA wall, plain `curl` works.
   Use version letter `F` (enrolled) for "what actually became law," not `I` (introduced) or `S`/
   `E` (chamber-passed) — those can differ substantially after amendment. Cross-confirm you have
   the enrolled version by checking that its URL matches the one embedded in the codified statute's
   own "Amended by: Acts ..." citation line — if they match, you have the right bill text.
   Legislative history/vote/signature status: `capitol.texas.gov/BillLookup/History.aspx?
   LegSess=<session>&Bill=<BILLID>` (also plain HTML, no SPA wall).

For an agency's own guidance (TREC or otherwise), check whether the specific article page is
server-rendered before relying on it — one of TREC's two SB 1968 articles fetched clean via plain
`curl`; a second TREC article at a different URL returned only nav-shell boilerplate and required
JavaScript, and was correctly discarded as a source rather than guessed from its title.
