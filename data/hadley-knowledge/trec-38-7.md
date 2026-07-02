# TREC 38-7 — Notice of Buyer's Termination of Contract

**Hadley knowledge file — v1, started 2026-07-01 by hadley_2**
**Currently effective. Used by Buyer to give notice of termination of a TREC contract under a specific paragraph right.**

---

## Form metadata

| Field | Value | Source |
|---|---|---|
| Form number | 38-7 | TREC PDF header |
| Form name | Notice of Buyer's Termination of Contract | TREC PDF header |
| Effective date | 11-04-2024 (current) | 22 TAC §537.41 |
| Mandatory or voluntary | **MANDATORY** when Buyer exercises a termination right | 22 TAC §537.41 |
| Total pages | 1 | TREC PDF |
| Authority | Tex. Occ. Code §1101.155; 22 TAC §537.41 | TRELA §1101.155 |
| Used with | TREC 20-19 (or 20-18), 25-17, 9-18, 24-20, 23-20, 30-19 — any executed TREC contract | Master contract |

**Purpose:** Formalizes Buyer's termination notice. Contract-terminating decisions must be in writing to be enforceable — 38-7 provides the standard template.

---

## Party fields

| Party | Where they appear | Filled by |
|---|---|---|
| Buyer | Whole form, signature | Buyer, with agent facilitating |
| Seller | Named as recipient | Referenced by name; Seller does NOT sign 38-7 |

**Fixture keys:** `termination_buyer_names`, `termination_seller_names`, `termination_property_address`, `termination_effective_date_of_contract`.

---

## Paragraph-by-paragraph rules

### Header — Reference to underlying contract

- Property address.
- Effective Date of underlying contract.
- Names of Buyer + Seller.

### §1 Basis for Termination (check ONE)

**Buyer terminates the contract pursuant to:**

- ☐ (a) Termination Option under ¶5.B of contract (option period termination)
- ☐ (b) Third Party Financing Addendum ¶2.B (financing termination)
- ☐ (c) TREC 49-1 Addendum Concerning Right to Terminate Due to Lender's Appraisal (appraisal termination)
- ☐ (d) TREC 10-6 Addendum for Sale of Other Property by Buyer (sale-of-other-property termination)
- ☐ (e) TREC 36-11 Addendum for POA (POA/SI termination)
- ☐ (f) TREC 25-17 Farm & Ranch Contract termination (environmental / due diligence)
- ☐ (g) ¶6.D of contract (title objection termination)
- ☐ (h) Seller's failure to provide Seller's Disclosure Notice under Prop Code §5.008
- ☐ (i) Other (describe) ____.

**Fixture keys:** `termination_basis` (N-way mutually exclusive), `termination_basis_other_description` (free-text if (i)).

### §2 Signature

Buyer's signature + date.

Delivery to Seller: at Seller's ¶21 notice address in the master contract. Timing must comply with the applicable paragraph's deadline (e.g., 5:00 p.m. local for ¶5.B option termination).

**Fixture keys:** `termination_buyer_signature`, `termination_buyer_date`.

---

## Cross-form integration

| Trigger | Attach appraisal or 49-1 | Deliver 38-7 within |
|---|---|---|
| Buyer terminates under ¶5.B option | — | Before 5:00 p.m. local on last day of option period |
| Buyer terminates under 40-11 ¶2.B financing | Copy of lender denial letter | Same as 40-11 ¶2.A/2.B deadline |
| Buyer terminates under 49-1 appraisal | Copy of appraisal | ¶2 of 49-1 (typically 3-5 days after appraisal receipt) |
| Buyer terminates under 10-6 sale-of-other-property | — | Per 10-6 deadline |
| Buyer terminates under 36-11 POA/SI | — | ¶C of 36-11 (typically 3-5 days after SI receipt) |
| Buyer terminates under ¶6.D title objections | — | Master contract ¶6.D (after Seller's cure period expires) |
| Buyer terminates under Prop Code §5.008 (missing SDN) | — | 7 days after Buyer discovers SDN missing OR after receipt |

---

## Deadline math

38-7 has no independent deadline. Delivery timing must comply with the applicable paragraph's clock.

**Critical:** Time is of the essence (¶5.E of master contract). Late delivery = termination is invalid; Buyer has no termination right; may be in default.

**5:00 p.m. rule:** ¶5.B option period termination must be delivered by 5:00 p.m. LOCAL TIME (where property is located) on the last day of the option period. NOT sender's local time.

**Legal-Holiday extension:** Under ¶5.A(2) of 20-19 (2025-new), if the last day falls on Saturday/Sunday/legal holiday, extended to next business day.

---

## Common Q&A

**Q1. Buyer terminates during option period — do we need 38-7?**
A: Yes. Termination must be in writing. 38-7 is the standard form. Verbal termination during option period does not effectuate termination — Buyer must deliver written notice.

**Q2. Buyer's option period ends today. Can we deliver 38-7 by email?**
A: Yes, if Seller's ¶21 notice designated an email address. Delivery is effective when Seller receives (email hitting Seller's inbox is receipt). Deliver by 5:00 p.m. local time.

**Q3. Buyer wants to terminate under 40-11 ¶2.B but doesn't have lender denial letter yet. Notice alone enough?**
A: No. 40-11 ¶2.B requires BOTH written notice AND lender denial letter. Deliver 38-7 with denial letter attached, or termination is invalid.

**Q4. Buyer changed their mind mid-option-period. Can they withdraw a 38-7 they already sent?**
A: If Seller has already received the 38-7, termination is effective and cannot be unilaterally rescinded. Parties could sign a new contract or reinstate via a TREC 39-11 Amendment (with Seller's consent).

**Q5. Buyer wants to terminate under "Other" (¶1(i)). What should they write?**
A: Describe the specific paragraph and basis. Example: "Special Provision ¶11 states Seller shall provide roof inspection within 10 days; Seller failed to provide by 6/15. Buyer terminates under Special Provision default." Be specific.

**Q6. Buyer terminates. Who gets the EM?**
A: Depends on the termination basis. Termination during option period (¶5.B) = EM refunded to Buyer (option fee is NOT refunded). Termination under 40-11 ¶2.B, 49-1, 36-11 = EM refunded. Improper termination = Seller may keep EM under ¶15 default.

**Q7. Buyer terminates but escrow won't release EM to Buyer. How?**
A: Escrow requires signed release from Seller (or court order). Deliver 38-7 to escrow with a request for release. If Seller disputes, ¶18.C of master contract governs: Seller has 15 days to object; if no objection, escrow releases.

**Q8. Property built in 1900, Seller never delivered SDN. Buyer wants to terminate. How?**
A: ¶1(h) — Seller's failure to provide SDN under Prop Code §5.008. Deliver 38-7 within 7 days of Buyer's discovery of non-delivery. EM refunded per §5.008(f).

**Q9. Multiple termination bases apply — check multiple boxes?**
A: Yes if genuinely applicable. But best practice: check the strongest / cleanest one to avoid muddying the analysis. Multiple bases = defense against Seller's argument that one basis was defective.

**Q10. Buyer's agent should sign the 38-7?**
A: No. 38-7 is Buyer's action. Buyer signs. Agent may facilitate + deliver but does not sign on Buyer's behalf.

---

## Common practitioner mistakes

1. **Missing 5:00 p.m. local deadline on option termination** — delivered at 5:15 p.m. = void, Buyer forfeits.
2. **Not including denial letter with 40-11 termination** — termination invalid without required document.
3. **Delivering to wrong address** — must go to Seller's ¶21 designated notice address, not Seller's home or Seller's agent (unless ¶21 designates Seller's agent).
4. **Verbal termination** — Statute of Frauds. Must be in writing.
5. **Not identifying underlying contract's Effective Date** — 38-7 header must reference specific contract.

---

## Authoritative sources

- TREC 38-7 PDF: https://www.trec.texas.gov/forms/notice-buyers-termination-contract
- 22 TAC §537.41: https://texreg.sos.state.tx.us/public/readtac$ext.TacPage
- Tex. Prop. Code §5.008(f) (7-day SDN termination right): https://statutes.capitol.texas.gov/Docs/PR/htm/PR.5.htm#5.008
- Tex. Bus. & Com. Code §26.01 (Statute of Frauds — writing requirement): https://statutes.capitol.texas.gov/Docs/BC/htm/BC.26.htm#26.01

---

## Personal expert notes (Hadley)

- 38-7 is the highest-stakes single-page form in Texas RE. A day-late 38-7 costs Buyer their EM + potentially triggers specific performance. Practitioners MUST use calendar alerts.
- The 5:00 p.m. local time rule is jurisdictional-timezone-specific. San Antonio property = 5:00 p.m. CST/CDT. Buyer in Hawaii mailing termination via UPS = must arrive by 5:00 p.m. San Antonio time.
- Best practice: deliver 38-7 by email AND certified mail. Email = timestamped receipt. Certified mail = fallback if email disputed.
