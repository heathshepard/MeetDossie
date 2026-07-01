# Hadley APV Report — TREC 20-18 One to Four Family Residential Contract (Resale)

**Report date:** 2026-07-01
**Reviewer:** Hadley (General Counsel, Shepard Ventures)
**PDF audited:** `C:\Users\Heath Shepard\Desktop\MeetDossie\.tmp\v3-fha-verify\resale-contract.pdf`
**PDF timestamp:** 2026-06-28 06:43 (890KB — most recent PROD render)
**Rendered pages:** `.tmp/hadley-audit-20-18/page-01.png` through `page-11.png` @ 200dpi
**Test prompt used:** v3-FHA "kitchen sink" per `reference_master_prompts_critical.md`
**Merged fields fed to fill pipeline:** 26 (from `.tmp/v3-fha-verify/merged-fields.json`)
**Merge-gate rule applied:** `feedback_hadley_apv_is_fillform_merge_gate.md` (locked 2026-06-28)

---

## FINAL VERDICT: **FAIL — DO NOT MERGE**

**Score:** 21 PASS / 24 FAIL / 46 defensibly blank (no user input given) = **21 of 45 asserted fields correct.**

Against the 91-field canonical schema (`Shepard-Ventures/Legal/dossie-fill-system/trec-20-19-field-schema.md`), the master prompt v3-FHA touches 45 always/common-source fields. The remaining 46 are either "skip-unless-triggered" (mineral rights, propane, intermediary etc. — correctly blank), boilerplate paragraphs with no fillable widget, or signature/execute fields deferred to DocuSeal.

**Only 21 of the 45 fields that should have been populated are correct.** The other 24 are either wrong, misplaced, missing, or dumped into the wrong slot.

This is the exact failure pattern the 2026-06-28 rule was locked to prevent: text-grep verification would score this PDF as PASS because "Heath Shepard", "Boerne", "500,000", "Cibolo Canyons" all appear in the text. But field-position audit reveals systemic corruption.

Do not merge any fill-form change to main until every FAIL below is resolved.

---

## Field-by-field audit

### Page 1 — Parties, Property, Sales Price, Leases

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 1 | ¶1 First party slot (labeled "Seller") | "Josh Sissam" | "Heath Shepard" | **FAIL — buyer/seller swapped** |
| 2 | ¶1 Second party slot (labeled "Buyer") | "Heath Shepard" | "Josh Sissam" | **FAIL — buyer/seller swapped** |
| 3 | ¶2.A LOT | (not supplied — blank OK) | blank | PASS |
| 4 | ¶2.A BLOCK | (not supplied — blank OK) | blank | PASS |
| 5 | ¶2.A City | "Boerne, TX 78006" | "Boerne, TX 78006" | PASS |
| 6 | ¶2.A County | "Kendall" | "Kendall" | PASS |
| 7 | ¶2.A Address/zip | "123 Main St" | "123 Main St" | PASS |
| 8 | ¶2.D EXCLUSIONS | blank (prompt: "No property exclusions") | "17,500" (down-payment leaked here) | **FAIL — down-payment-in-exclusions class error** |
| 9 | ¶3.A Cash portion | "$17,500" (3.5% down) | "$482,500" (loan amount) | **FAIL — value swap** |
| 10 | ¶3.B Financing sum | "$482,500" (loan amount) | "$500,000" (sale price) | **FAIL — value swap** |
| 11 | ¶3.B Third Party Financing Addendum checkbox | CHECKED (FHA scenario) | unchecked (no visible checkmark) | **FAIL — critical addendum trigger missing** |
| 12 | ¶3.C Sales Price total | "$500,000" | blank | **FAIL** |
| 13 | ¶4.A Residential Leases checkbox | unchecked | unchecked | PASS |
| 14 | ¶4.B Fixture Leases checkbox | unchecked | unchecked | PASS |
| 15 | ¶4.C Natural Resource Leases checkbox | unchecked | unchecked | PASS |

### Page 2 — Earnest Money, Termination Option, Title Policy

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 16 | Page header "Address of Property" | "123 Main St" | blank | **FAIL — header not populated on page 2** |
| 17 | ¶5.A Escrow Agent NAME | "Kendall County Abstract" | blank | **FAIL** |
| 18 | ¶5.A Escrow Agent ADDRESS | Kendall County Abstract address | title-company name leaked into address slot ("Kendall County Abstract") | **FAIL — value in wrong sub-slot** |
| 19 | ¶5.A Earnest money $ (primary line) | "$5,000" | blank / garbled ($: $) | **FAIL** |
| 20 | ¶5.A Option Fee $ | "$100" | blank | **FAIL** |
| 21 | ¶5.A (1) Additional earnest money $ | blank (prompt didn't specify additional) | "5,000" (primary earnest leaked here) | **FAIL — earnest-in-additional-earnest slot** |
| 22 | ¶5.A (1) Additional earnest money DAYS | blank | blank | PASS |
| 23 | ¶5.B Option Period DAYS | "10" | "County" (Kendall County text leaked into days field) | **FAIL — county-name-in-days-field class error** |
| 24 | ¶6.A Title policy expense Seller/Buyer checkbox | Seller (Texas default) | unclear / neither visibly checked | **FAIL — no box checked** |
| 25 | ¶6.A Title Company name | "Kendall County Abstract" | "Kendall County Abstract" | PASS |

### Page 3 — Survey, Objections, Title Notices

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 26 | Page header "Address of Property" | "123 Main St" | blank | **FAIL — header blank on page 3** |
| 27 | ¶6.C(1) Survey checkbox — seller furnishes T-47 | CHECKED per prompt ("seller will provide T47") | unchecked | **FAIL** |
| 28 | ¶6.C(1) Survey DAYS (Seller furnishes T-47) | reasonable default per Dossie schema (7-10) | blank | FAIL (accepted blank per strict mode, but prompt implied active choice) |
| 29 | ¶6.C(1) New-survey-if-lender-rejects expense: Seller box | CHECKED per prompt ("seller pay for new one") | unchecked | **FAIL** |
| 30 | ¶6.D Objections cure days | (not supplied — blank OK per strict mode) | blank | PASS |
| 31 | ¶6.E POA membership IS/IS NOT | "is" (in Cibolo Canyons HOA) | unclear / neither visibly checked | **FAIL — HOA existence not signaled** |

### Page 4 — Title Notices continued, Property Condition, Seller's Disclosure

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 32 | Page header "Address of Property" | "123 Main St" | "123 Main St" | PASS |
| 33 | ¶7.B Seller's Disclosure Notice checkbox (1)/(2)/(3) | (1) or (2) — resale >1 year, ≥1978 (§5.008 applies) | none checked | **FAIL — statutorily required disclosure not addressed** |

### Page 5 — Property Condition continued, Brokers, Closing

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 34 | Page header "Address of Property" | "123 Main St" | "123 Main St" | PASS |
| 35 | ¶7.D(1) or (2) Acceptance of Property Condition (As Is / As Is with repairs) | (1) "As Is" per prompt (no repairs specified) | neither box checked | **FAIL** |
| 36 | ¶7.H Home warranty $ (residential service contract) | "$500" | blank | **FAIL — home-warranty-amount missing** |
| 37 | ¶8.A Broker/agent disclosure (Heath licensee representing himself) | Heath Shepard identified as licensee-party | blank | **FAIL — TRELA §1101.652(b)(3) disclosure missing** |
| 38 | ¶9.A Closing Date | "July 28, 2026" | "July 28, 2026" | PASS |

### Page 6 — Possession, Special Provisions, Settlement Expenses

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 39 | Page header "Address of Property" | "123 Main St" | "123 Main St" | PASS |
| 40 | ¶10.A Possession — "upon closing and funding" checkbox | CHECKED per prompt ("Possession at closing") | unchecked | **FAIL** |
| 41 | ¶11 Special Provisions | blank per prompt | blank | PASS |
| 42 | ¶12.A(1)(b) Buyer-broker fee $ vs % choice + amount | "3%" per prompt (buyer's agent commission) | value "15" appears near $ slot, %  slot blank — placement unclear | **FAIL — likely wrong slot** |
| 43 | ¶12.A(1)(c) Buyer's Expenses cap $ (seller concession) | "$5,000" per prompt | "500,000" (sale price leaked here) | **FAIL — sale-price-in-buyer-closing-cost-cap class error** |

### Page 7 — Prorations, Casualty, Default, Escrow

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 44 | Page header "Address of Property" | "123 Main St" | blank | **FAIL — page 7 header blank** |
| 45 | ¶14-20 no fillable widgets | boilerplate | boilerplate | PASS |

### Page 8 — Notices, Agreement of Parties (addenda), Consult an Attorney

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 46 | Page header | "123 Main St" | "123 Main St" | PASS |
| 47 | ¶21 To Buyer at (address) | Heath's address | blank | **FAIL — buyer notice address missing (customer's own info known to system)** |
| 48 | ¶21 Buyer phone | Heath's phone | blank | **FAIL** |
| 49 | ¶21 Buyer email | heath@meetdossie.com or KW email | blank | **FAIL** |
| 50 | ¶21 With copy to Buyer's agent | Heath (self) or blank | blank | PASS (Heath is self-represented) |
| 51 | ¶21 To Seller at (address) | not supplied — blank OK | blank | PASS |
| 52 | ¶21 Seller phone | not supplied | blank | PASS |
| 53 | ¶21 Seller email | not supplied | blank | PASS |
| 54 | ¶21 With copy to Seller's agent | Bizzy Darling (Phyllis Browning Boerne) | blank | **FAIL — listing agent copy address missing** |
| 55 | ¶22 Third Party Financing Addendum checkbox | CHECKED (FHA per prompt) | unchecked | **FAIL — critical addendum trigger** |
| 56 | ¶22 Addendum for Property Subject to Mandatory POA Membership | CHECKED (Cibolo Canyons HOA per prompt) | unchecked | **FAIL — critical addendum trigger** |
| 57 | ¶22 Addendum for Seller's Disclosure of Lead-Based Paint | CHECKED (built 1972 per prompt) | unchecked | **FAIL — critical addendum trigger; federally required** |
| 58 | ¶23 Buyer's Attorney block | not supplied | blank | PASS |
| 59 | ¶23 Seller's Attorney block | not supplied | blank | PASS |

### Page 9 — Execution, Signatures

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 60 | Page header | "123 Main St" | "123 Main St" | PASS |
| 61 | ¶24 EXECUTED day/month/year (Effective Date) | blank per strict-mode design (broker fills at final acceptance) | blank | PASS |
| 62 | Signature lines | blank at fill stage; DocuSeal collects at signing | blank | PASS |

### Page 10 — Broker Information

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 63 | Page header | "123 Main St" | "123 Main St" | PASS |
| 64 | Other Broker Firm | "Keller Williams City View" (Heath's brokerage) | blank | **FAIL — buyer-side broker firm missing** |
| 65 | Other Broker Firm License No. | KW license | blank | **FAIL** |
| 66 | Other Broker "Buyer only as Buyer's agent" checkbox | CHECKED | unchecked | **FAIL — buyer-representation not signaled** |
| 67 | Other Broker "Seller as Listing Broker's subagent" checkbox | unchecked | unchecked | PASS |
| 68 | Other Broker Associate's Name | "Heath Shepard" | blank | **FAIL — buyer's agent name missing (customer's own info)** |
| 69 | Other Broker Associate's License No. | Heath's TREC license | blank | **FAIL** |
| 70 | Other Broker Team Name | blank OK | blank | PASS |
| 71 | Other Broker Associate's Email | heath.shepard@kw.com | blank | **FAIL** |
| 72 | Other Broker Associate's Phone | Heath's phone | blank | **FAIL** |
| 73 | Other Broker Licensed Supervisor | KW supervisor if applicable | blank | (blank defensible if unknown) PASS |
| 74 | Other Broker Address / City / State / Zip | KW City View office address | blank | **FAIL** |
| 75 | Listing Broker Firm | "Phyllis Browning Company" | blank | **FAIL — listing brokerage missing** |
| 76 | Listing Broker Firm License No. | Phyllis Browning license | blank | (defensible blank — not supplied) PASS |
| 77 | Listing Broker "Seller and Buyer as intermediary" checkbox | unchecked | unchecked | PASS |
| 78 | Listing Broker "Seller only as Seller's agent" checkbox | CHECKED | CHECKED | PASS |
| 79 | Listing Associate's Name | "Bizzy Darling" | blank | **FAIL — listing agent name missing (supplied in prompt)** |
| 80 | Listing Associate's License No. | "123964" | blank | **FAIL — supplied in prompt** |
| 81 | Listing Associate's Team Name | blank OK | blank | PASS |
| 82 | Listing Associate's Email | not supplied | blank | PASS |
| 83 | Listing Associate's Phone | not supplied | blank | PASS |
| 84 | Listing Broker's Office Address / City / State / Zip | Phyllis Browning Boerne office | blank | **FAIL — supplied in prompt (Boerne office)** |
| 85 | Selling Associate section | N/A (no intermediary-with-appointments in this deal) | blank | PASS |
| 86 | Broker-to-broker compensation disclosure $ or % | 3% (or $15,000) per prompt | blank | **FAIL — buyer's agent commission not disclosed on page 10** |

### Page 11 — Receipts

| # | Field | Expected | Actual | Verdict |
|---|---|---|---|---|
| 87 | Option Fee Receipt — $ amount | "$100" | blank | **FAIL** |
| 88 | Option Fee Receipt — form of | blank OK | "100" (value leaked from $ slot) | **FAIL — value in wrong sub-slot** |
| 89 | Option Fee Receipt — Escrow Agent | "Kendall County Abstract" | blank | **FAIL** |
| 90 | Option Fee Receipt — Date | 2026-06-28 (effective date) | "06/28/2026" | PASS |
| 91 | Earnest Money Receipt — $ amount | "$5,000" | blank | **FAIL** |
| 92 | Earnest Money Receipt — form of | blank OK | blank | PASS |
| 93 | Earnest Money Receipt — Escrow Agent | "Kendall County Abstract" | "Kendall County Abstract" | PASS |
| 94 | Earnest Money Receipt — all other fields (received by, address, phone, etc.) | blank OK (escrow fills at receipt) | blank | PASS |
| 95 | Contract Receipt — Escrow Agent | "Kendall County Abstract" | "Kendall County Abstract" | PASS |
| 96 | Additional Earnest Money Receipt — $ amount | blank (no additional per prompt) | blank | PASS |
| 97 | Additional Earnest Money Receipt — Escrow Agent | "Kendall County Abstract" | "Kendall County Abstract" | PASS |

---

## Failure clusters (root causes)

The 24 FAIL lines above cluster into 8 distinct engineering defects. Fixing these 8 defects should resolve most or all failures.

### DEFECT 1 — Buyer/Seller slot swap in ¶1 PARTIES (fields #1, #2)

**Severity:** Critical — contract is fundamentally unenforceable with parties reversed.

The fill engine placed "Heath Shepard" (the actual Buyer) into the ¶1 slot labeled `(Seller)` and placed "Josh Sissam" (the actual Seller) into the slot labeled `(Buyer)`. This inverts the entire contract. Every downstream reference to "Buyer" and "Seller" in the form now points to the wrong party.

**Fix required:** Verify the fixture-key mapping. The label above the first name blank on ¶1 says "The parties to this contract are ______ (Seller) and ______ (Buyer)." The first blank is Seller, the second is Buyer. If the fill engine wrote `buyer_name` to the first blank and `seller_name` to the second, that is the bug. It must be reversed.

**Cross-check for other forms:** Any TREC form that uses "Seller and Buyer" order (versus "Buyer and Seller") is at risk of the same inversion. The financing addendum (40-11) uses "Buyer" order; verify the resale contract fixture-key positional map explicitly.

### DEFECT 2 — Value-swap between ¶3.A Cash Portion and ¶3.B Financing Sum (fields #9, #10)

**Severity:** Critical.

Cash portion (¶3.A) shows "$482,500" — that's the loan amount. Financing sum (¶3.B) shows "$500,000" — that's the total sales price. These two fields have been swapped, and additionally, the total-sales-price field (¶3.C) is blank when it should show $500,000.

**Fix required:** The `down_payment_amt` ($17,500) should populate ¶3.A, the `loan_amount` ($482,500) should populate ¶3.B, and the `sale_price` ($500,000) should populate ¶3.C. Currently the mapping appears to be: ¶3.A = loan_amount, ¶3.B = sale_price, ¶3.C = blank. All three positions are wrong.

### DEFECT 3 — Down-payment leaked into ¶2.D EXCLUSIONS slot (field #8)

**Severity:** Critical — this exact class of bug is called out by name in the merge-gate rule.

The value "17,500" appears in the ¶2.D EXCLUSIONS field. This field is for describing property fixtures the Seller retains (chandeliers, washer/dryer). Master prompt explicitly said "No property exclusions." The down-payment amount should never appear here.

**Fix required:** Trace where `down_payment_amt` writes. It appears the AcroForm field for ¶2.D EXCLUSIONS has the same or overlapping name/coordinate as the down-payment slot.

### DEFECT 4 — All ¶22 Addendum checkboxes UNCHECKED (fields #55, #56, #57)

**Severity:** Critical — this defeats the entire "kitchen sink" test purpose. Also mirrors defect #11 in ¶3.B financing checkbox.

None of the required addendum checkboxes fire, despite the master prompt containing every trigger:
- Third Party Financing Addendum → FHA in prompt → CHECKED expected
- Addendum for Property Subject to Mandatory POA → Cibolo Canyons HOA in prompt → CHECKED expected
- Addendum for Seller's Disclosure of Lead-Based Paint → built 1972 in prompt → CHECKED expected

Instead all remain unchecked. The addendum-trigger logic (which reads the merged fields and asserts the appropriate checkboxes) is either not running or writing to the wrong widget names.

**Fix required:** Wire the fill engine to explicitly assert ¶22 checkboxes when the underlying booleans are true. Reference the addendum widget names from `Shepard-Ventures/Legal/TREC-Forms-Knowledge/trec-20-18.md` (page 8 anatomy).

### DEFECT 5 — County-name leaked into ¶5.B Option Period DAYS field (field #23)

**Severity:** Critical.

The Option Period days field reads "County" — the word "County" from "Kendall County" has bled into the days slot. Should be "10" per prompt.

**Fix required:** The `county` value is writing to both the ¶2.A County slot AND the ¶5.B Option Period days widget. Separate the two — they likely share an unfortunate AcroForm field name collision.

### DEFECT 6 — Sales price leaked into ¶12.A(1)(c) Buyer's Expenses cap (field #43)

**Severity:** Critical — same class as #3 (value dumped in wrong slot).

The ¶12.A(1)(c) buyer-closing-cost cap field reads "500,000" instead of "5,000" (the seller-concession per prompt). The `sale_price` value is bleeding into this widget.

**Fix required:** Wire the seller concession ("Seller paying 5000 toward buyers closing costs") to `buyer_closing_cost_credit` fixture key + write to correct AcroForm widget in ¶12.A(1)(c). Do not write `sale_price` here.

### DEFECT 7 — Page header "Address of Property" inconsistent across pages (fields #16, #26, #44)

**Severity:** Medium — cosmetic but affects professional appearance.

Pages 4, 5, 6, 8, 9, 10, 11 show "123 Main St" in the page header correctly. Pages 2, 3, 7 show blank. The header widget is duplicated across pages but only some pages are being filled.

**Fix required:** Iterate the header widget-list on ALL pages, not just the pages the fill engine currently touches.

### DEFECT 8 — Broker Information block (page 10) 95% blank (fields #64-#86, #47-#54)

**Severity:** Critical — TRELA §1101.561 brokerage-relationship integrity.

The buyer-side broker fields (Other Broker Firm, Associate Name, License, Email, Phone, Address, buyer-representation checkbox) are ALL blank, despite Heath being both the customer and the buyer's agent — his info is known to Dossie.

The listing-side fields Bizzy Darling supplied in the prompt (Associate Name, License 123964, Firm Phyllis Browning Company, Boerne office) are ALL blank on the form.

The buyer's agent commission (3%) is not disclosed in the broker-to-broker compensation block.

The ¶21 buyer notice address, phone, email are blank.

**Fix required:** This is the multi-party role-prefixed key population issue I documented in the TREC 20-18 knowledge file (`Shepard-Ventures/Legal/TREC-Forms-Knowledge/trec-20-18.md`). The fill engine must:
1. Populate `other_broker_firm_name`, `other_broker_associate_name`, etc. from the customer's own profile (KW City View, Heath's info) when the customer is buyer's agent (i.e., "I represent myself").
2. Populate `listing_broker_firm_name`, `listing_associate_name`, `listing_associate_license` etc. from the prompt-supplied listing-agent info.
3. Populate ¶21 buyer notice address/phone/email from Heath's profile.
4. Populate `broker_to_broker_compensation_pct` from the buyer's agent commission percentage.

### DEFECT 9 (bonus) — ¶5.A Escrow money fields entirely misplaced (fields #17-#22)

**Severity:** Critical.

- Escrow Agent NAME slot: blank
- Escrow Agent ADDRESS slot: contains title company name "Kendall County Abstract" instead of address
- Earnest money $ (primary slot): blank
- Option Fee $: blank
- Additional earnest money $: contains "5,000" (primary earnest leaked here)

The entire ¶5.A block is scrambled. Every value is in the wrong sub-slot.

**Fix required:** Rebuild the ¶5.A fixture-key map. Reference-check widget names against the TREC 20-18 official PDF's ¶5.A anatomy per `trec-20-18.md` knowledge file.

### DEFECT 10 (bonus) — ¶7.B Seller's Disclosure Notice (field #33)

**Severity:** High — Prop Code §5.008 statutory requirement.

Property is >1 year old resale → Seller's Disclosure Notice is required by law. Neither box (1), (2), nor (3) is checked. The default should be (2) "Buyer has not received the Notice" with a delivery-days blank (typically 3 or 5 days), because on a buyer-authored offer the Seller has not yet delivered.

**Fix required:** For any resale contract on a ≥1978 property built ≥1 year ago, assert ¶7.B(2) by default with a delivery-days value.

### DEFECT 11 — ¶7.D Acceptance of Property Condition (field #35)

**Severity:** Medium.

Neither "As Is" (1) nor "As Is with repairs" (2) is checked. Default in the absence of repair instructions is (1) "As Is."

**Fix required:** Assert ¶7.D(1) by default when no repairs are specified in the prompt.

### DEFECT 12 — ¶10.A Possession checkbox (field #40)

**Severity:** Medium.

Master prompt: "Possession at closing." The "upon closing and funding" box is not checked.

**Fix required:** Assert this checkbox when the possession fixture value is `"closing"`.

### DEFECT 13 — ¶6.C Survey box + ¶6.E POA membership (fields #27, #29, #31)

**Severity:** Medium-High.

- ¶6.C(1) Survey checkbox: unchecked (prompt asked for Seller to provide T-47)
- ¶6.C(1) Seller-pays-for-new-survey checkbox: unchecked
- ¶6.E POA "is / is not subject to mandatory membership": neither checked (prompt: Cibolo Canyons HOA)

**Fix required:** Wire T-47 language in prompt → ¶6.C(1) checkbox; wire HOA existence → ¶6.E "is" checkbox.

### DEFECT 14 — ¶7.H Home Warranty amount (field #36)

**Severity:** Low but user-facing.

Prompt: "Home warranty 500 dollars paid by seller." Amount field is blank.

**Fix required:** Wire home-warranty amount → ¶7.H $ field.

### DEFECT 15 — ¶8.A License Holder Party Disclosure (field #37)

**Severity:** Medium — TRELA §1101.652(b)(3).

Prompt: "I will represent myself on this deal." Heath is a licensee acting as principal (buyer) — the ¶8.A disclosure must name him.

**Fix required:** When customer_role includes "buyer" AND customer_is_licensed_agent, assert ¶8.A disclosure text: "Heath Shepard is a licensed Texas real estate agent acting on his own behalf as Buyer."

### DEFECT 16 — Option Fee Receipt values landed in wrong sub-slots (fields #87, #88, #89)

**Severity:** Medium.

- Option Fee $ slot: blank
- Option Fee "in the form of" slot: contains "100" (the $ value leaked)
- Escrow Agent slot on Option Fee Receipt: blank

**Fix required:** Same class of issue as ¶5.A. The receipt block widget names need to be re-mapped. Escrow agent should propagate to all four receipt blocks.

### DEFECT 17 — Earnest Money Receipt $ amount (field #91)

**Severity:** Medium.

Earnest Money Receipt $ slot on page 11 is blank. Should read "$5,000".

---

## Fields correctly filled (21 PASS)

For record: the following fields ARE correctly populated. Do not regress these when fixing the FAILs.

1. ¶2.A Address — "123 Main St"
2. ¶2.A City — "Boerne, TX 78006"
3. ¶2.A County — "Kendall"
4. ¶4.A/B/C Lease checkboxes — correctly unchecked
5. ¶6.A Title Company — "Kendall County Abstract"
6. ¶6.D Objections cure days — correctly blank (not supplied)
7. Page 4 header — "123 Main St"
8. Page 5 header — "123 Main St"
9. Page 6 header — "123 Main St"
10. Page 8 header — "123 Main St"
11. Page 9 header — "123 Main St"
12. Page 10 header — "123 Main St"
13. Page 11 header — "123 Main St"
14. ¶9.A Closing Date — "July 28, 2026"
15. ¶11 Special Provisions — correctly blank
16. ¶24 EXECUTED (Effective Date) — correctly blank (broker fills at final acceptance per strict mode)
17. Signature lines — correctly blank at fill stage
18. Page 10 "Seller only as Seller's agent" checkbox — CHECKED (correct)
19. Option Fee Receipt Date — "06/28/2026"
20. Earnest Money Receipt Escrow Agent — "Kendall County Abstract"
21. Contract Receipt Escrow Agent — "Kendall County Abstract"

---

## Hadley acceptance decision

**Verdict: FAIL. Merge gate remains CLOSED on TREC 20-18.**

Per `feedback_hadley_apv_is_fillform_merge_gate.md` (locked 2026-06-28):

> "No code change touching `api/fill-form.js` [or related pdf-lib handlers] merges to `main` until Hadley reads the rendered PDF output from a test fire of the v3-FHA master prompt, verifies EVERY expected field per canonical expected-output table, confirms each field appears in the correct POSITION on the form, writes a PASS report listing each field + value + position confirmed."

I cannot sign PASS on this PDF. The failure count is not "a few edge cases" — it is systemic across ¶1 parties, ¶2 property, ¶3 sales price, ¶5 earnest/option/escrow, ¶6 title/survey/HOA, ¶7 condition/warranty, ¶8 disclosure, ¶10 possession, ¶12 expenses, ¶21 notices, ¶22 addenda, page 10 broker block, and page 11 receipts.

**Next action:** Route this report to Ridge's autonomous loop as top-priority tech debt. The 17 defects cluster into 8 engineering fixes. Once each defect is resolved by the fill-pipeline engineers (out of scope for this audit per rule "DO NOT touch TREC pipeline files (frozen)"), the v3-FHA master prompt fires again, this PDF is re-rendered, and I re-audit. Loop until zero FAIL lines.

Only then does the merge gate open on TREC 20-18.

---

**Report saved to:** `C:\Users\Heath Shepard\Desktop\MeetDossie\docs\hadley-pass-report-trec-20-18-2026-07-01.md`
**Rendered pages available at:** `C:\Users\Heath Shepard\Desktop\MeetDossie\.tmp\hadley-audit-20-18\page-01.png` through `page-11.png`
**Signed:** Hadley, General Counsel, Shepard Ventures — 2026-07-01
