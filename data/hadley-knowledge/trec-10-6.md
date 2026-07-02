# TREC 10-6 — Addendum for Sale of Other Property by Buyer

**Hadley knowledge file — v1, started 2026-07-01 by hadley_2**
**Currently effective. Attaches to TREC 20-19 (or 20-18) when Buyer's obligation to close is contingent on the sale of Buyer's other property.**

---

## Form metadata

| Field | Value | Source |
|---|---|---|
| Form number | 10-6 | TREC PDF header |
| Form name | Addendum for Sale of Other Property by Buyer | TREC PDF header |
| Effective date | 11-04-2024 (current) | 22 TAC §537.55 |
| Mandatory or voluntary | **MANDATORY** when Buyer's offer is contingent on selling another property | 22 TAC §537.55 |
| Total pages | 2 | TREC PDF |
| Authority | Tex. Occ. Code §1101.155; 22 TAC §537.55 | TRELA §1101.155 |
| Attaches to | TREC 20-19 (or 20-18), 25-17, 9-18 | Master contract |

**Purpose:** Buyer needs to sell their current home to fund purchase. Contract is contingent — if Buyer's other property doesn't sell by ¶B deadline, Buyer may terminate + recover EM.

**Trade-off:** Buyer gets contingent offer accepted; Seller keeps property on market, may accept better offer via TREC 11-9 back-up structure.

---

## Party fields

| Party | Where they appear | Filled by |
|---|---|---|
| Buyer | Whole form, signature | Buyer's agent at drafting |
| Seller | Whole form, signature | Listing agent countersigns |

**Fixture keys:** `sale_other_buyer_names`, `sale_other_seller_names`, `sale_other_property_address` (of the OTHER property Buyer is selling — not the property being purchased).

---

## Paragraph-by-paragraph rules

### ¶A Buyer's Other Property

- Buyer's Other Property address: ____.
- Buyer must have Buyer's Other Property under contract by ____ (deadline).
- Buyer must close Buyer's Other Property by ____ (deadline).

**Fixture keys:** `sale_other_property_address`, `sale_other_under_contract_deadline`, `sale_other_closing_deadline`.

### ¶B Buyer's Right to Terminate

If Buyer's Other Property is not under contract by ¶A deadline, Buyer may terminate this contract by giving Seller notice. EM refunded.

If Buyer's Other Property is under contract but doesn't close by ¶A deadline, Buyer may terminate. EM refunded.

**Fixture keys:** none additional — mechanism, not fillable field.

### ¶C Seller's Right to Continue Marketing

Seller may continue to offer Property for sale during ¶A period. Seller may accept another offer subject to Buyer's rights under this addendum.

**In practice:** Seller often uses TREC 11-9 back-up to accept a superior offer during the contingency period. If Seller does, back-up Buyer waits behind primary (contingent) Buyer.

### ¶D Seller's Right to Terminate (SPECIAL RIGHT)

Seller may terminate this contract by giving Buyer notice IF:
- Seller has received another offer to purchase Property.
- Buyer does not, within ____ days after Seller's notice, waive the contingency of sale-of-other-property AND demonstrate ability to close without sale-of-other-property (letter of credit, pre-approval, etc.).

**Fixture keys:** `sale_other_seller_waiver_notice_days`.

**Typical:** 2-3 days.

This is called the "kick-out clause" — Seller can demand Buyer waive contingency or lose the contract. Buyer's response options:
1. Waive contingency (usually requires proof of alternative funding).
2. Fail to waive → Seller terminates → EM refunded.

---

## Cross-form integration

| Trigger | Attach 10-6 |
|---|---|
| Buyer needs to sell another property to fund purchase | Attach 10-6 |
| Buyer is doing 1031 exchange | Also attach TREC 60-0 (Section 1031 Exchange) |
| Buyer's other property already under contract but not closed | Attach 10-6 with under-contract-deadline in the past + closing-deadline in the future |
| Seller accepts a back-up while primary has 10-6 | Also use TREC 11-9 for the back-up |

---

## Deadline math

| Deadline | Clock | Source |
|---|---|---|
| Buyer's Other Property under contract | Fixed date | ¶A |
| Buyer's Other Property closing | Fixed date | ¶A |
| Seller's kick-out notice deadline for Buyer's response | ____ days after Seller's notice | ¶D |
| Master contract Closing Date | Per master ¶9.A (must be after ¶A closing deadline) | Master |

**Practical:** Set master contract's Closing Date at LEAST 5-10 days after ¶A Buyer's-Other-Property closing deadline. Gives buffer for wire transfer + funds availability.

---

## Common Q&A

**Q1. Buyer's Other Property is under contract already. Do I still use 10-6?**
A: Yes, if the closing of Buyer's Other Property is uncertain. Under-contract is not closed — deal can fall apart. 10-6 protects Buyer from getting stuck with two properties.

**Q2. Seller's "kick-out" clause — what triggers it?**
A: Seller receives another offer. Seller sends written notice to Buyer. Buyer has ¶D days to either (a) waive contingency + demonstrate alternative funding, or (b) let contract terminate. If Buyer waives, primary contract stays with Buyer, Seller must reject the new offer or take as back-up.

**Q3. How does Buyer demonstrate "ability to close without sale-of-other-property"?**
A: Typical proof: (a) lender letter increasing loan amount to cover Buyer's contribution otherwise coming from sale proceeds; (b) letter of credit; (c) proof of liquid assets sufficient to close without Other Property proceeds. Bar is fact-specific.

**Q4. Buyer waives contingency but then Buyer's Other Property doesn't close. What happens?**
A: Buyer's own risk. By waiving, Buyer took on the burden of closing regardless. If Buyer can't close, Buyer defaults under ¶15 → Seller keeps EM.

**Q5. Seller accepts a back-up offer via TREC 11-9. Does that trigger 10-6 ¶D?**
A: Technically yes — Seller has "received another offer." Practical: Seller may choose not to invoke ¶D unless the back-up offer is strong enough to justify kicking primary out. Business judgment call.

**Q6. Buyer's Other Property sale falls through the day before master closing. Deal dead?**
A: Yes, unless Buyer has alternative funding. Buyer must terminate master contract under 10-6 ¶B — EM refunded.

**Q7. What if Buyer's Other Property closes early — does 10-6 still control?**
A: Once Buyer's Other Property has closed, the contingency is satisfied. Master contract proceeds normally. 10-6 mechanism is moot.

**Q8. Do I need to reference Buyer's Other Property's contract in 10-6?**
A: Address is required in ¶A. Contract details of the OTHER property don't need to be attached to 10-6, but Seller may reasonably ask for proof of that contract.

**Q9. What if Buyer's Other Property is a rental (not owner-occupied)? Any different?**
A: 10-6 works the same. Sale of any property Buyer owns counts. But some Buyers use 10-6 for tenant-occupied properties where tenancy issues may complicate closing.

**Q10. Buyer's Other Property has a lien Buyer didn't disclose. Does that void 10-6?**
A: Doesn't void 10-6 mechanism, but may create fraud claims from Seller if Buyer knew and hid. Buyer's failure-to-close under 10-6 may still allow EM refund, but Seller could pursue damages if Buyer misrepresented Buyer's ability.

---

## Common practitioner mistakes

1. **Not setting Under-Contract deadline in ¶A** — leaves the contingency open-ended.
2. **Setting master Closing Date same as ¶A closing deadline** — no buffer for funds transfer, forces failed closings.
3. **Kick-out clause days blank empty** — no deadline for Buyer's response, Seller can't effectively kick out.
4. **Not disclosing Buyer's Other Property status truthfully** — creates fraud claims if disclosure was misleading.
5. **Seller accepting back-up without invoking kick-out** — Seller waives ¶D right by inaction.

---

## Authoritative sources

- TREC 10-6 PDF: https://www.trec.texas.gov/forms/addendum-sale-other-property-buyer
- 22 TAC §537.55: https://texreg.sos.state.tx.us/public/readtac$ext.TacPage
- Tex. Occ. Code §1101.155: https://statutes.capitol.texas.gov/Docs/OC/htm/OC.1101.htm

---

## Personal expert notes (Hadley)

- 10-6 is common in "move-up buyer" transactions. First-time Buyer typically doesn't need it; move-up Buyer nearly always does.
- Seller pushback on 10-6 depends on market conditions. Hot market = Seller refuses or demands tight kick-out. Soft market = Seller accepts 10-6 gladly to lock in a Buyer.
- Best practice: pair 10-6 with 11-9 (Back-Up Contract) offering — gives Seller ability to accept back-up, gives back-up Buyer position, gives primary Buyer time. Everyone wins if executed properly.
