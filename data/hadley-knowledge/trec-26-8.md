# TREC 26-8 — Seller Financing Addendum

**Hadley knowledge file — v1, started 2026-07-01 by hadley_2**
**Currently effective. Attaches to TREC 20-19 (or 20-18) when Seller is providing financing for the sale (Seller-carry).**

---

## Form metadata

| Field | Value | Source |
|---|---|---|
| Form number | 26-8 | TREC PDF header |
| Form name | Seller Financing Addendum | TREC PDF header |
| Effective date | 11-04-2024 (current) | 22 TAC §537.32 |
| Mandatory or voluntary | **MANDATORY** when ¶3.B "Seller Financing" checkbox in master contract is checked | 22 TAC §537.32 |
| Total pages | 2 | TREC PDF |
| Authority | Tex. Occ. Code §1101.155; 22 TAC §537.32; Tex. Prop. Code Ch. 5 (Deeds of Trust); Tex. Fin. Code Ch. 302 (Interest Rates) | TRELA §1101.155 |
| Attaches to | TREC 20-19 (or 20-18), 25-17, 9-18 | Master contract ¶3.B "Seller Financing" checked |
| SAFE Act consideration | If Seller regularly finances (>5 loans/year), Seller may need to be a licensed mortgage loan originator (Tex. Fin. Code §180) | Check Seller volume |

---

## Party fields

| Party | Where they appear | Filled by |
|---|---|---|
| Buyer | Whole form, signature | Buyer's agent at drafting |
| Seller | Whole form, signature | Listing agent at drafting |

**Fixture keys:** `sf_buyer_names`, `sf_seller_names`, `sf_property_address`.

---

## Paragraph-by-paragraph rules

### ¶A CREDIT DOCUMENTATION

Buyer must deliver credit documentation to Seller within ____ days after Effective Date:
- Credit report.
- Verification of employment.
- Verification of funds.

Seller has ____ days after receipt to notify Buyer if credit is unacceptable. If unacceptable, Buyer may:
- Terminate contract + EM refunded, OR
- Cure by providing additional information.

**Fixture keys:** `sf_credit_docs_delivery_days`, `sf_seller_review_days`.

**Typical:** 7-14 days for delivery; 5-7 days for Seller review.

### ¶B PROMISSORY NOTE

Terms of Buyer's promissory note to Seller:
- Loan Amount: $____ (typically the ¶3.B financing portion).
- Interest Rate: ____% per annum.
- Amortization: monthly payments over ____ years (typical: 15-30).
- First Payment Date: ____ (typical: 30 days after closing).
- Balloon Payment: ☐ Yes / ☐ No. If yes, balloon date + amount.
- Prepayment Penalty: ☐ Yes / ☐ No.

**Fixture keys:** `sf_loan_amount`, `sf_interest_rate`, `sf_amortization_years`, `sf_first_payment_date`, `sf_balloon` (paired Y/N), `sf_balloon_date`, `sf_balloon_amount`, `sf_prepayment_penalty` (paired Y/N).

### ¶C DEED OF TRUST

Note secured by Deed of Trust on Property. Standard Texas Deed of Trust terms. Buyer covenants:
- Maintain insurance.
- Pay property taxes.
- Maintain Property in good condition.
- No further encumbrance without Seller's consent.

**Fixture keys:** none additional (fixed template).

### ¶D TAX AND INSURANCE ESCROW

☐ Buyer will escrow taxes + insurance with Seller (monthly installment).
☐ Buyer will NOT escrow (Buyer pays directly, provides proof to Seller annually).

**Fixture keys:** `sf_tax_insurance_escrow` (paired Y/N).

### ¶E DUE ON SALE / TRANSFER

Note becomes due upon Buyer's transfer of Property to third party (Buyer cannot resell + assign the note without Seller's consent).

### ¶F DEFAULT

Buyer default: failure to pay note per terms → Seller may accelerate + foreclose under Deed of Trust (non-judicial foreclosure under Tex. Prop. Code §51.002).

Seller default: rare (Seller has already conveyed Property + is receiving payments).

### ¶G TITLE INSURANCE

Buyer obtains Owner's Title Policy at closing (Buyer's expense unless otherwise agreed in ¶6.A of master contract).

Loan Title Policy for Seller-lender: recommended but not required. Cost = Seller's expense typically.

### ¶H SUBORDINATION

If Buyer later obtains a first-lien loan to refinance Seller-financing, Seller's note subordinates to new first lien. Buyer typically pays refinancing costs.

**Practical:** Seller-financing is often intended as bridge financing; Buyer expects to refinance with a bank within 2-5 years.

---

## Cross-form integration

| Trigger | Attach 26-8 |
|---|---|
| ¶3.B "Seller Financing" checkbox in master contract | Attach 26-8 |
| Buyer is doing Seller-carry ONLY for a portion (owner + third-party lender) | Attach BOTH 40-11 (for third-party portion) AND 26-8 (for Seller portion). Master contract ¶3.B may check both boxes. |
| Seller wants Buyer's spouse to co-sign note | Draft in ¶H free-text or separate rider |

---

## Deadline math

| Deadline | Clock | Source |
|---|---|---|
| Buyer delivers credit docs to Seller | ____ days after Effective Date | ¶A |
| Seller review of credit | ____ days after receipt | ¶A |
| Buyer cure period (if credit rejected) | Immediate — Buyer either cures or terminates | ¶A |
| First loan payment | ____ (typically 30 days after closing) | ¶B |
| Balloon due (if applicable) | ____ (typically 3-5 years after closing) | ¶B |

---

## Common Q&A

**Q1. Seller financing — is this legal in Texas?**
A: Yes, generally. But if Seller regularly finances (>5 loans/year), Seller may need to be a licensed Residential Mortgage Loan Originator (RMLO) under Tex. Fin. Code §180. One-off Seller-financing to fund a specific sale = usually exempt.

**Q2. Interest rate cap under Texas usury law?**
A: For consumer transactions (residential 1-4 family for Buyer's personal use): 10% legal cap OR contract rate up to the "weekly ceiling" (published by TX Consumer Credit Commissioner, typically 12-18%). Currently (2026), weekly ceiling ≈ 18%. Above ceiling = usury (Tex. Fin. Code Ch. 302, 303).

**Q3. Balloon payment — legal?**
A: Yes. Common structure: 30-year amortization with 5-7 year balloon. Buyer refinances at balloon date. Higher default risk if Buyer can't refinance.

**Q4. What if Buyer defaults on the note?**
A: Seller accelerates (calls entire balance due) → non-judicial foreclosure under Tex. Prop. Code §51.002. Takes ~35-60 days from default to foreclosure sale. Property reverts to Seller if no third-party bid at foreclosure.

**Q5. Buyer's credit report shows some issues. Seller wants to reject. Can they?**
A: Under ¶A. If Seller reasonably determines credit unacceptable, notify Buyer within review days. Buyer may cure (provide more info) or terminate (EM refunded).

**Q6. Buyer wants to transfer Property to a family member. Due-on-sale trigger?**
A: Yes, per ¶E — any transfer triggers due-on-sale. Seller may consent (common for family transfers), or accelerate note. Case-by-case negotiation.

**Q7. Seller wants Buyer's spouse to guarantee. How?**
A: Draft in special provisions or attach a personal guaranty (drafted by attorney). Not a standard 26-8 field — this is an area where practitioners should refer to legal counsel.

**Q8. Buyer wants to refinance out of seller-financing after 3 years. Prepayment penalty apply?**
A: Depends on ¶B checkbox. If prepayment penalty = Yes, terms in note govern. If No, Buyer can refinance without penalty. Most Seller-financing has no prepayment penalty.

**Q9. Texas SAFE Act / RMLO licensing — does Seller need it?**
A: Seller-financing exemption under Tex. Fin. Code §180.003: if Seller finances ≤5 loans per calendar year AND is not in the business of residential mortgage lending, exemption applies. Above 5 = RMLO license required. Practical: escalate to counsel if Seller does this repeatedly.

**Q10. Buyer pays late — how does Seller handle?**
A: Note should have late-payment provisions (grace period, late fee, default trigger). Standard Tex. Prop. Code §51 default + acceleration + foreclosure process applies. Judicial foreclosure also available.

---

## Common practitioner mistakes

1. **Rate above usury ceiling** — voidable + penalties + Seller may forfeit interest.
2. **Missing Deed of Trust** — Seller's note is unsecured without recorded Deed of Trust. Practitioners must ensure title company records Deed of Trust at closing.
3. **No credit documentation review** — Seller takes credit risk blindly; ¶A protection wasted.
4. **Prepayment penalty on consumer transactions** — may violate consumer-protection laws for owner-occupied residential.
5. **Seller doing multiple Seller-financing without RMLO** — potential SAFE Act violation.

---

## Authoritative sources

- TREC 26-8 PDF: https://www.trec.texas.gov/forms/seller-financing-addendum
- 22 TAC §537.32: https://texreg.sos.state.tx.us/public/readtac$ext.TacPage
- Tex. Fin. Code Ch. 180 (SAFE Act — RMLO Licensing): https://statutes.capitol.texas.gov/Docs/FI/htm/FI.180.htm
- Tex. Fin. Code Ch. 302 (Interest Rates and Usury): https://statutes.capitol.texas.gov/Docs/FI/htm/FI.302.htm
- Tex. Prop. Code §51 (Deeds of Trust; Foreclosure): https://statutes.capitol.texas.gov/Docs/PR/htm/PR.51.htm

---

## Personal expert notes (Hadley)

- Seller financing is <5% of Texas residential deals. Rare form. Practitioners handling their first one should escalate to counsel — the SAFE Act + usury + Deed of Trust structure has real legal complexity.
- Practical tips: use title company + Seller's attorney to draft the actual note + Deed of Trust; 26-8 is just the addendum stating the deal points. The note itself is a separate legal instrument.
- Balloon structures are common but require Buyer to have a refinance path. Failed refi = foreclosure. Advise Buyer of the risk clearly.
