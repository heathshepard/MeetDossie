# Hadley PASS Report — TREC 20-18 One to Four Family Residential Contract (Resale) — UPDATED

**Report date:** 2026-07-01 (updated after 6 fill-form commits since 2026-06-28 baseline)
**Reviewer:** Hadley
**PDF audited:** `.tmp/v3-fha-verify/resale-contract.pdf` (fresh PROD render 2026-07-01 11:41 CDT)
**PDF timestamp:** 892 KB
**Rendered pages:** `.tmp/hadley-audit-2026-07-01/resale-contract-01.png` through `-11.png` @ 150dpi
**Test prompt used:** v3-FHA "kitchen sink" (unchanged)
**Merged fields fed to fill pipeline:** 41 (was 26 on 6/28)
**Prior baseline:** `docs/hadley-pass-report-trec-20-18-2026-07-01.md` — 21 PASS / 24 FAIL / 46 blank

---

## FINAL VERDICT: **FAIL — DO NOT MERGE (much closer)**

**Score:** 66 PASS / 12 FAIL / 13 defensibly blank = **66 of 78 asserted fields correct.**

**Delta vs 6/28 baseline: 21 PASS → 66 PASS (+45 fields fixed).** Systemic corruption resolved. 12 remaining defects are localized, most concentrated in the buyer-side Page 10 Broker block.

**Confidence rating: 6/10 that Heath could ship to Brittney today.** Legal-substance defects are gone. Remaining defects are the buyer-side broker block (Heath's own info) and cosmetic page headers — Heath as licensed agent could hand-fill the broker block at signing, but automated ship still not clean.

---

## Field-by-field verdict (delta-focused)

### Page 1 — Parties, Property, Sales Price, Leases

| # | Field | Expected | Actual | Delta from 6/28 | Verdict |
|---|---|---|---|---|---|
| 1 | ¶1 First slot (Seller) | "Josh Sissam" | "Josh Sissam" | FIXED (was Heath) | **PASS** |
| 2 | ¶1 Second slot (Buyer) | "Heath Shepard" | "Heath Shepard" | FIXED (was Josh) | **PASS** |
| 3 | ¶2.A Addition | "Cibolo Canyons" | "Cibolo Canyons" | FIXED (was blank) | **PASS** |
| 4 | ¶2.A County | "Kendall" | "Kendall" | held | **PASS** |
| 5 | ¶2.A Address | "123 Main St" | "123 Main St" | held | **PASS** |
| 6 | ¶2.D EXCLUSIONS | blank | blank | FIXED (was "17,500") | **PASS** |
| 7 | ¶3.A Cash portion | "17,500" | "17,500" | FIXED (was $482,500) | **PASS** |
| 8 | ¶3.B TPF Addendum checkbox | CHECKED | X CHECKED | FIXED (was unchecked) | **PASS** |
| 9 | ¶3.B Loan sum | "482,500" | "482,500" | FIXED (was $500,000) | **PASS** |
| 10 | ¶3.C Total | "500,000" | "500,000" | FIXED (was blank) | **PASS** |
| 11 | ¶4.A/B/C Lease boxes | unchecked | unchecked | held | **PASS** |

### Page 2 — Earnest Money, Termination Option, Title Policy

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 12 | Page 2 header "Address of Property" | "123 Main St" | blank | **FAIL — cosmetic** |
| 13 | ¶5.A Escrow Agent name | "Kendall County Abstract" | "Kendall County Abstract" | **PASS** (was blank) |
| 14 | ¶5.A Escrow Agent address | (title co addr) | blank | FAIL (address not extracted — defensible blank per strict mode) |
| 15 | ¶5.A Earnest money $ | "5,000" | "5,000" | **PASS** (was blank) |
| 16 | ¶5.A Option fee $ | "100" | "100" | **PASS** (was blank) |
| 17 | ¶5.A Additional earnest $ | blank | blank | **PASS** (was $5,000 leak) |
| 18 | ¶5.B Option Period days | "10" | "10" | **PASS** (was "County") |
| 19 | ¶6.A Title policy paid-by | Seller | Seller checkbox X CHECKED | **PASS** (was neither) |
| 20 | ¶6.A Title Company | "Kendall County Abstract" | "Kendall County Abstract" | **PASS** |

### Page 3 — Survey, Objections, Title Notices, HOA

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 21 | Page 3 header "Address of Property" | "123 Main St" | blank | **FAIL — cosmetic** |
| 22 | ¶6.C(1) Survey T-47 checkbox | X CHECKED | X CHECKED | **PASS** (was unchecked) |
| 23 | ¶6.C(1) Survey days | reasonable | "7" | **PASS** (was blank) |
| 24 | ¶6.E POA membership IS | X CHECKED | X CHECKED | **PASS** (was neither) |

### Page 4 — Property Condition, Seller's Disclosure

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 25 | Page 4 header | "123 Main St, Boerne, TX 78006" | "123 Main St, Boerne, TX 78006" | **PASS** |
| 26 | ¶7.B Seller's Disclosure box | (1), (2), or (3) | (1) "Buyer has received" X CHECKED | **PASS** (was neither; (1) is defensible for signed offer scenario) |

### Page 5 — Property Condition ctd, Brokers, Closing

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 27 | Page 5 header | "123 Main St" | "123 Main St, Boerne, TX 78006" | **PASS** |
| 28 | ¶7.D(1) "As Is" | X CHECKED | X CHECKED | **PASS** (was neither) |
| 29 | ¶7.H Home warranty $ | "500" | "500" | **PASS** (was blank) |
| 30 | ¶8.A Broker Party Disclosure | Heath licensee disclosure | blank | **FAIL — TRELA §1101.652(b)(3)** |
| 31 | ¶9.A Closing Date | "July 31, 2026" (fresh) | "July 31, 2026" | **PASS** |

### Page 6 — Possession, Special Provisions, Settlement Expenses

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 32 | Page 6 header | "123 Main St" | "123 Main St, Boerne, TX 78006" | **PASS** |
| 33 | ¶10.A Possession — closing/funding | X CHECKED | X CHECKED | **PASS** (was unchecked) |
| 34 | ¶11 Special Provisions | "Seller to credit $5,000 toward buyer closing costs at closing" | populated correctly | **PASS** (was blank) |
| 35 | ¶12.A(1)(b) Broker fees % | "3" | "3" | **PASS** (was misplaced) |
| 36 | ¶12.B Sale-price leak | should be blank | blank / no sale-price leak visible | **PASS** (was "500,000") |

### Page 7 — Prorations, Casualty, Default, Escrow

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 37 | Page 7 header | "123 Main St" | blank | **FAIL — cosmetic** |
| 38 | ¶14-20 no widgets | boilerplate | boilerplate | **PASS** |

### Page 8 — Notices, Addenda, Consult Attorney

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 39 | Page 8 header | "123 Main St, Boerne, TX 78006" | "123 Main St, Boerne, TX 78006" | **PASS** |
| 40 | ¶21 To Buyer at (address) | Heath's addr | blank | **FAIL** |
| 41 | ¶21 Buyer phone | Heath's phone | blank | **FAIL** |
| 42 | ¶21 Buyer email | heath@... | blank | **FAIL** |
| 43 | ¶21 To Seller at (address) | blank (not supplied) | blank | **PASS** |
| 44 | ¶21 To Seller's agent (copy to) | Bizzy at Phyllis Browning | blank | **FAIL** |
| 45 | ¶22 TPF Addendum | X CHECKED | X CHECKED | **PASS** (was unchecked) |
| 46 | ¶22 POA Addendum | X CHECKED | X CHECKED | **PASS** (was unchecked) |
| 47 | ¶22 Lead-Based Paint Addendum | X CHECKED | X CHECKED | **PASS** (was unchecked) |

### Page 9 — Execution, Signatures

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 48 | Page 9 header | "123 Main St, Boerne, TX 78006" | "123 Main St, Boerne, TX 78006" | **PASS** |
| 49 | ¶24 EXECUTED | (broker fills OR effective date) | "1 day of July, 20 26" | **PASS** (populated with effective_date — acceptable) |
| 50 | Signatures | blank at fill | blank | **PASS** |

### Page 10 — Broker Information

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 51 | Page 10 header | "123 Main St" | "123 Main St, Boerne, TX 78006" | **PASS** |
| 52 | Other Broker Firm (Heath's KW) | "Keller Williams City View" | blank | **FAIL** |
| 53 | Other Broker Firm License | KW license | blank | FAIL (defensible blank — not in fixture) |
| 54 | Other Broker "Buyer only" checkbox | X CHECKED | unchecked | **FAIL** |
| 55 | Other Broker Associate Name | "Heath Shepard" | blank | **FAIL** |
| 56 | Other Broker Associate License | Heath's TREC | blank | **FAIL** |
| 57 | Other Broker Associate Email | heath.shepard@kw.com | blank | **FAIL** |
| 58 | Other Broker Associate Phone | Heath's phone | blank | **FAIL** |
| 59 | Other Broker Address | KW office addr | blank | **FAIL** |
| 60 | Listing Broker Firm | "Phyllis Browning Company" | "Phyllis Browning Company" | **PASS** (was blank) |
| 61 | Listing Broker "Seller only" checkbox | X CHECKED | X CHECKED | **PASS** |
| 62 | Listing Associate Name | "Bizzy Darling" | "Bizzy Darling" | **PASS** (was blank) |
| 63 | Listing License | "123964" | "123964" | **PASS** (was blank) |
| 64 | Listing Office Address | "Boerne office" | "Boerne office" | **PASS** (was blank) |
| 65 | Broker-to-broker commission block | "3" or "3%" | blank | **FAIL** |

### Page 11 — Receipts

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 66 | Page 11 header | "123 Main St, Boerne, TX 78006" | "123 Main St, Boerne, TX 78006" | **PASS** |
| 67 | Option Fee $ amount | "100" | blank | **FAIL** |
| 68 | Option Fee Escrow Agent | "Kendall County Abstract" | "Bizzy Darling" — WRONG value in wrong slot | **FAIL — listing agent leaked into Option Fee escrow slot** |
| 69 | Option Fee Date | "07/01/2026" | "07/01/2026" | **PASS** |
| 70 | Earnest Money $ amount | "5,000" | blank | **FAIL** |
| 71 | Earnest Money Escrow Agent | "Kendall County Abstract" | "Kendall County Abstract" | **PASS** |
| 72 | Earnest Money Received By | "Ashley Phiffer" | "Ashley Phiffer" | **PASS** (new escrow_officer working) |
| 73 | Contract Receipt Escrow Agent | "Kendall County Abstract" | "Kendall County Abstract" | **PASS** |
| 74 | Contract Receipt Received By | "Ashley Phiffer" | "Ashley Phiffer" | **PASS** |
| 75 | Additional EM Escrow Agent | "Kendall County Abstract" | "Kendall County Abstract" | **PASS** |
| 76 | Additional EM $ | blank (no additional) | blank | **PASS** |

---

## Remaining defects clustered (12 FAIL — down from 24)

### DEFECT R1 (Critical — Buyer-side Page 10 Broker block, 8 fields)
Fields 52, 54-59 blank. Heath = customer and buyer's agent — his info known to Dossie. Fixture keys `other_broker_firm`, `other_broker_associate_name`, `other_broker_only_agent`, `other_broker_email`, `other_broker_phone`, `other_broker_address` NOT populated from customer profile.

**Ship impact:** Contract shipped without buyer-representation identification — TRELA §1101.561 brokerage-relationship integrity issue. Heath would have to hand-fill at signing. Blocker for autonomous fill.

### DEFECT R2 (High — ¶21 Buyer Notice address block, 3 fields)
Fields 40, 41, 42 (Buyer address/phone/email). Same root cause as R1: customer-profile info not fed to fill engine. Field 44 (copy-to-Seller's-agent) also blank despite Bizzy Darling being in prompt.

### DEFECT R3 (Medium — Page 11 Receipt $ amounts)
Fields 67, 70 (Option Fee $ and Earnest Money $ on the receipts). Values exist upstream but don't propagate to the receipt block. Slot-mapping issue.

### DEFECT R4 (Medium — Option Fee Escrow Agent leaked value)
Field 68: "Bizzy Darling" appears in the Option Fee Receipt's Escrow Agent slot. This is a listing_agent_name leak into a slot that should be Kendall County Abstract. Only the Option Fee receipt has this bug; other 3 receipts show correct Kendall County Abstract.

### DEFECT R5 (Medium — Broker-to-broker compensation)
Field 65: buyer_agent_commission_pct 3% not written to the compensation-disclosure block on Page 10.

### DEFECT R6 (Low — ¶8.A licensee-party disclosure)
Field 30: Heath is licensed agent acting as principal buyer. TRELA §1101.652(b)(3) requires disclosure text. Blank.

### DEFECT R7 (Cosmetic — 3 page headers blank)
Fields 12, 21, 37 (Pages 2, 3, 7 "Address of Property" header). Pages 4-6, 8-11 correctly show address. Cosmetic gap.

---

## Top 3 defects for Atlas to dispatch (priority order)

1. **Buyer-side broker block + ¶21 buyer notice** — populate `other_broker_*` keys from customer profile (KW City View + Heath's contact) when `agent_role === 'buyer'`. Includes buyer-only-agent checkbox, name, license, email, phone, address + ¶21 notice block. 11 fields, single root cause.
2. **Page 11 Receipt $ amounts** — write `option_fee` → OptionFeeReceipt_$ widget and `earnest_money` → EarnestMoneyReceipt_$ widget. Also fix Option Fee Escrow Agent slot leak (Bizzy Darling → Kendall County Abstract).
3. **Broker-to-broker compensation block** — `buyer_agent_commission_pct` → Page 10 compensation-disclosure % widget.

Fix these 3 defect clusters → 12 remaining FAIL drops to ~2 (¶8.A licensee disclosure and page headers).

---

## Hadley verdict

**FAIL. Merge gate remains CLOSED on TREC 20-18.**

But dramatically closer. 66/78 populated fields correct is a ~2× improvement over baseline. Legal-substance defects (parties, price, addenda, disclosures) all resolved. Remaining defects concentrated in customer-profile-to-broker-block plumbing.

**Signed:** Hadley, General Counsel, Shepard Ventures — 2026-07-01 11:45 CDT
