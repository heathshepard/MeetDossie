# TREC 15-6 — Seller's Temporary Residential Lease

**Hadley knowledge file — v1, started 2026-07-01 by hadley_2**
**Currently effective. Attaches to TREC 20-19 (or 20-18) when Seller wants to stay in the property AFTER closing for a short period (typically 1-90 days).**

---

## Form metadata

| Field | Value | Source |
|---|---|---|
| Form number | 15-6 | TREC PDF header |
| Form name | Seller's Temporary Residential Lease | TREC PDF header |
| Effective date | 11-04-2024 (current) | 22 TAC §537.55 |
| Mandatory or voluntary | **MANDATORY** when Seller staying post-closing (temp possession) | 22 TAC §537.55 |
| Total pages | 2 | TREC PDF |
| Authority | Tex. Occ. Code §1101.155; 22 TAC §537.55; Tex. Prop. Code Ch. 92 (residential tenancies) | TRELA §1101.155 |
| Used with | TREC 20-19 (or 20-18) when ¶10.A "according to a temporary residential lease" checked | Master contract ¶10.A |
| Companion form | TREC 16-6 (Buyer's Temporary Residential Lease) — for pre-closing Buyer occupancy | Companion |

**Purpose:** Formalizes Seller's landlord-tenant relationship with new-owner Buyer for the days Seller stays after closing. Governs rent, utilities, security deposit, damage liability.

**Term limitation:** 15-6 is designed for SHORT stays — typically up to 90 days. Longer stays should use a full residential lease (TXR 2001 or similar). TREC's implicit ceiling is 90 days; beyond that, form is not appropriate.

---

## Party fields

| Party | Where they appear | Filled by |
|---|---|---|
| Landlord (formerly Buyer, now new owner) | Whole form, signature | Buyer's agent at drafting |
| Tenant (formerly Seller, now temp tenant) | Whole form, signature | Listing agent facilitates |

**IMPORTANT:** Party roles FLIP at closing. The contract's "Buyer" becomes the "Landlord" of 15-6. The contract's "Seller" becomes the "Tenant."

**Fixture keys:** `temp_lease_landlord_names` (= master contract's buyer_names), `temp_lease_tenant_names` (= master contract's seller_names), `temp_lease_property_address`.

---

## Paragraph-by-paragraph rules

### ¶1 PARTIES

Landlord (Buyer under contract) leases Property to Tenant (Seller under contract). Names must match master contract exactly.

### ¶2 PROPERTY

Property address (same as master contract).

### ¶3 TERM

Term begins upon closing and funding of the sale and ends ____ (specific date) OR ____ days after closing.

**Fixture keys:** `temp_lease_term_end_date`, `temp_lease_term_days_after_closing`.

**Locked convention:** typically use specific date; days-after-closing is fallback if closing date is uncertain.

### ¶4 RENT

- **4.A** Rental amount: $____ per day.
- **4.B** Rent is due and payable at closing OR $____ due at closing + $____ per day thereafter.
- **4.C** Total rent for term = daily rent × days.

**Fixture keys:** `temp_lease_daily_rent`, `temp_lease_rent_due_at_closing`, `temp_lease_total_rent`.

**Standard practice:** rent typically set at PITI/365 (Landlord's daily cost of ownership) — so Tenant reimburses Landlord's carrying cost. But no legal requirement — negotiable.

### ¶5 DEPOSIT

Security deposit: $____ due at closing. Held by Landlord. Refundable after Tenant vacates, minus damages.

**Fixture keys:** `temp_lease_deposit_amount`.

### ¶6 UTILITIES

Tenant pays for utilities during the term. Specific utilities: gas, electric, water, sewer, trash, phone, internet, cable — Tenant pays.

**No fillable fields.** Fixed language.

### ¶7 USE

Tenant may use Property only for residential purposes. No commercial use.

**No fillable fields.**

### ¶8 PETS

Whether Tenant is allowed to keep pets: paired checkbox Y/N. If Y, describe.

**Fixture keys:** `temp_lease_pets_allowed` (paired Y/N), `temp_lease_pets_description` (free-text).

### ¶9 MAINTENANCE

- Landlord responsible for major maintenance.
- Tenant responsible for ordinary care + minor repairs.
- Tenant must notify Landlord of any needed major repairs within 24 hours.

**No fillable fields.**

### ¶10 ALTERATIONS

Tenant may not alter Property (no painting, no fixtures added/removed).

**No fillable fields.**

### ¶11 INSURANCE

- Landlord maintains hazard insurance on the Property.
- Tenant maintains renter's insurance for Tenant's personal property.

**No fillable fields.**

### ¶12 CASUALTY LOSS

If Property is materially damaged during term: Landlord may terminate lease. Tenant vacates within 3 days.

### ¶13 DEFAULT

- Tenant default: failure to pay rent, unauthorized use, etc. Landlord may terminate lease + evict per Tex. Prop. Code Ch. 24 (forcible entry and detainer).
- Landlord default: failure to permit possession. Tenant may terminate + recover deposit.

### ¶14 SURRENDER

Tenant vacates on last day of term, delivers keys, cleans Property, returns keys.

### ¶15 NOTICES

Notices to Landlord + Tenant at addresses specified. (Typically same as ¶21 of master contract.)

### ¶16 CONSULT AN ATTORNEY

Boilerplate advisory.

### ¶17 SIGNATURES

Landlord + Tenant sign + date.

---

## Cross-form integration

| Trigger | Attach 15-6 |
|---|---|
| Master contract ¶10.A "according to a temporary residential lease" AND Seller staying post-closing | Attach 15-6 |
| Buyer occupying pre-closing | Use TREC 16-6 (Buyer's Temporary Residential Lease) instead |
| Term >90 days | Use a full residential lease (TXR 2001) instead of 15-6 |

---

## Deadline math

15-6 is a term-based lease. Deadlines are within the lease itself.

| Deadline | Clock | Source |
|---|---|---|
| Term ends | Specific date OR days after closing | ¶3 |
| Tenant vacates | Last day of term | ¶14 |
| Deposit refund | Within 30 days of Tenant vacate (Tex. Prop. Code §92.103) | Statutory |

---

## Common Q&A

**Q1. How long can Seller stay under 15-6?**
A: Up to 90 days is TREC's practical ceiling. Beyond 90 days, use a full lease (TXR 2001). Extended stays under 15-6 create statutory complications (§92 tenant rights kick in more strongly at 90+ days).

**Q2. What's the daily rent?**
A: Negotiable. Common formula: Landlord's monthly carrying cost (P + I + T + I) / 30. E.g., $2,400 monthly cost = $80/day. Or a nominal figure like $50/day for a short 5-day stay.

**Q3. Who pays utilities?**
A: Tenant (Seller). ¶6 is fixed. Practically: Landlord (Buyer) will need to transfer utilities into their name at closing, but Tenant pays Landlord for utilities used during term (via receipts + reimbursement) or utilities stay in Seller's name for lease term.

**Q4. Seller's kids break a window during temp stay. Deposit forfeit?**
A: Yes, minus wear and tear. Damage caused by Tenant/Tenant's family is deducted from deposit per Tex. Prop. Code §92.104.

**Q5. Seller wants to extend past the ¶3 term. How?**
A: Amend the lease. Draft a written amendment signed by both parties. Do NOT rely on verbal agreement — after temp lease term ends, Tenant becomes a tenant-at-sufferance under §24, and eviction procedures apply.

**Q6. Landlord (Buyer) wants to enter the Property during term. Can they?**
A: Per landlord-tenant rules, Landlord may enter only with reasonable notice + for lawful purposes. Best practice: 24-hour notice + reasonable time.

**Q7. Seller refuses to vacate on last day. What now?**
A: Landlord (Buyer) initiates eviction under Tex. Prop. Code Ch. 24 (forcible detainer). File in Justice Court. Typical process: 6-10 days notice, then court order, then constable executes. In practice, ex-Seller usually vacates when confronted with eviction paperwork.

**Q8. Deposit refund timeline?**
A: Landlord must refund deposit (minus itemized deductions) within 30 days of Tenant vacate + Tenant providing forwarding address (Tex. Prop. Code §92.103). Failure = liability for deposit + $100 + 3x wrongfully-withheld amount + attorney's fees.

**Q9. Homeowner's insurance during temp lease — Landlord's policy still cover?**
A: Landlord's homeowner's policy covers the STRUCTURE. Tenant's renter's insurance (recommended in ¶11) covers Tenant's personal property. Coordinate with insurer — some policies exclude "landlord" coverage if occupied by non-owner.

**Q10. Buyer's lender approved a purchase, not a rental. Does temp lease affect financing?**
A: For short temp leases (typically ≤60 days), most lenders don't object. Longer stays may violate lender's owner-occupied requirement. Check with lender BEFORE agreeing to a long temp lease.

---

## Common practitioner mistakes

1. **Not attaching 15-6 when Seller stays post-closing** — creates ambiguous landlord-tenant relationship + statutory §92 complications.
2. **Setting daily rent at $0** — creates "gratuitous licensee" ambiguity. Set some rent, even $1/day, to preserve tenant classification.
3. **Confusing 15-6 with 16-6** — 15-6 = Seller stays post-closing. 16-6 = Buyer occupies pre-closing.
4. **Extending term verbally** — Statute of Frauds. Extension must be written.
5. **Not addressing pets** — ¶8 checkbox often overlooked; leads to pet-damage disputes.

---

## Authoritative sources

- TREC 15-6 PDF: https://www.trec.texas.gov/forms/sellers-temporary-residential-lease
- 22 TAC §537.55: https://texreg.sos.state.tx.us/public/readtac$ext.TacPage
- Tex. Prop. Code Ch. 92 (Residential Tenancies): https://statutes.capitol.texas.gov/Docs/PR/htm/PR.92.htm
- Tex. Prop. Code §92.103 (Deposit Refund): https://statutes.capitol.texas.gov/Docs/PR/htm/PR.92.htm#92.103
- Tex. Prop. Code Ch. 24 (Forcible Entry and Detainer): https://statutes.capitol.texas.gov/Docs/PR/htm/PR.24.htm

---

## Personal expert notes (Hadley)

- 15-6 is a HIGH-DISPUTE form in practice. Sellers routinely overstay; Buyers routinely fail to formalize; both parties routinely mishandle deposit.
- Best practice: set term at specific date, not days-after-closing. Practical clarity for both parties.
- If Seller wants "just a few extra days," push for 15-6 anyway — verbal agreements post-closing become nightmares when Seller doesn't vacate.
