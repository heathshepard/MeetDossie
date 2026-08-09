# Citation trail — new TREC guide pages, batch 5 (2026-08-07/08)

One new guide, flagged twice earlier tonight and never built: the statutory exemptions to the
Texas Seller's Disclosure Notice requirement, Property Code § 5.008(e). The existing repo guide
`marketing/guides-data/texas-sellers-disclosure-notice-guide.json` (TREC 55-1) covers the form
itself and explicitly does not cover § 5.008(e) because that's statute, not TREC-form content —
this is the direct follow-up.

**Primary source, and how it was actually reached (worth documenting because it wasn't a plain
fetch):** `statutes.capitol.texas.gov` is now an Angular single-page app — WebFetch and a plain
`curl` against `https://statutes.capitol.texas.gov/Docs/PR/htm/PR.5.htm` both return only the SPA
shell (no statute text; it's client-rendered). Rather than fall back to a secondary summary site,
I traced the app's own JS bundles (`main-*.js` → lazy-loaded `chunk-LSHA6QJU.js`
`GetstatutedocComponent` → `chunk-UA4VGO6K.js` → `chunk-ZJ7HSB4W.js`) to find the backing API it
calls client-side: `https://tcss.legis.texas.gov/api/`. Hitting
`GET /api/GetStatute/GetStatute/PR/5.008/5.008/null/null/null/null/null/null/null/htm` returns the
resolved document URL, `https://tcss.legis.texas.gov/resources/PR/htm/PR.5.htm#5.008` — that
`tcss.legis.texas.gov/resources/...` path is the actual raw-HTML statute file the Angular app
displays; `statutes.capitol.texas.gov` is a front-end skin over the same Texas Legislature Council
data store. Confirmed live and current via response headers: `Last-Modified: Fri, 10 Apr 2026`,
served directly off `tcss.legis.texas.gov` (Texas Legislative Council infrastructure), not a
cached or third-party mirror.

Full chapter file fetched and Section 5.008 isolated by its `<a name="5.008">` anchor through to
the next section anchor (`5.0081`/`5.009` not present — 5.008 runs to the "Added by.../Amended
by..." block, confirmed by capturing the full amendment history). Section stripped of HTML tags
into plain text for direct quoting; verified the amendment history ends at "Acts 2023, 88th Leg.,
R.S., Ch. 390 (H.B. 697), Sec. 1, eff. September 1, 2023" — consistent with the 55-1 guide's own
citation of the September 1, 2023 effective date, and confirms no legislative session since (89th,
2025) amended this section.

---

## texas-sellers-disclosure-notice-exemptions.json — Property Code § 5.008

| Claim | Source |
|---|---|
| § 5.008(a) — duty to disclose applies to a seller of "residential real property comprising not more than one dwelling unit," verbatim | Statute text, subsection (a), fetched as above |
| § 5.008(e) opening line "This section does not apply to a transfer:" verbatim | Statute text, subsection (e) opening |
| Exemption (e)(1) — court order or foreclosure sale, verbatim | Statute text, (e)(1) |
| Exemption (e)(2) — trustee in bankruptcy, verbatim | Statute text, (e)(2) |
| Exemption (e)(3) — mortgagor/trustor to mortgagee/beneficiary (deed in lieu direction), verbatim | Statute text, (e)(3) |
| Exemption (e)(4) — mortgagee/beneficiary who acquired via power-of-sale, court-ordered foreclosure, or deed in lieu, reselling, verbatim | Statute text, (e)(4) |
| Exemption (e)(5) — fiduciary administering decedent's estate, guardianship, conservatorship, or trust, verbatim | Statute text, (e)(5) |
| Exemption (e)(6) — co-owner to co-owner, verbatim | Statute text, (e)(6) |
| Exemption (e)(7) — spouse or person(s) in lineal line of consanguinity, verbatim | Statute text, (e)(7) |
| Exemption (e)(8) — divorce/legal separation decree or incidental property settlement, verbatim | Statute text, (e)(8) |
| Exemption (e)(9) — to or from any governmental entity, verbatim | Statute text, (e)(9) |
| Exemption (e)(10) — new residence, not more than one dwelling unit, not previously occupied for residential purposes, verbatim | Statute text, (e)(10) |
| Exemption (e)(11) — dwelling value does not exceed 5% of property value, verbatim | Statute text, (e)(11) |
| § 5.008(c) — no duty to disclose death (natural/suicide/accident unrelated to property condition) or prior occupant HIV/AIDS status, verbatim | Statute text, subsection (c) |
| § 5.008(f) — notice must be delivered on or before the executory contract's effective date; if not delivered, purchaser may terminate for any reason within 7 days after receiving the notice, verbatim | Statute text, subsection (f) |
| Amendment history ends at Acts 2023, 88th Leg., R.S., Ch. 390 (H.B. 697), eff. Sept. 1, 2023 — no later amendment to this section | Statute text, "Amended by:" block at end of section |
| Cross-reference to TREC 55-1 / § 5.008(b) form content | Existing repo guide `texas-sellers-disclosure-notice-guide.json`, read for consistency, not re-verified (its own citation trail already covers the form text) |

**Interpretive note added in the guide itself, not left implicit:** exemption (e)(7)'s "lineal
line of consanguinity" is direct-line blood relatives (children, grandchildren, parents,
grandparents) and, on its text, does not reach collateral relatives — siblings, aunts, uncles,
nieces, nephews. This is stated as a plain reading of the statute's own wording, not as legal
interpretation of an edge case or an opinion on how a court would rule; the guide frames it as
"read the wording carefully," consistent with the descriptive-only brief for this page. The FAQ
answer on siblings uses the same framing.

**Flagged as ambiguous/needing attorney judgment, intentionally left undecided in the guide:**
- (e)(3) and (e)(4) are easy to conflate — (3) is the borrower transferring *to* the lender (deed
  in lieu), (4) is the lender *reselling* what it already took back. The guide keeps them as two
  separate bullets with the direction spelled out in plain language precisely to avoid this
  conflation, but which one applies to a given REO resale is still a title/chain-of-title question
  a TC should not resolve without confirming the actual deed history.
- (e)(11)'s "value of any dwelling does not exceed five percent of the value of the property" does
  not say who determines that valuation or as of what date (listing price? appraisal? tax
  assessment?) — the statute is silent on that mechanic. The guide quotes the clause verbatim and
  gives a plain-land/ranch example but does not guess at a valuation method, since the statute
  itself doesn't supply one.
- Nothing about *how* an exemption gets documented or represented in a transaction (e.g., whether
  title companies or brokers require anything in writing to rely on an (e) exemption) is stated
  anywhere in § 5.008 itself, so the guide doesn't invent a documentation practice — it says only
  that confirming which exemption applies is a fact-specific legal determination.

**Not flagged as ambiguous — confirmed clean:** the eleven exemptions numbered (1)-(11) in the
statute source map one-to-one to the eleven `<li>` items in the guide's `<ol>`, in the same order,
with no combining, splitting, or renumbering.

---

## Method note (for future batches hitting the same statutes.capitol.texas.gov wall)

`statutes.capitol.texas.gov`'s public-facing `/Docs/<CODE>/htm/<CODE>.<chapter>.htm` URLs no longer
serve raw HTML directly — they all resolve to the Angular SPA shell regardless of path, and the
real content only loads client-side. The reliable path to primary-source text without a headless
browser: call the site's own backing API directly at
`https://tcss.legis.texas.gov/api/GetStatute/GetStatute/<CODE>/<chapter>/<chapter>/null/null/null/null/null/null/null/htm`
(11 positional segments after the base path, the last being format), which returns a short text
response pointing at `https://tcss.legis.texas.gov/resources/<CODE>/htm/<CODE>.<chapter>.htm#<section>`
— that `resources` path serves the actual chapter file as plain HTML, one file per chapter
(section anchors via `<a name="X.XXX">`), fetchable directly with `curl` or `WebFetch`. No API key
or auth required. This is Texas Legislative Council's own data store, not a third party.
