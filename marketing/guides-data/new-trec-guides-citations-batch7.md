# Citation trail — new TREC guide pages, batch 7 (2026-08-08)

One new guide: `texas-hydrostatic-testing-addendum-guide.json`, covering TREC Form 48-1
(Addendum for Authorizing Hydrostatic Testing). Zero prior coverage of this form in the repo,
confirmed by a prior scoping pass (not a deliberate earlier skip). Same primary-source-only
methodology as batches 1-6.

Sources used:
- TREC 48-1 PDF, fetched directly and read via the Read tool (full one-page form, all text and
  checkbox layout): https://www.trec.texas.gov/sites/default/files/pdf-forms/48-1.pdf
- TREC form detail page, fetched directly: https://www.trec.texas.gov/forms/addendum-authorizing-hydrostatic-testing-0
- TREC's own agency contracts listing page, fetched directly (second, independent source for the
  effective date): https://www.trec.texas.gov/agency-information/contracts
- 22 Tex. Admin. Code §537.55 (the TREC rule adopting the form), via Cornell Law's mirror, fetched
  directly: https://www.law.cornell.edu/regulations/texas/22-Tex-Admin-Code-SS-537-55
- Current TREC 20-19 One to Four Family Residential Contract PDF, fetched directly and read via
  the Read tool (page 4, Paragraph 7A), to confirm the base-contract clause that makes this
  addendum necessary: https://www.trec.texas.gov/sites/default/files/pdf-forms/20-19_4.pdf
- TREC FAQ page (URL slug reads "q-what-hydrostatic-test" but serves the "Can a licensed
  inspector perform a hydrostatic test?" Q&A — confirmed by fetching it twice), fetched directly:
  https://www.trec.texas.gov/q-what-hydrostatic-test

---

## texas-hydrostatic-testing-addendum-guide.json — TREC No. 48-1

| Claim | Source |
|---|---|
| Form number 48-1, printed form revision date 11-19-19 | 48-1 PDF, page 1 header/footer, read directly |
| Full text of Paragraph A (AUTHORIZATION), verbatim | 48-1 PDF, page 1 |
| Full text of Paragraph B (ALLOCATION OF RISK), all three checkbox options, verbatim, incl. the blank dollar-cap field in option (3) | 48-1 PDF, page 1 |
| Bolded/underlined instruction at top of form ("Consult a licensed plumber about the scope of hydrostatic testing and risks associated with the testing before signing this form") | 48-1 PDF, page 1 |
| Form header reads "PROMULGATED BY THE TEXAS REAL ESTATE COMMISSION (TREC)" (not "voluntary use") | 48-1 PDF, page 1 |
| TREC's listed effective date for this form: 03/01/2020 | Confirmed independently on two TREC pages: the form's own detail page (trec.texas.gov/forms/addendum-authorizing-hydrostatic-testing-0) and TREC's agency contracts listing page (trec.texas.gov/agency-information/contracts) — both fetched separately, both report 03/01/2020 |
| Form approved by the Commission in 2019 "for mandatory use as an addendum to be added to promulgated forms if the parties agree to hydrostatic testing" | 22 Tex. Admin. Code §537.55, fetched via Cornell Law mirror |
| No TREC 48-2 exists; 48-1 is the current version, no revision since adoption | Web search confirming no successor form is listed on TREC's site or in the admin code; TREC's own contracts listing page shows no revision date beyond the 03/01/2020 effective date |
| Base-contract Paragraph 7A text, verbatim: "Buyer may have the Property inspected by inspectors selected by Buyer and licensed by TREC or otherwise permitted by law to make inspections. Any hydrostatic testing must be separately authorized by Seller in writing." | Current TREC 20-19 PDF, page 4, Paragraph 7A, read directly off the page image |
| A general home inspector is not authorized to perform a hydrostatic test — only a licensed plumber | TREC FAQ, fetched directly (page confirms: "No, only a licensed plumber may perform a hydrostatic test on a system within a home"); corroborated by the 48-1 form's own Paragraph A language ("engage a licensed plumber") |

**Flagged and resolved during research:** an earlier web-search AI summary claimed TREC 48-1's
effective date was "07/01/2026" — that figure does not appear on either of the two TREC pages
fetched directly for this guide (both say 03/01/2020) and looks like a search-summary conflation
with the unrelated mandatory-use wave tied to the 20-19 contract update (documented in batch 4).
The guide uses only the two independently-confirmed, directly-fetched 03/01/2020 dates and does
not repeat the 07/01/2026 figure anywhere.

**Not independently verified, intentionally left out of the guide:** the specific "older homes /
cast-iron sewer line" framing for why this addendum gets used is standard real-estate-practice
context (consistent with how the form itself is worded and with general knowledge of the TX
housing stock), not a claim sourced to a specific TREC statistic or publication. The guide
presents it as practical context, not as a cited TREC statement.

**Not the same document as it may resemble:** older third-party listings reference a superseded
"TREC No. 48-0" version of this form. The guide is built entirely from the current 48-1 PDF
pulled fresh from trec.texas.gov, not from any cached or third-party copy of 48-0 or 48-1.
