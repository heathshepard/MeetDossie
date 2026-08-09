# Batch 20 citation trail — Wire Fraud / BEC Guide

Guide: `marketing/guides-data/texas-real-estate-wire-fraud-guide.json` (slug: `texas-real-estate-wire-fraud-guide`)

Topic: Wire fraud / Business Email Compromise (BEC) targeting Texas real estate closings.

---

## THE CORRECTION — read this before citing any BEC/real-estate stat in future batches

**The widely-repeated "FBI IC3 2025: real estate fraud losses $275.1M across 12,368 complaints"
stat is REAL but describes the WRONG CRIME.** NAR, HousingWire, and ALTA (in various secondary
write-ups) all cite this figure as if it measures closing/escrow wire fraud. It does not.

Verified directly from the primary source (FBI IC3 2025 Annual Report PDF, pulled and read
page-by-page, not summarized secondhand):

- IC3's own crime-type table (`2025 Crime Types, by Complaint Loss`, report p.8) lists
  **"Real Estate" as its own line item: 12,368 complaints / $275,110,419 in losses.**
- That "Real Estate" bucket is IC3's catch-all for real-estate-adjacent fraud generally —
  rental scams, timeshare scams, fraudulent property listings, investment-property fraud.
  It is NOT the category that captures closing-wire / escrow / BEC fraud.
- The category that actually captures closing-wire fraud is **Business Email Compromise (BEC)**,
  a separate line in the same table: **24,768 complaints / $3,046,598,558 in losses** — nearly
  11x the dollar amount of the "Real Estate" line, and the **second-highest loss category in the
  entire 2025 report**, behind only Investment fraud ($8,648,617,756). Confirmed on report p.9
  ("Top 5 Cyber-Enabled Fraud Crime Types by Loss": Investment, then BEC, then Tech Support,
  Confidence/Romance, Government Impersonation).
- Report p.10 breaks out BEC victim payment methods by pie chart: **Wire Transfer/ACH = 86%**
  of BEC transaction types — the highest concentration of any fraud category in that chart,
  which is exactly why wire fraud and BEC are functionally the same conversation in a real
  estate closing context.

**Rule for future batches:** when sourcing "real estate fraud" statistics from IC3, always check
which named crime-type row is being cited. "Real Estate" (IC3's own label) ≠ closing-wire fraud.
BEC is the correct bucket for anything involving spoofed closing instructions, escrow wire
diversion, or impersonated title/lender emails.

### Also confirmed wrong/stale (per the prior research pass — independently re-checked here, not reused as-is)

- **ALTA's "$12.5 billion" framing** — this is IC3's *all-crime, all-category* total loss figure
  from an earlier report year (2025 IC3 report's own multi-year loss chart, p.4, shows $12.5B
  landing at 2023, not 2025 — 2025's all-crime total is $20.877B). Not a real-estate-specific
  number under any reading. Confirmed via the same primary-source PDF used above — did not need
  to visit ALTA's page to confirm this is a mismatch, the IC3 report's own historical chart proves it.
- **CFPB's "1,100 percent increase" wire-fraud stat** — not re-verified as current; per the prior
  pass this lives on an archived/outdated CFPB page. Did not cite in the new guide.
- **TDI wire-fraud guidance** — confirmed TDI (Texas Department of Insurance) has NOT issued
  wire-fraud consumer guidance; the correct Texas regulator citation is TREC (Texas Real Estate
  Commission), not TDI. Did not cite TDI anywhere in the new guide.

---

## Sources used in the guide (all verified directly, not secondhand)

### 1. FBI IC3 2025 Annual Report (primary, most-weighted statistical source)

- URL: `https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf`
- Verification method: downloaded the actual PDF and read it page-by-page (not a web summary).
- Report covers calendar year 2025, published 2026 (25th anniversary edition, per report p.3).
- Numbers used in the guide, all quoted directly from the report's own tables:
  - **BEC: 24,768 complaints / $3,046,598,558 in losses** (p.7 "By Complaint Count" and p.8 "By
    Complaint Loss" tables).
  - BEC = second-highest loss category of 2025, after Investment fraud ($8,648,617,756) (p.9).
  - Wire Transfer/ACH = 86% of BEC victim payment methods, per the BEC-specific pie chart (p.10).
  - "Real Estate" IC3 crime-type line (kept separate, explicitly flagged in the guide as a
    *different* category, not used as the guide's headline stat): 12,368 complaints /
    $275,110,419 (p.7–8).
  - All-crime 2025 totals for context: 1,008,597 complaints, $20.877 billion in losses, 26%
    YoY increase (p.6).

### 2. FinCEN Advisory FIN-2019-A005

- URL: `https://www.fincen.gov/sites/default/files/2019-07/Updated%20BEC%20Advisory%20FINAL%20508.pdf`
- Title: "Updated Advisory on Email Compromise Fraud Schemes Targeting Vulnerable Business
  Processes." Issued **July 16, 2019**, supersedes FinCEN's 2016 BEC advisory.
- Verification method: downloaded the PDF locally and extracted text directly (`pdftotext`) —
  not a secondhand summary.
- Real-estate-specific stat used in the guide: FinCEN's top-3 BEC-targeted-sector ranking —
  (1) manufacturing/construction 25%, (2) commercial services 18%, **(3) real estate 16%**
  (advisory text, p.~6 per internal numbering — search string "top three sectors commonly
  targeted in BEC schemes").
  Quoted in the guide as "real estate is roughly 1 in 6 BEC-targeted sectors."
- Titled subsection used for the "how the scam actually works" framing: **"Business Process
  Compromise Example—BEC Targeting Real Estate Transactions."** Verbatim finding from that
  section: BEC criminals exploit (a) publicly available transaction details (agent names,
  property listings), (b) the fact that real estate counterparties communicate mostly by email,
  and (c) the general lack of strong authentication for verifying instruction changes.

### 3. TREC Consumer Alert — "Beware of Possible Scams before Sending Money via Wire Transfer"

- URL: `https://www.trec.texas.gov/article/beware-possible-scams-sending-money-wire-transfer`
- Verification method: fetched the live page directly.
- Publication date: **July 18, 2019**. Confirmed still the live, current version of this alert
  as of this research pass (no newer TREC wire-fraud alert found via site search).
- Core guidance quoted/paraphrased in the guide: TREC tells consumers to talk with their agent
  to confirm they're sending funds to the correct recipient/account, and explicitly warns
  **"Consumers should not rely on instructions sent by email without contacting their broker or
  sales agent to verify the instructions are correct, since emails may be hijacked by potential
  scammers."** The alert references a real recovered-funds case ($471,000) as illustration.
- This is the Texas-regulator-specific citation used in the guide (not TDI — confirmed TDI has
  not issued wire-fraud guidance, see correction section above).

### 4. ALTA Rapid Response Plan for Wire Fraud Incidents

- URL: `https://www.alta.org/file/ALTA-Rapid-Response-Plan-for-Wire-Fraud-Incidents.pdf`
- Verification method: downloaded the PDF directly and read the full text (not summarized from
  a secondary blog post).
- Confirmed version: **V.2.6, revised 03/03/2026**. Publicly downloadable, no login/paywall.
- Used as the structural basis for the guide's "if it already happened" kill-chain section
  (10 numbered steps in the source document): alert internal team → contact sending AND
  receiving bank fraud departments, request wire recall + Financial Fraud Kill Chain →
  notify transaction parties via known phone numbers → file an IC3 complaint → report to local
  law enforcement/FBI field office/Secret Service → confirm recall was processed → document
  → consider insurance/counsel → review security → international-funds counsel if needed.
  The guide's "kill chain" section is a condensed, agent-facing adaptation of these steps, not
  a verbatim copy.

---

## Cross-link

Guide cross-links to `texas-earnest-money-rules` (`marketing/guides-data/texas-earnest-money-rules.json`)
— earnest money transfer is exactly where wire-fraud risk concentrates in a Texas transaction
(the ¶5A funds-to-escrow-agent step). Added `texas-real-estate-wire-fraud-guide` to that guide's
own `related_guides` array would be a nice-to-have for a future batch but was NOT done here per
the isolation rule — only new files were touched in this pass.
