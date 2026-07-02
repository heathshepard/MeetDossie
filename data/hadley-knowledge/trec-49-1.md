# TREC 49-1 — Addendum Concerning Right to Terminate Due to Lender's Appraisal

**Hadley knowledge file — v1, started 2026-07-01 by hadley_2**
**Currently effective. Attaches to TREC 20-19 (or 20-18 pre-July-1) whenever Buyer wants a right to terminate if lender's appraisal comes in below sales price.**

---

## Form metadata

| Field | Value | Source |
|---|---|---|
| Form number | 49-1 | TREC PDF header |
| Form name | Addendum Concerning Right to Terminate Due to Lender's Appraisal | TREC PDF header |
| Effective date | 11-04-2024 (mandatory for use when attached) | 22 TAC §537.55 |
| Mandatory or voluntary | Voluntary attachment; if attached, mandatory form | 22 TAC §537.55 |
| Total pages | 2 | TREC PDF |
| Authority | Tex. Occ. Code §1101.155; 22 TAC §537.55 | TRELA §1101.155 |
| Attaches to | TREC 20-19 (or 20-18), 25-17 (farm & ranch), 9-18 (unimproved), when Buyer has TPF (40-11) | Master contract + 40-11 |

**Purpose:** If lender's appraisal comes in below sales price, Buyer may terminate the contract and recover EM — subject to the specific mechanism chosen in ¶1.

---

## Party fields

| Party | Where they appear | Filled by |
|---|---|---|
| Buyer | Whole form, signature | Buyer's agent at drafting |
| Seller | Signature | Listing agent countersigns |

**Fixture keys:** reuse `buyer_names`, `seller_names`. Appraisal-specific keys prefixed `appraisal_`.

---

## Paragraph-by-paragraph rules

### ¶1 APPRAISAL TERMINATION RIGHT

Check ONE of two mechanisms:

**Waiver of Right to Terminate (option 1)** — Buyer WAIVES the right to terminate under this addendum. Buyer takes appraisal risk. Rare in practice.

**Partial Waiver (option 2)** — Buyer has right to terminate if Opinion of Value in appraisal is less than $____.

Or the more common structure:

**Additional Right to Terminate** — Buyer may terminate if lender's Opinion of Value is less than the Sales Price by MORE than $____ (or by more than ____% — form allows either). Buyer must give notice + provide a copy of the appraisal.

**Fixture keys:** `appraisal_termination_mechanism` (N-way N-way), `appraisal_min_value` or `appraisal_gap_threshold_dollars` or `appraisal_gap_threshold_percent`.

### ¶2 DEADLINE

Buyer must give notice of termination WITHIN ____ days after Buyer receives the appraisal from lender.

Typical: 3-5 days.

**Fixture keys:** `appraisal_termination_days`.

### ¶3 REFUND

On timely termination under this addendum, EM refunded to Buyer.

**No fillable fields.**

### ¶4 EXTENSION OF CLOSING (if appraisal delayed)

If lender has not delivered appraisal by ____ days before Closing Date, Buyer + Seller may agree to extend Closing Date. Unilateral extension NOT available under this form (requires amendment via TREC 39-11).

---

## Cross-form integration

| Trigger | Attach 49-1 |
|---|---|
| Buyer is using third-party financing (40-11 attached) | Strongly recommend attaching 49-1 |
| Buyer paying all cash | 49-1 NOT applicable (no lender = no lender appraisal) |
| Buyer is using seller financing (26-8) | 49-1 typically NOT applicable |

**Note:** 49-1 is Buyer-protective. Sellers may resist attaching it because it gives Buyer another escape route. In hot markets, 49-1 becomes a negotiating point.

---

## Deadline math

| Deadline | Clock | Source |
|---|---|---|
| Lender delivers appraisal to Buyer | Depends on lender workflow — typically 15-25 days after Effective Date | Lender workflow, not contract |
| Buyer's termination window | ____ days after receipt of appraisal | ¶2 blank |
| Deadline to give notice | Typically 3-5 days after appraisal receipt | Common practice |

**Practical example:** Effective Date 6/1. Lender delivers appraisal 6/20. Buyer has 3 days = must give termination notice by 6/23 (if using 49-1 with 3-day blank).

---

## Common Q&A

**Q1. Appraisal comes in at $290K on a $300K contract. Buyer has 49-1 with $5K threshold. Can Buyer terminate?**
A: Yes. Gap is $10K, exceeds $5K threshold. Buyer must give written notice within ¶2 days + include copy of appraisal.

**Q2. Appraisal comes in exactly at $295K on $300K contract, 49-1 has $5K threshold. Termination?**
A: Depends on whether threshold is "more than $5K" or "$5K or more." 49-1 uses "more than," so a $5K gap = no termination right. Buyer would need $5,001+ gap.

**Q3. Buyer wants to keep contract alive but renegotiate down to appraisal. How?**
A: TREC 39-11 Amendment reducing sales price to appraisal value + updated loan amount. Both parties sign. 49-1 termination right is preserved but not exercised.

**Q4. What if Seller wants to lower price to save the deal?**
A: Seller may propose an amendment. Buyer isn't obligated to accept — Buyer can still terminate under 49-1 if they prefer to walk. Practical negotiation.

**Q5. Appraisal delivered late — after 49-1 clock would have expired based on Effective Date.**
A: 49-1 clock runs from receipt of appraisal, NOT from Effective Date. Late appraisal = late clock start. Buyer still has ¶2 days from actual receipt to terminate.

**Q6. Lender's appraisal came in below value but Buyer's independent appraisal came in higher. Which controls?**
A: Lender's appraisal controls for 49-1 purposes. Lender won't lend at more than lender's appraisal. Buyer's independent appraisal is Buyer's business.

**Q7. Buyer never got the appraisal because lender delayed. Deal past Closing Date. Now what?**
A: If Closing Date has passed without extension, contract may be in default under ¶15. Buyer's right to terminate under 49-1 requires appraisal receipt — if never received, 49-1 doesn't help. Options: extend closing via TREC 39-11 Amendment, or exercise other termination rights.

**Q8. What's the difference between 49-1 and 40-11 ¶2.B termination?**
A: 40-11 ¶2.B = failure to obtain Buyer Approval OR Property Approval. Requires denial letter. 49-1 = specifically for appraisal value gap. 49-1 fills a gap where 40-11 wouldn't necessarily fire (e.g., loan approved on other terms but at reduced amount due to appraisal).

**Q9. If Buyer terminates under 49-1, is EM refunded?**
A: Yes. ¶3 explicitly refunds EM on timely termination.

**Q10. Threshold amount — what should Buyer set?**
A: Typical: $5K on a $300K deal (1.5-2%). Higher = Buyer eats appraisal gap. Lower = Buyer very protected. In a hot market Sellers may push threshold higher; in a soft market Buyers get lower thresholds.

---

## Common practitioner mistakes

1. **Not attaching 49-1 when 40-11 is attached** — TPF w/o appraisal protection is a known-gap. Most Buyer's agents attach both by default.
2. **Threshold set too high** — a $50K threshold on $300K deal essentially waives the protection.
3. **Missing ¶2 days deadline** — Buyer must act quickly after appraisal receipt.
4. **Notice without appraisal copy** — ¶1 requires copy of appraisal to accompany notice. Notice alone insufficient.
5. **Confusing 49-1 with 40-11 ¶2.B** — different mechanisms, both apply, use whichever is cleanest.

---

## Authoritative sources

- TREC 49-1 PDF: https://www.trec.texas.gov/forms/addendum-concerning-right-terminate-due-lenders-appraisal
- 22 TAC §537.55: https://texreg.sos.state.tx.us/public/readtac$ext.TacPage
- Tex. Occ. Code §1101.155: https://statutes.capitol.texas.gov/Docs/OC/htm/OC.1101.htm

---

## Personal expert notes (Hadley)

- 49-1 was TREC's response to the 2021-2022 hot market where Buyers were routinely getting appraisals below sales price. It's now standard-attach for any financed deal.
- The gap threshold is the practical negotiation point. Best practice: Buyer's agent proposes $2-5K threshold; Seller's agent may counter to $10-15K.
- Do NOT confuse 49-1's mechanism with 40-11 ¶2.B. 49-1 fires SPECIFICALLY on appraisal gap; 40-11 ¶2.B fires on Buyer/Property approval failure more broadly.
