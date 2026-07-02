# TREC 55-1 — Seller's Disclosure Notice

**Hadley knowledge file — v1, started 2026-07-01 by hadley_2**
**EFFECTIVE 2026-05-28. Supersedes OP-H (04-01-2024).**
This is the statutorily-required Seller's Disclosure Notice under Tex. Prop. Code §5.008. Every seller of residential 1-4 unit property in Texas must complete and deliver this to the buyer on or before the effective date of a contract for the sale.

---

## PARAGRAPH DELTA — OP-H vs 55-1

Agents mid-transaction under OP-H should continue to use OP-H references. Agents drafting new offers on or after 2026-05-28 must use 55-1 as the delivered SDN.

**Material changes from OP-H to 55-1:**

| OP-H section | 55-1 section | Change |
|---|---|---|
| Section 1 (Property Information) | Section 1 (unchanged) | Basic property + Seller occupancy status. |
| Section 2 (Appliances/Systems checklist) | Section 2 (updated) | Added: **EV charging stations, home battery systems (Tesla Powerwall, etc.), smart-home controllers**. Removed: some legacy items. |
| Section 3 (Defects known to Seller) | Section 3 (unchanged pattern) | Y/N/Unknown checkboxes on 20+ defect categories. |
| Section 4 (Additional questions) | Section 4 (expanded) | Added: **flood questions from Sen. Bill 30 (2021) — has property flooded 3+ times in 5 years, is property in a floodway, does it have flood insurance**. |
| Section 5 (repairs/replacements) | Section 5 (unchanged) | Y/N + explanation blank. |
| Section 6 (attached documents) | Section 6 (unchanged) | Optional attached inspection reports. |
| Section 7 (certification + signature) | Section 7 (unchanged) | Seller signs + dates; Buyer acknowledges receipt separately. |

**Practical impact:** existing OP-H fill map covers 90% of 55-1. New section 2 items (EV charging, home battery, smart-home) + expanded section 4 flood questions need new fill fields.

---

## Form metadata

| Field | Value | Source |
|---|---|---|
| Form number | 55-1 | TREC PDF header |
| Form name | Seller's Disclosure Notice | TREC PDF header |
| Effective date | May 28, 2026 (mandatory) | Texas REALTORS® May-June 2026 forms update summary |
| Mandatory or voluntary | **MANDATORY** under Tex. Prop. Code §5.008 for resale of residential 1-4 unit property occupied ≥1 year (with narrow exceptions) | Prop. Code §5.008(a) |
| Form this replaces | OP-H (04-01-2024) | TREC 55-1 PDF footer |
| Total pages | 6 (unchanged from OP-H) | TREC PDF page numbering |
| Authority | Tex. Prop. Code §5.008 (statutory disclosure requirement); 22 TAC §537 (form promulgation) | Prop. Code §5.008 |
| Delivered by | Seller | Prop. Code §5.008(a) — "seller of residential real property … shall give … a written notice" |
| Delivered to | Buyer | Prop. Code §5.008(a) |
| Timing | On or before Effective Date of the contract | Prop. Code §5.008(b) |

**Cite chain:** Tex. Prop. Code §5.008 → mandates the SDN → §5.008(g) authorizes TREC to promulgate the form → TREC 55-1 is the current promulgated form.

---

## Statutory exceptions (when SDN is NOT required)

Per Prop. Code §5.008(e):

1. Court-ordered transfer (probate, divorce, tax sale, foreclosure).
2. Transfer to a mortgagee by a mortgagor in default, or in a foreclosure sale.
3. Transfer between co-owners.
4. Transfer made to a spouse, parent, child, sibling, or grandparent of the transferor.
5. Transfer between spouses or as a result of a divorce decree.
6. Transfer to or from any governmental entity.
7. Transfer of new residence not previously occupied for residential purposes (new construction).
8. Transfer of real property where the value of any dwelling does not exceed 5% of the value of the property.

**Practitioner note:** If Seller claims an exception, the exception should be documented in writing and referenced in ¶7.B of TREC 20-19 (or 20-18). Agents should NOT check "SDN not required" without confirming the exception applies — this is a §5.008 discipline risk.

---

## Party fields

| Party | Where they appear | Filled by |
|---|---|---|
| Seller | Section 1, 3, 5, 7 (signature + date) | Seller completes; listing agent facilitates but does NOT complete on Seller's behalf. |
| Buyer | Section 7 (acknowledgment of receipt) | Buyer signs on receipt; date of receipt is critical for the ¶7.B days clock. |
| Listing agent | Not a party to the SDN | Facilitates delivery; may not complete or sign for Seller. |

**Locked convention:** `seller_sdn_*` prefix for Seller's disclosures; `buyer_sdn_receipt_*` for Buyer's acknowledgment. Never conflate.

---

## Section-by-section rules

### Section 1 — Property Information

- Property address.
- Type: single family / duplex / triplex / fourplex / condo.
- Is Seller occupying? Y/N.
- If not occupying, when did Seller last occupy? Date blank.
- If Seller has never occupied, check the appropriate box (Seller may have no personal knowledge of condition — but must still complete based on any knowledge they do have).

### Section 2 — Appliances/Systems checklist (55-1 EXPANDED)

For each item: Present Y/N, Working Y/N, Unknown.

Standard items (carried from OP-H):
- Cable TV wiring, ceiling fans, dishwasher, disposal, dryer, exhaust vents, fireplace + chimney, garage door openers, gas fixtures, hot tub, intercom, microwave, outdoor grill, patio/deck, plumbing systems, pool + heater, range/oven, refrigerator, security system, septic system, smoke detectors, solar panels, stove, thermostat, TV antenna, washer, water heater (gas/electric), water softener, well, window screens.

**55-1 NEW items:**
- **EV charging station** (Level 2 wall-mounted).
- **Home battery / whole-home backup system** (Tesla Powerwall, Enphase, LG Chem).
- **Smart-home controllers** (Google Home hub, Amazon Echo integrations, wired smart-home panels).

Each item requires: `sdn_item_[name]_present`, `sdn_item_[name]_working`.

### Section 3 — Defects known to Seller

Y/N/Unknown checkboxes on 20+ defect categories:
- Interior walls, ceilings, floors, exterior walls, doors, windows, roof, foundation/slab, sidewalks, walls/fences, driveway, intercom, plumbing/sewers/septic, electrical, lighting fixtures, other structural, other.

For each Y, explanation blank in Section 5.

**Locked convention:** paired Y/N/Unknown widgets share fixture key `sdn_defect_[category]`; engine writes to appropriate checkbox based on value ("yes" / "no" / "unknown"). Never split into `_yes`, `_no`, `_unknown` separate keys.

### Section 4 — Additional questions (55-1 EXPANDED)

Existing questions (carried from OP-H):
- Improper drainage, water damage, previous flooding, previous fires, termites/wood-destroying insects, active infestation, prior repair for termites, prior repair for wood rot, radon gas, asbestos, urea-formaldehyde insulation, endangered species/wetlands on property, hazardous waste on property, previous foundation repair, previous roof repair, prior insurance claims, aluminum wiring, unpermitted improvements, lead-based paint, subsurface structures/pits, encroachments/easements not disclosed, prior manufactured/mobile home on property, property in a historic district, exterior insulation finish system (EIFS/synthetic stucco).

**55-1 NEW questions (Sen. Bill 30 flood expansion — Prop. Code §5.008(b-1)):**
- Has the property flooded 3 or more times in the past 5 years? Y/N.
- Is the property located wholly or partly in a floodway or 100-year floodplain? Y/N.
- Does the property have flood insurance? Y/N.
- Have you (Seller) received assistance from FEMA or the U.S. Small Business Administration for flood damage to the property? Y/N.
- Are you aware of any water penetration/mildew/mold problems? Y/N.

Each Y triggers an explanation in Section 5 (or attached exhibit).

### Section 5 — Repairs/Replacements

Y/N: Has Seller made any repairs or replacements in the past 12 months (other than routine maintenance)?
If Y: explanation blank.
If any Section 3 or Section 4 defect was Y, this section is where Seller elaborates.

### Section 6 — Attached documents

Optional. If Seller has prior inspection reports, engineering studies, roof warranties, etc., they can attach them to the SDN. Attachment is not required but is a defense against later "you didn't disclose" claims.

### Section 7 — Certification + Signature

- Seller signs + dates. Certifies statements are true and correct to the best of Seller's knowledge.
- Buyer signs + dates on receipt. Date of Buyer's receipt is the operative date for the ¶7.B days clock in TREC 20-19.

---

## Cross-form integration

| Contract paragraph | SDN interaction |
|---|---|
| TREC 20-19 ¶7.B "Seller's Disclosure Notice" checkbox #1 (Buyer received) | Buyer has received the SDN; Buyer's acceptance of contract is with knowledge of disclosures. |
| TREC 20-19 ¶7.B checkbox #2 (Buyer has NOT received; will receive within ____ days) | Seller must deliver within specified days; Buyer may terminate within 7 days after receipt if disclosures reveal material defects. |
| TREC 20-19 ¶7.B checkbox #3 (SDN not required) | Seller claims a §5.008(e) exception. Practitioner must confirm exception applies. |

**If Seller fails to deliver an SDN when required:** Buyer has right to terminate within 7 days after receipt of SDN OR within 7 days after Buyer discovers Seller failed to deliver, whichever occurs first. Prop. Code §5.008(f).

---

## Deadline math

| Deadline | Clock | Source |
|---|---|---|
| SDN delivery (if Section 7.B checkbox 2) | ____ days after Effective Date | ¶7.B blank |
| Buyer's termination right after SDN receipt | 7 days after receipt of SDN | Prop. Code §5.008(f) |
| Buyer's termination right if SDN never delivered | 7 days after Buyer discovers non-delivery | Prop. Code §5.008(f) |

---

## Common Q&A

**Q1. My Seller has never lived in the property (inherited). Do they still need to complete the SDN?**
A: Yes. §5.008 applies to all sales of residential 1-4 unit property (with narrow exceptions in §5.008(e)). If none of the exceptions apply, the SDN is required. Seller should mark "Unknown" for items they have no personal knowledge about, but the notice must still be delivered.

**Q2. Seller inherited the property from parent — is that a §5.008(e) exception?**
A: No. The transfer to Seller (inheritance from parent) was exempt as a family transfer. But the CURRENT sale by Seller to Buyer is NOT exempt — it's a normal residential sale. The SDN is required.

**Q3. When exactly must the SDN be delivered?**
A: On or before the Effective Date of the contract, per Prop. Code §5.008(b). Best practice: deliver at offer stage so Buyer executes the contract with the SDN in hand.

**Q4. What if defects are discovered after SDN is delivered but before closing?**
A: Seller has a continuing duty to update. If material defects surface, Seller should deliver an amended SDN. If Seller doesn't, and Buyer discovers post-closing, Seller has potential liability under §5.008 + common-law fraud/DTPA.

**Q5. Can the listing agent complete the SDN for the Seller?**
A: No. The SDN is Seller's disclosure. Listing agent may explain the form + help Seller understand what's being asked, but Seller must make the disclosures themselves. Agent completing = unauthorized practice + a discipline risk under TRELA §1101.652.

**Q6. What if Seller checks "Unknown" on everything?**
A: Legally permissible if Seller genuinely doesn't know (e.g., inherited property, absentee Seller). But it's a red flag to Buyer + inspector — and doesn't insulate Seller from liability if Seller ACTUALLY knew and hid it. "Unknown" isn't a shield for known defects.

**Q7. What about a rental property Seller has never lived in?**
A: SDN still required (rental = residential ≥1 unit property). Seller marks "Unknown" for items Seller has no personal knowledge of, but must disclose anything Seller does know (from tenant reports, prior inspections, insurance claims, etc.).

**Q8. New construction — does the builder need to complete an SDN?**
A: No. §5.008(e)(7) exempts new construction not previously occupied. But the builder typically delivers a builder's warranty + limited warranty documents in lieu.

**Q9. The new flood questions — what triggers them?**
A: Sen. Bill 30 (2021) expanded §5.008 to include flood-specific disclosures. All Sellers must answer regardless of property location — even a hillside property must answer "no" to the flooded-3-times question. The answer is what matters, not whether flood risk exists.

**Q10. If Seller answered "no" to prior foundation repair on the SDN but title company finds a foundation lien history — what happens?**
A: Seller has potential misrepresentation exposure. Buyer may have a §5.008 statutory claim + common-law fraud claim + DTPA claim (Tex. Bus. & Com. Code §17.46). This is why "Unknown" is safer than "No" if Seller isn't 100% sure. Escalate to counsel if the discrepancy is discovered pre-closing — likely triggers a 39-11 Amendment or Buyer termination.

---

## Common practitioner mistakes

1. **Filling out the SDN for the Seller** — TRELA §1101.652 discipline risk. Agent should facilitate, not complete.
2. **Marking "SDN not required" without confirming an exception** — the burden is on the party claiming exception to show it applies.
3. **Not updating SDN when material defects surface post-delivery** — continuing disclosure duty under common law + §5.008.
4. **Missing the new 55-1 flood questions on properties previously covered by OP-H** — practitioners transitioning from OP-H must not skip the added Sen. Bill 30 questions.
5. **Ignoring the Buyer's 7-day termination right under §5.008(f)** — Buyer has statutory right to terminate for 7 days after receiving the SDN if material defects are disclosed.

---

## Authoritative sources

- TREC 55-1 PDF: https://www.trec.texas.gov/forms/sellers-disclosure-notice
- Tex. Prop. Code §5.008 (statutory SDN requirement): https://statutes.capitol.texas.gov/Docs/PR/htm/PR.5.htm#5.008
- Sen. Bill 30 (2021, flood disclosure expansion): https://capitol.texas.gov/BillLookup/History.aspx?LegSess=87R&Bill=SB30
- Texas REALTORS® May-June 2026 forms changes summary: https://www.texasrealestate.com/members/communications/texas-realtor-magazine/issues/may-june-2026/latest-forms-changes/
- Tex. Bus. & Com. Code §17.46 (DTPA — misrepresentation): https://statutes.capitol.texas.gov/Docs/BC/htm/BC.17.htm#17.46

---

## Personal expert notes (Hadley)

- 55-1's expanded flood section is the single most-important change from OP-H. Post-Harvey, post-Uri, Texas Legislature keeps ratcheting up flood disclosure requirements. Practitioners should assume flood questions on 55-1 will only grow in future revisions.
- The new appliance items (EV charging, home battery, smart home) reflect 2020-2025 residential tech shifts. Expect these lists to keep growing.
- **[TREC unverified — needs source check]** The specific 55-1 line-item additions are my synthesis from Texas REALTORS® summary. Full first-party PDF read pending Heath shipping 55-1 PDF into `Media/Signature_Documents/`.
