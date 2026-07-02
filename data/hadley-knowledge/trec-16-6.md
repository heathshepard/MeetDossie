# TREC 16-6 — Buyer's Temporary Residential Lease

**Hadley knowledge file — v1, started 2026-07-01 by hadley_2**
**Currently effective. Attaches to TREC 20-19 (or 20-18) when Buyer wants to occupy the property BEFORE closing.**

---

## Form metadata

| Field | Value | Source |
|---|---|---|
| Form number | 16-6 | TREC PDF header |
| Form name | Buyer's Temporary Residential Lease | TREC PDF header |
| Effective date | 11-04-2024 (current) | 22 TAC §537.55 |
| Mandatory or voluntary | **MANDATORY** when Buyer occupying pre-closing | 22 TAC §537.55 |
| Total pages | 2 | TREC PDF |
| Authority | Tex. Occ. Code §1101.155; 22 TAC §537.55; Tex. Prop. Code Ch. 92 | TRELA §1101.155 |
| Used with | TREC 20-19 (or 20-18) when Buyer occupies pre-closing | Master contract ¶10.A |
| Companion form | TREC 15-6 (Seller's Temporary Residential Lease) — for post-closing Seller stay | Companion |

**Purpose:** Buyer occupies Seller's property BEFORE closing. Buyer is Tenant, Seller is Landlord. When closing happens, lease terminates automatically + Buyer becomes owner.

**Term limitation:** Practical ceiling ~90 days. Pre-closing occupancy longer than that suggests deal problems + full lease should be used.

**Common triggers:** Buyer's rental lease ended before closing; Buyer relocating from out of state; Buyer needs to occupy for logistics.

---

## Party fields

| Party | Where they appear | Filled by |
|---|---|---|
| Landlord (Seller under contract) | Whole form, signature | Listing agent at drafting |
| Tenant (Buyer under contract) | Whole form, signature | Buyer's agent at drafting |

**Party mapping:** Seller = Landlord (they still own the property). Buyer = Tenant (they occupy but don't own yet).

**Fixture keys:** `temp_lease_landlord_names` (= master contract's seller_names), `temp_lease_tenant_names` (= master contract's buyer_names), `temp_lease_property_address`.

---

## Paragraph-by-paragraph rules

### ¶1 PARTIES

Landlord (Seller under contract) leases Property to Tenant (Buyer under contract). Names must match master contract exactly.

### ¶2 PROPERTY

Property address.

### ¶3 TERM

Term begins ____ (specific date, typically before closing) and ends automatically upon closing and funding of the sale under the master contract.

If closing doesn't happen (buyer defaults, contract terminates), lease terminates on ____ (specific date, typically closing date + short grace).

**Fixture keys:** `temp_lease_term_start_date`, `temp_lease_backup_end_date`.

**Critical:** Lease AUTO-TERMINATES at closing (Tenant becomes owner). But if closing doesn't happen, need a fallback termination — otherwise Tenant is in indefinite occupation of Seller's property.

### ¶4 RENT

- **4.A** Daily rent: $____ per day.
- **4.B** Rent due at ¶3 term start (or as agreed).

**Fixture keys:** `temp_lease_daily_rent`, `temp_lease_prepaid_rent`.

**Standard practice:** Buyer typically pays PITI/365 approximation — Seller's daily carrying cost.

### ¶5 DEPOSIT

Security deposit: $____ at lease start. Held by Landlord (Seller).

**Fixture keys:** `temp_lease_deposit_amount`.

**Practical note:** If closing happens as planned, deposit is refunded (or credited toward closing costs). If closing doesn't happen, deposit covers damages.

### ¶6 UTILITIES

Tenant pays for utilities during the term. Tenant should transfer utilities into Tenant's name before occupancy.

### ¶7 USE

Residential purposes only.

### ¶8 PETS

Paired Y/N checkbox; describe if Y.

**Fixture keys:** `temp_lease_pets_allowed` (paired Y/N), `temp_lease_pets_description` (free-text if Y).

### ¶9 MAINTENANCE

- Landlord (Seller): major maintenance during term.
- Tenant (Buyer): ordinary care + minor repairs.

**Practical tension:** Buyer is about to own the Property + may want to make improvements. ¶10 (Alterations) says no — alterations wait until after closing.

### ¶10 ALTERATIONS

Tenant may NOT alter Property (no painting, no fixtures added/removed, no landscaping changes).

Rationale: If closing doesn't happen, Seller wouldn't want a property that's been renovated by not-yet-owner Buyer.

### ¶11 INSURANCE

- Landlord (Seller): maintains hazard insurance.
- Tenant (Buyer): should maintain renter's insurance.

**Critical:** Buyer's about-to-be-effective homeowner's insurance policy doesn't kick in until closing. During lease term, Buyer needs renter's insurance for personal property.

### ¶12 CASUALTY LOSS

If Property damaged during term: Landlord may terminate lease. Also implicates master contract ¶14 (Casualty Loss provision).

**Practical impact:** if property is damaged pre-closing while Buyer is occupying, both the sale AND the lease may fall apart. Very messy scenario. Insurance carriers get involved.

### ¶13 DEFAULT

- Tenant default: Landlord may terminate lease + evict.
- Landlord default: Tenant may terminate + recover deposit.

**Interaction with master contract:** Tenant default under lease may also constitute Buyer default under master contract → Seller keeps EM per ¶15.

### ¶14 SURRENDER

If closing doesn't happen: Tenant vacates on ¶3 backup end date. Delivers keys, cleans.

### ¶15-17

Notices, attorney advisory, signatures.

---

## Cross-form integration

| Trigger | Attach 16-6 |
|---|---|
| Master contract ¶10.A "according to a temporary residential lease" AND Buyer occupying pre-closing | Attach 16-6 |
| Seller staying post-closing | Use TREC 15-6 (Seller's Temporary Residential Lease) instead |
| Buyer wants long pre-closing occupancy (>90 days) | Reconsider deal structure; use full lease if needed |

---

## Deadline math

| Deadline | Clock | Source |
|---|---|---|
| Term start | Specific date | ¶3 |
| Term auto-end | Closing + funding | ¶3 |
| Fallback term end | Specific date (if closing doesn't happen) | ¶3 |
| Deposit refund | Within 30 days of Tenant vacate + forwarding address (§92.103) | Statutory |

---

## Common Q&A

**Q1. Buyer wants to move in 15 days before closing — reasonable?**
A: Yes, common. Draft 16-6 with term start = date of Buyer's move-in; term end = automatic at closing. Set daily rent = Seller's carrying cost. Both parties sign.

**Q2. What if closing gets delayed?**
A: Lease continues until closing OR until ¶3 fallback date, whichever earlier. If financing is delayed, amend both the master contract (via TREC 39-11) AND the lease (extend ¶3 fallback date via written amendment).

**Q3. What if Buyer's loan falls through and closing never happens?**
A: Lease terminates on ¶3 fallback date. Buyer must vacate. Deposit refunded minus damages. Master contract also terminates per 40-11 ¶2.B (assuming Buyer used TPF). EM disposition depends on default provisions.

**Q4. Buyer's move-in date got pushed. Can we amend?**
A: Yes. Written amendment signed by both parties. Adjust ¶3 term start.

**Q5. Buyer painted a room during term. Alterations violation?**
A: Yes. ¶10 prohibits. If Buyer closes, no harm. If Buyer doesn't close, Seller may deduct repaint cost from deposit.

**Q6. Buyer's kid damages the house before closing. Whose insurance pays?**
A: Depends on damage scope + policy terms. Seller's homeowner's insurance covers structure; Tenant's renter's insurance covers personal + liability. Insurance disputes can be complicated by "occupied by non-owner" status. Coordinate before Tenant moves in.

**Q7. Utilities — Buyer transferred them to Buyer's name pre-closing. Any issue?**
A: No — that's expected. Buyer pays utilities during term. Just make sure both parties know the transfer date.

**Q8. Master contract has Option Period still running. Can Buyer still terminate?**
A: Yes. Option period termination rights survive 16-6. But: if Buyer terminates AFTER moving in, Buyer must vacate immediately + may face damage/rent disputes. Practical: don't move in until AFTER option period ends.

**Q9. Seller wants to enter Property during term. Right to enter?**
A: Landlord-tenant rules: 24-hour notice + reasonable purpose. Not free access. Especially awkward when the entering party is the former occupant.

**Q10. Buyer's occupancy is technically before closing — does that create tax issues?**
A: For federal tax homestead / homeowner deduction, ownership date controls (closing date). Rent paid pre-closing is not deductible as mortgage interest. Consult tax advisor.

---

## Common practitioner mistakes

1. **Buyer occupies without 16-6** — creates ambiguous relationship + no rent + no deposit + no formal Tenant status. Nightmare if closing falls through.
2. **Confusing 15-6 with 16-6** — 15-6 = Seller stays post-closing; 16-6 = Buyer occupies pre-closing.
3. **No fallback end date in ¶3** — if closing doesn't happen, Tenant has indefinite occupancy.
4. **No renter's insurance for Buyer/Tenant** — Buyer's personal property has no coverage during term.
5. **Alteration violations** — Buyer treats it like "already my house" and makes changes.

---

## Authoritative sources

- TREC 16-6 PDF: https://www.trec.texas.gov/forms/buyers-temporary-residential-lease
- 22 TAC §537.55: https://texreg.sos.state.tx.us/public/readtac$ext.TacPage
- Tex. Prop. Code Ch. 92 (Residential Tenancies): https://statutes.capitol.texas.gov/Docs/PR/htm/PR.92.htm

---

## Personal expert notes (Hadley)

- Pre-closing occupancy is a red flag for practitioners. It creates dual legal-status issues: Buyer is Tenant + prospective Owner + possible insurance disputes.
- If Buyer wants pre-closing occupancy for logistics, best practice: minimize duration (7-15 days), formalize with 16-6, require renter's insurance, prohibit alterations.
- 16-6 term is auto-terminating at closing — that's the key feature. Most disputes happen when closing gets delayed or fails.
