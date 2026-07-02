# TREC 48-1 — Addendum for Authorizing Hydrostatic Testing

## Header

| Field | Value |
|---|---|
| Full title | Addendum for Authorizing Hydrostatic Testing |
| Form number | TREC No. 48-1 |
| Replaces | (Original 48-0) |
| Promulgation date printed on form | 11-19-19 |
| Mandatory or voluntary | Mandatory when applicable (promulgated) |
| Trigger to attach | Buyer wants to perform a hydrostatic plumbing test on the Property during option period or otherwise before closing. |
| Who signs | Buyer(s) AND Seller(s) |
| One-line summary | Authorizes Buyer to engage a licensed plumber to perform a hydrostatic plumbing test at Buyer's expense, and allocates liability for any damage caused by the test. |

**Source:** TREC 48-1 PDF (11-19-19 promulgation) at `trec.texas.gov/sites/default/files/pdf-forms/48-1.pdf`.

## Paragraph-by-paragraph rules

### Standalone advisory printed above ¶A
"Consult a licensed plumber about the scope of hydrostatic testing and risks associated with the testing before signing this form."

The advisory reflects a specific reality: hydrostatic pressure tests can damage aging cast-iron drain lines, especially in slab-foundation homes with 40+ year-old plumbing. The test PUTS PRESSURE on the drain system to detect leaks — but the pressure itself can burst a compromised line and worsen the problem.

### ¶A — Authorization
"Seller authorizes Buyer, at Buyer's expense, to engage a LICENSED plumber to perform a hydrostatic plumbing test on the Property."

- Buyer's cost.
- Plumber MUST be licensed (Texas plumbing license).
- Seller's affirmative authorization is required — a Buyer cannot conduct a hydrostatic test without this addendum (or equivalent signed permission).

### ¶B — Allocation of Risk (Check ONE box)
Three mutually-exclusive options:
- **(1) Seller shall be liable for damages** caused by the hydrostatic plumbing test.
- **(2) Buyer shall be liable for damages** caused by the hydrostatic plumbing test.
- **(3) Buyer shall be liable for damages caused by the hydrostatic plumbing test in an amount not to exceed $______.**

Option (3) is a capped-liability compromise — Buyer accepts responsibility up to a dollar limit, and any damage beyond that cap effectively falls back on Seller (or on the plumber's own liability policy).

## Deadline math

No affirmative day-count deadlines. The test would typically be scheduled during the TREC 20-18 ¶5 option period — Buyer must complete testing and any resulting termination decision within the option window.

## Common Q&A a working TX agent would ask

**Q1. What is a hydrostatic plumbing test and why would a buyer want one?**
A. It's a pressure test of the property's drain, waste, and vent (DWV) system — the plumber caps the sewer line at the cleanout, fills the drain system with water, and monitors whether the water level drops (indicating a leak). Common on slab-foundation Texas homes (post-1960 construction) where hidden slab leaks are a major latent defect. If the test reveals a leak, Buyer knows there's a plumbing failure under the slab.

**Q2. Why is authorization needed — can't the buyer just do it?**
A. The test can damage existing plumbing. Without Seller's authorization, Buyer causing damage during a hydrostatic test would face full liability without a signed risk allocation. 48-1 gives Seller informed consent + establishes who pays if damage occurs. (TREC 48-1 ¶A + ¶B.)

**Q3. Buyer wants ¶B(1) — Seller pays. Seller says no way. What now?**
A. Negotiate to ¶B(3) with a modest cap ($1,000-$2,500 is common; TREC unverified as codified benchmark). Or negotiate to ¶B(2) — Buyer takes full risk in exchange for Seller's permission. Which is fair depends on the age of plumbing, prior repair history, and how strongly Buyer wants the test. If Seller refuses to sign 48-1 at all, Buyer cannot lawfully perform the test on Seller's property.

**Q4. What's a typical dollar cap for ¶B(3)?**
A. Not codified. Practical range: $500-$2,500 depending on locale + plumbing age. Higher for older homes (higher risk of test causing damage). Ask the plumber's estimator what "worst-case" damage they've caused in a similar house — that number sets the floor for a defensible cap.

**Q5. Does the option period cover hydrostatic testing?**
A. Yes — hydrostatic testing typically happens during the TREC 20-18 ¶5 option period as part of Buyer's inspections. The option fee covers Buyer's unrestricted right to terminate; 48-1 adds the specific damages allocation for the test itself. Both operate concurrently.

**Q6. What if the licensed plumber isn't licensed in Texas?**
A. Not compliant. ¶A specifies "licensed plumber" — under Texas Occupations Code Ch. 1301 and TSBPE (Texas State Board of Plumbing Examiners) rules, the plumber must hold a current Texas plumbing license. Out-of-state licensing doesn't satisfy. Ask for the license number and verify at tsbpe.texas.gov.

**Q7. Test causes a burst in an old cast-iron pipe. Under ¶B(2), what does buyer owe?**
A. All damages caused by the test — repair cost of the burst pipe, water damage, restoration. Buyer bears full cost UNLESS Seller sues the plumber (which would be Seller's independent remedy). Practical: Buyer's plumber should carry general liability insurance; check the plumber's coverage BEFORE the test if Buyer is signing ¶B(2).

**Q8. Test reveals a leak — can Buyer terminate?**
A. Yes if within the option period — Buyer uses the unrestricted right under ¶5. After option expires, no automatic termination right based on hydrostatic test findings. Buyer's remedy after option might be to negotiate repairs via TREC 39-9 (Amendment to Contract) or accept the property. 48-1 itself does NOT grant termination rights.

**Q9. Does Seller have to be present for the test?**
A. Not required by the form. Best practice: give Seller (or listing agent) 24-hour notice of the scheduled test and access details. Coordinate through the listing agent to avoid access-friction. TREC unverified as codified.

**Q10. If both parties sign but ¶B is blank, what's the default liability?**
A. Ambiguous — do NOT leave ¶B blank. If unsigned/uncompleted, the form is defective on its face. Best practice: any test performed without a properly signed 48-1 exposes Buyer to full common-law liability for property damage. Complete ¶B before scheduling the test.

## Notes for the fill engine (Dossie internal)

- ¶B mutually exclusive checkboxes → `hydrostatic_liability_allocation` (values: seller / buyer / buyer_capped)
- ¶B(3) dollar cap → `hydrostatic_buyer_liability_cap`
- Two Buyer, two Seller signature lines
- No date fields in signature block (unusual)

## Authoritative + interpretive sources

- Form PDF: https://www.trec.texas.gov/sites/default/files/pdf-forms/48-1.pdf
- TREC form page: https://www.trec.texas.gov/forms/addendum-authorizing-hydrostatic-testing
- Texas Occupations Code Chapter 1301 — Plumbing licensing (TSBPE authority)
- Texas Real Estate Commission Advisory: Hydrostatic Testing (search TREC advisories for current guidance)

## Auto-draft sourcing note

Paragraph rules are direct from the codified TREC 48-1 PDF text (11-19-19). Q&A pairs are model-generated based on the paragraph rules + generally-accepted Texas inspection practice:
- Q1 mechanics of hydrostatic testing — plumbing industry practice; TREC unverified as form-codified.
- Q4 typical dollar caps — market observation, not TREC codified.
- Q6 TSBPE licensing verification — Ch. 1301 Tex. Occ. Code framework.
- Q9 Seller presence — TREC unverified; practical guidance.
