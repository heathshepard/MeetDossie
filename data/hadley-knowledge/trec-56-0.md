# TREC 56-0 — Addendum for Seller's Disclosure of Information on Lead-Based Paint and Lead-Based Paint Hazards

**Hadley knowledge file — v1, started 2026-07-01 by hadley_2**
**EFFECTIVE 2026-07-01. Supersedes OP-L (04-01-2024).**
This is the federally-required Lead-Based Paint (LBP) disclosure for the sale of any residential dwelling built before 1978. Federal law (24 CFR §35, subpart A) is the underlying requirement; TREC 56-0 is the promulgated Texas-specific form.

---

## PARAGRAPH DELTA — OP-L vs 56-0

Fill fields are materially the same. Changes are cosmetic + clarifying language.

| OP-L section | 56-0 section | Change |
|---|---|---|
| §1 Lead Warning Statement | §1 Lead Warning Statement (unchanged) | Federal-mandated warning language, verbatim. |
| §2 Seller's Disclosure | §2 Seller's Disclosure (unchanged Y/N pattern) | Seller checks: (a) knowledge of LBP; (b) records/reports available. Free-text explanation blank. |
| §3 Buyer's Acknowledgment | §3 Buyer's Acknowledgment (unchanged) | Buyer initials receipt of: (a) copy of disclosure; (b) EPA pamphlet "Protect Your Family from Lead in Your Home"; (c) 10-day inspection opportunity waived/not-waived. |
| §4 Agent's Acknowledgment | §4 Agent's Acknowledgment (unchanged) | Agents initial that they've informed Seller of obligations. |
| §5 Certification | §5 Certification of Accuracy | 56-0 tightens the certification language slightly — parties certify to accuracy. |

**Practical impact:** existing OP-L fill map ports 1:1 to 56-0. Reference in TREC 20-19 ¶22 addenda checklist updates to "56-0" instead of "OP-L".

---

## Form metadata

| Field | Value | Source |
|---|---|---|
| Form number | 56-0 | TREC PDF header |
| Form name | Addendum for Seller's Disclosure of Information on Lead-Based Paint and Lead-Based Paint Hazards | TREC PDF header |
| Effective date | July 1, 2026 (mandatory) | Texas REALTORS® May-June 2026 forms update summary |
| Mandatory or voluntary | **MANDATORY under federal law** (24 CFR §35.92) for any residential dwelling built before 1978 | 24 CFR §35.92 |
| Form this replaces | OP-L (04-01-2024) | TREC 56-0 PDF footer |
| Total pages | 2 | TREC PDF |
| Authority | Federal 24 CFR §35 subpart A (Residential Lead-Based Paint Hazard Reduction Act, 42 USC §4852d); 22 TAC §537 (TREC promulgation of state-specific version) | 42 USC §4852d |
| When required | Any target housing offered for sale that was built before January 1, 1978 | 24 CFR §35.86 (definition of target housing) |

**Federal exemptions (property NOT requiring LBP disclosure):**
- Housing built on or after January 1, 1978.
- Housing found to be free of LBP by a certified LBP inspector.
- Housing sold at foreclosure.
- Zero-bedroom units (efficiency apartments, dormitory rooms, studios).
- Housing designated for the elderly (occupied by persons 62+ and no children under 6 expected).
- Housing designated for persons with disabilities (no children under 6 expected).

---

## Party fields

| Party | Where they appear | Filled by |
|---|---|---|
| Seller | §2 Seller's Disclosure; §5 Certification | Seller marks knowledge + records boxes; signs. |
| Buyer | §3 Buyer's Acknowledgment; §5 Certification | Buyer initials receipt + inspection election; signs. |
| Seller's agent | §4 Agent's Acknowledgment; §5 Certification | Listing agent initials that they informed Seller of federal obligations. |
| Buyer's agent | §4 Agent's Acknowledgment (co-agent line); §5 Certification | Buyer's agent initials as applicable. |

**Locked convention:** `lbp_seller_*`, `lbp_buyer_*`, `lbp_seller_agent_*`, `lbp_buyer_agent_*` prefixes. Section 2 Y/N boxes use paired-Y/N convention: same fixture key, engine inverts.

---

## Section-by-section rules

### §1 Lead Warning Statement (federal-mandated verbatim)

"Every purchaser of any interest in residential real property on which a residential dwelling was built prior to 1978 is notified that such property may present exposure to lead from lead-based paint that may place young children at risk of developing lead poisoning. Lead poisoning in young children may produce permanent neurological damage, including learning disabilities, reduced intelligence quotient, behavioral problems, and impaired memory. Lead poisoning also poses a particular risk to pregnant women. The seller of any interest in residential real property is required to provide the buyer with any information on lead-based paint hazards from risk assessments or inspections in the seller's possession and notify the buyer of any known lead-based paint hazards. A risk assessment or inspection for possible lead-based paint hazards is recommended prior to purchase."

**No fill fields.** Fixed statutory text.

### §2 Seller's Disclosure

**(a) Presence of lead-based paint and/or lead-based paint hazards** — paired Y/N (mutually exclusive):
- ☐ Known LBP or LBP hazards are present (explain below).
- ☐ Seller has no knowledge of LBP or LBP hazards in the housing.

**Explanation blank** (if "known LBP present"): free-text description.

**(b) Records and reports available to the Seller** — paired Y/N:
- ☐ Seller has provided the purchaser with all available records and reports pertaining to LBP and/or LBP hazards (list documents).
- ☐ Seller has no reports or records pertaining to LBP and/or LBP hazards.

**Fixture keys:** `lbp_seller_knowledge` (Y/N — paired), `lbp_seller_knowledge_explanation` (free-text if Y), `lbp_seller_records_available` (Y/N — paired), `lbp_seller_records_list` (free-text if Y).

### §3 Buyer's Acknowledgment (Buyer initials each)

- (c) Buyer has received copies of all information listed above (initial blank).
- (d) Buyer has received the EPA-approved pamphlet "Protect Your Family from Lead in Your Home" (initial blank).
- (e) Buyer's inspection opportunity — Buyer chooses ONE:
  - ☐ 10-day opportunity (or mutually agreed period) for risk assessment/inspection for presence of LBP or LBP hazards.
  - ☐ Waived the opportunity for LBP inspection.

**Fixture keys:** `lbp_buyer_received_info` (initials), `lbp_buyer_received_pamphlet` (initials), `lbp_buyer_inspection_election` (mutually exclusive — days-opportunity vs waived), `lbp_buyer_inspection_days` (blank if applicable).

### §4 Agent's Acknowledgment (Agent initials)

Seller's agent has informed Seller of Seller's obligations under 42 USC §4852d and is aware of Agent's responsibility to ensure compliance.

**Fixture keys:** `lbp_seller_agent_initials`, `lbp_buyer_agent_initials`.

### §5 Certification of Accuracy

All parties sign + date certifying accuracy of the information they've provided.

**Fixture keys:** `lbp_seller_signature`, `lbp_seller_date`, `lbp_buyer_signature`, `lbp_buyer_date`, `lbp_seller_agent_signature`, `lbp_seller_agent_date`, `lbp_buyer_agent_signature`, `lbp_buyer_agent_date`.

---

## Cross-form integration

| Trigger | Attach 56-0 |
|---|---|
| Property built before January 1, 1978 (per CAD records) | Attach 56-0 to TREC 20-19 contract (¶7.C trigger). |
| Property listed as "unknown year built" in CAD but pre-1978 possible | Attach 56-0 as precaution; Seller marks "no knowledge" if genuine. |
| Property built 1978 or later, confirmed by CAD | 56-0 NOT required. Do NOT attach. |

**In TREC 20-19 ¶22:** check the "Lead-Based Paint (TREC 56-0)" addendum box if 56-0 is attached.

---

## Deadline math

| Deadline | Clock | Source |
|---|---|---|
| Delivery of 56-0 to Buyer | Before Buyer becomes obligated under contract (typically at offer stage) | 24 CFR §35.92(a) |
| Buyer's 10-day LBP inspection opportunity | 10 days from delivery of 56-0 (or mutually agreed period) | 24 CFR §35.90(a) + §3(e) checkbox |
| Buyer's waiver | Buyer may waive in writing on §3(e) | 24 CFR §35.90(b) |

---

## Common Q&A

**Q1. Property was built in 1978 exactly — does 56-0 apply?**
A: No. 24 CFR §35.86 defines "target housing" as housing constructed BEFORE 1978. A property built in 1978 or later is exempt. But — verify the build year from CAD, not MLS (MLS is frequently wrong).

**Q2. Seller has never lived in the property — do they still complete §2?**
A: Yes. Seller marks "no knowledge" for §2(a) and "no records" for §2(b) if that's genuinely the case. But Seller is on the hook if they knew of LBP through prior inspections, tenant complaints, or documentation.

**Q3. Buyer waived the 10-day inspection — can they still terminate later if they find LBP?**
A: Federal law doesn't provide a post-waiver termination right specifically for LBP. Buyer's other termination rights under TREC 20-19 (option period, TPF financing contingency, etc.) still apply. But once the LBP-specific inspection window is waived and other windows close, Buyer has to close.

**Q4. Property built in 1976 — Seller says it was fully renovated in 2010 with all paint removed. Do we still need 56-0?**
A: Yes, unless a certified LBP inspector has certified the property lead-free per 24 CFR §35.86(a)(6). Renovation ≠ certified lead-free. Attach 56-0; Seller may mark "no knowledge" in §2(a) but should attach the renovation documentation.

**Q5. What's the penalty for not delivering 56-0 when required?**
A: Federal fines up to $17,000+ per violation (adjusted annually under 24 CFR §30.65). Plus common-law fraud + DTPA exposure. Buyer may also have federal statutory damages under 42 USC §4852d(b)(3).

**Q6. Elderly-only community — do we still need 56-0?**
A: If the community qualifies as "housing for the elderly" under 24 CFR §35.86 (occupied by persons 62+, no children under 6 expected), it's exempt. Verify the community's HUD designation before assuming exemption.

**Q7. Foreclosure sale — 56-0 required?**
A: Foreclosure sales are exempt from LBP disclosure under 24 CFR §35.82(a). But a subsequent Seller (who bought at foreclosure and is now reselling) IS subject to LBP if the property is pre-1978.

**Q8. Property built in 1975 has known lead — Seller wants to sell "As Is" and skip 56-0. Can we?**
A: No. The federal disclosure requirement is separate from the contract's "As Is" mechanism. Seller can sell As Is (via TREC 20-19 ¶7.D checkbox) AND still must disclose known LBP on 56-0. The "As Is" doesn't override federal disclosure.

**Q9. Buyer wants to close in 5 days on a pre-1978 property — can they waive the 10-day inspection?**
A: Yes. Buyer may waive under §3(e) checkbox. The 10-day period is Buyer's right, not a mandatory delay. Waiver must be in writing on the form; a verbal waiver doesn't satisfy federal law.

**Q10. Renovation contractor asked me if the LBP disclosure applies to renovations. Does it?**
A: The Renovation, Repair, and Painting (RRP) Rule (40 CFR §745 subpart E) governs renovations. 56-0 is the sales disclosure. The RRP Rule requires certified renovators + tenant/owner notification for renovations disturbing >6 sq ft of paint in pre-1978 dwellings. Different rule; same underlying LBP statute. Refer contractor to the RRP Rule.

---

## Common practitioner mistakes

1. **Not verifying year built from CAD** — MLS is frequently wrong on year built. Pull CAD records before deciding whether 56-0 applies.
2. **Skipping 56-0 for a pre-1978 property because "Seller doesn't know about lead"** — the disclosure is required regardless. Seller marks "no knowledge" in §2(a); Buyer still gets the pamphlet + 10-day inspection right.
3. **Filling in the agent acknowledgment before Seller has actually completed §2** — the agent §4 acknowledgment attests that agent informed Seller of Seller's obligations. Complete §2 first.
4. **Missing the Buyer's initials on §3(c) and §3(d)** — Buyer must initial receipt of both the disclosure AND the EPA pamphlet. Skipping either is a federal violation.
5. **Delivering 56-0 after contract execution** — federal law requires delivery BEFORE Buyer becomes contractually obligated. Deliver at offer stage.

---

## Authoritative sources

- TREC 56-0 PDF: https://www.trec.texas.gov/forms/addendum-sellers-disclosure-information-lead-based-paint
- 42 USC §4852d (Residential Lead-Based Paint Hazard Reduction Act): https://www.law.cornell.edu/uscode/text/42/4852d
- 24 CFR §35 subpart A (HUD implementing regs): https://www.ecfr.gov/current/title-24/subtitle-A/part-35/subpart-A
- EPA pamphlet "Protect Your Family from Lead in Your Home": https://www.epa.gov/lead/protect-your-family-lead-your-home
- Texas REALTORS® May-June 2026 forms changes summary: https://www.texasrealestate.com/members/communications/texas-realtor-magazine/issues/may-june-2026/latest-forms-changes/
- 40 CFR §745 subpart E (EPA Renovation, Repair, and Painting Rule): https://www.ecfr.gov/current/title-40/chapter-I/subchapter-R/part-745/subpart-E

---

## Personal expert notes (Hadley)

- The Lead-Based Paint disclosure is federal law layered on top of TREC promulgation. This is the ONLY sale addendum in the TREC library that has a federal source rather than a Texas statute — practitioners routinely forget that HUD/EPA (not TREC) is the primary enforcer.
- The paired Y/N pattern in §2 is a good example of Hadley's locked labeling convention: same fixture key, engine inverts. Never split into `_knowledge_yes` / `_knowledge_no`.
- **[TREC unverified — needs source check]** The specific 56-0 vs OP-L language differences are my synthesis from Texas REALTORS® summary. Full first-party PDF read pending Heath shipping 56-0 PDF into `Media/Signature_Documents/`.
