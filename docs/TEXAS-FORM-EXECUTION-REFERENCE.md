# Texas Real Estate Form Execution Reference

**Purpose:** authoritative spec for how TREC/TXR forms get executed, so DossieSign enforces initials/signatures/dates/notarization the way DocuSign and zipForm already do. This is the source doc for the e-sign field-mapping build.

**Author:** Hadley (Shepard Ventures GC agent). **Not a substitute for a licensed Texas attorney.** Everywhere this doc says "flag for attorney review," that is not decorative — get a licensed TX real estate attorney to confirm before the rule ships as a hard gate in DossieSign, because a wrong default here creates real legal exposure for Dossie's customers.

**Research method:** Every TREC form claim below was pulled by downloading the actual current PDF from `trec.texas.gov` and reading it page-by-page (not from training memory), on **2026-09-28**. T-47 was pulled the same way from `tdi.texas.gov`. Where I could not independently verify a form this session (New Home Contract page count beyond page 1, Condo Resale full page count, T-47.1, and all TXR-member-only forms), I've said so explicitly instead of guessing — see the flags inline and the "Not Verified This Session" section at the end.

**Known discrepancy, flagged rather than silently resolved:** `trec.texas.gov/agency-information/contracts` (the forms index page, scraped 2026-09-28) lists TREC 20-19's effective date as **07/01/2026**. The actual downloaded 20-19 PDF's header shows **05-04-2026**, and that same 05-04-2026 date appears on the several other forms I downloaded that are clearly the same revision wave (39-11, 36-11, 55-1, 25-17, 9-18, 23-20, 30-18, 56-0). By contrast, 40-11 (Third Party Financing Addendum) shows 11-04-2024 in its own PDF, and 50-0 (Notice of Seller's Termination) shows 8-13-18 — both of which exactly match the index page's listed dates for those two forms. That consistency is strong evidence the **PDF header date is the real, form-specific revision date**, and the index page's 07/01/2026 for the 20-19 family is either a forward-dated "upcoming revision" flag or a page-scrape artifact. **Before this ships as a hard-coded revision date anywhere in DossieSign, re-pull `trec.texas.gov/agency-information/contracts` live and reconcile.** This is exactly the kind of drift that caused the 20-18/20-19 bug already — don't hardcode a date from this document without a live re-check at build time.

---

## 1. Master Inventory — TREC Promulgated Forms

Source: `trec.texas.gov/agency-information/contracts` (scraped 2026-09-28) cross-checked against individual PDF downloads where noted. TREC also publishes Broker/Sales-Agent licensing forms (IABS, etc.) under a separate URL, added below.

### Contracts

| Form # | Title | Date (index page) | Date (PDF header, verified) | Pages | Transaction type |
|---|---|---|---|---|---|
| **20-19** | One to Four Family Residential Contract (Resale) | 07/01/2026 | **05-04-2026 (verified — full 12-page PDF read)** | 12 | Residential resale |
| 23-20 | New Home Contract (Incomplete Construction) | 07/01/2026 | 05-04-2026 (verified page 1) | not fully confirmed — see flags | New home, pre-completion |
| 24-20 | New Home Contract (Completed Construction) | 07/01/2026 | not independently pulled | not confirmed | New home, completed |
| 25-17 | Farm and Ranch Contract | 07/01/2026 | 05-04-2026 (verified page 1) | not fully confirmed | Farm & ranch |
| 30-18 | Residential Condominium Contract (Resale) | 07/01/2026 | 05-04-2026 (verified page 1) | not fully confirmed | Condo resale |
| **39-11** | Amendment to Contract | 07/01/2026 | **05-04-2026 (verified — full 1-page PDF read)** | 1 | Universal — amends any of the above |
| 9-18 | Unimproved Property Contract | 07/01/2026 | 05-04-2026 (verified page 1) | not fully confirmed | Land |

`20-19` replaces `20-18` — confirmed directly from the current PDF's own footer text: *"TREC NO. 20-19. This form replaces TREC NO. 20-18."* `20-18` is retired; do not use it or reference it as current anywhere in DossieSign.

### Contract Addenda (attach to one of the contracts above)

| Form # | Title | Date (index page) |
|---|---|---|
| **36-11** | Addendum for Property Subject to Mandatory Membership in a POA | 07/01/2026 (PDF verified 05-04-2026) |
| **40-11** | Third Party Financing Addendum | 01/03/2025 (PDF verified — header shows 11-04-2024, see discrepancy note above) |
| **56-0** | Addendum for Seller's Disclosure of Lead-Based Paint / Hazards (federal law) | 05/28/2026 (PDF verified 05-04-2026) |
| 49-1 | Addendum Concerning Right to Terminate Due to Lender's Appraisal | 03/01/2019 |
| 53-0 | Addendum Containing Notice of Obligation to Pay Improvement District Assessment | 09/01/2021 |
| 11-9 | Addendum for "Back-Up" Contract | 07/01/2026 |
| 48-1 | Addendum for Authorizing Hydrostatic Testing | 03/01/2020 |
| 33-2 | Addendum for Coastal Area Property | 12/05/2011 |
| 47-0 | Addendum for Property in a Propane Gas System Service Area | 02/01/2014 |
| 34-4 | Addendum for Property Located Seaward of the Gulf Intracoastal Waterway | 12/05/2011 |
| 12-3 | Addendum for Release of Liability on Assumed Loan and/or Restoration of Seller's VA Entitlement | 12/05/2011 |
| 44-3 | Addendum for Reservation of Oil, Gas, and Other Minerals | 02/01/2023 |
| 10-6 | Addendum for Sale of Other Property by Buyer | 12/05/2011 |
| 60-0 | Addendum for Section 1031 Exchange | 01/03/2025 |
| 52-1 | Addendum Regarding Fixture Leases | 02/01/2023 |
| 51-1 | Addendum Regarding Residential Leases | 02/01/2023 |
| 16-7 | Buyer's Temporary Residential Lease | 01/05/2026 |
| 28-2 | Environmental Assessment, Threatened or Endangered Species, and Wetlands Addendum | 12/05/2011 |
| 41-3 | Loan Assumption Addendum | 02/01/2023 |
| 57-0 | Non-Realty Items Addendum | 09/03/2025 |
| 26-8 | Seller Financing Addendum | 02/01/2023 |
| 15-7 | Seller's Temporary Residential Lease | 01/05/2026 |
| 45-2 | Short Sale Addendum | 04/01/2021 |

### Other Forms (notices, disclosures, certificates)

| Form # | Title | Date (index page) | Verified this session |
|---|---|---|---|
| **38-8** | Notice of Buyer's Termination of Contract | 04/01/2025 | Yes — full PDF, header 02-10-2025 |
| **50-0** | Notice of Seller's Termination of Contract | 08/13/2018 | Yes — full PDF, header 8-13-18 (matches index exactly) |
| **55-1** | Seller's Disclosure Notice | 05/28/2026 | Yes — full 4-page PDF, header 05-04-2026 |
| 32-5 | Condominium Resale Certificate | 11/25/2024 | Not verified this session |
| RSC-4 | Disclosure of Relationship with Residential Service Company | 06/11/2023 | Not verified this session |
| 54-1 | Landlord's Floodplain and Flood Notice | 11/26/2025 | Not verified this session |
| 58-0 | Notice to Prospective Buyer | 09/03/2025 | Not verified this session |
| 59-0 | Notice to Purchaser of Special Taxing or Assessment District | 02/12/2024 | Not verified this session |
| REI 7-6 | Property Inspection Report | 02/01/2022 | Not verified this session |
| 61-0 | Seller's Disclosure about Groundwater and Surface Water Rights | 07/01/2026 | Not verified this session |
| 62-0 | Seller's Notice to Buyer of Removal of Contingency Under "Back-Up" Addendum | 05/28/2026 | Not verified this session |
| 37-5 | Subdivision Info / Resale Certificate for POA Property | 02/10/2014 | Not verified this session |

### Licensing / disclosure forms (separate TREC section, not in the contracts index)

| Form | Current version | Notes |
|---|---|---|
| **IABS** (Information About Brokerage Services) | **IABS 1-2, effective 01/01/2026** (verified via trec.texas.gov) | Not a contract signature form — see §2 below. |

### Non-TREC forms referenced inside TREC contracts

| Form | Publisher | Verified |
|---|---|---|
| **T-47** Residential Real Property Affidavit | Texas Dept. of Insurance | **Yes — full 2-page PDF, effective November 1, 2024.** [tdi.texas.gov/title/documents/formT-47.pdf](https://www.tdi.texas.gov/title/documents/formT-47.pdf) |
| **T-47.1** Declaration | Texas Dept. of Insurance | **Not verified this session** — the direct PDF URL 404'd and I could not locate the correct current link before the research budget ran out. Do not hardcode T-47.1's execution requirements from memory; confirm from TDI's Basic Manual of Title Insurance before building the field map. |

---

## 2. Per-Form Execution Requirements

### TREC 20-19 — One to Four Family Residential Contract (Resale)
*This is the flagship contract; every other resale/new-home/farm-ranch/condo/land contract in TREC's family shares this same page-by-page architecture (confirmed identical "Initialed for identification by Buyer___ ___ and Seller___ ___" footer on 40-11 p.1, 25-17 p.1, 9-18 p.1, 23-20 p.1, 30-18 p.1 — all pulled this session).*

- **12 pages total.**
- **Initials required on pages 1–9** (every substantive page): "Initialed for identification by Buyer___ ___ and Seller___ ___" — two blanks each, for up to 2 buyers / 2 sellers. This is an identification initial, not a change-approval initial — it exists so no page can be swapped out of the packet after signing, not to flag a specific edit.
- **Page 10 (signature page):** up to 2 Buyer signature lines, up to 2 Seller signature lines. **No individual date field per signer.** There is a single "EXECUTED the ___ day of ___, 20__ (Effective Date)" block at the top of the page explicitly marked "(BROKER: FILL IN THE DATE OF FINAL ACCEPTANCE.)" — the Effective Date is a broker-completed field, not something each signer dates themselves. **This is a legal attestation field with real consequence**: the Effective Date anchors every deadline in the contract (option period, financing deadlines, closing date) — DossieSign must not let this default to "today" or to signature completion date automatically; it must be the date of final acceptance (last signature/initial that completes mutual assent), which the broker (or the platform, deterministically) sets.
- **Page 11:** Broker Contact Information — printed names only, explicitly "(Print name(s) only. Do not sign.)" — not a signature page at all. No initials or dates.
- **Page 12:** four receipt blocks (Option Fee, Earnest Money, Contract, Additional Earnest Money) — signed and dated by the **Escrow Agent**, not by buyer/seller. This page is functionally outside the buyer/seller e-sign envelope; it belongs to title/escrow workflow, not the DossieSign contract-execution flow.
- **Notarization:** none on the contract itself.
- **Who must sign:** Buyer(s) AND Seller(s) — both sides required for a binding contract. Broker never signs the contract.

### TREC 39-11 — Amendment to Contract
- **1 page.** Replaces TREC 39-10 (confirmed from footer).
- **No initial lines anywhere on the form** — this is the TREC-sanctioned instrument for changing *already-executed* contract terms (price, dates, repairs, option fee extension, financing deadline, etc.) via checkbox + fill-in, not handwritten strikeouts.
- Signature block: up to 2 Buyer + 2 Seller signature lines. Same broker-filled "EXECUTED the ___ day of ___" effective-date block as the main contract, no separate per-signer date.
- **This is the correct mechanism for a post-execution change** — see §3 below for how it differs from an in-line strikethrough change made *before* execution.

### TREC 36-11 — Addendum for Property Subject to Mandatory POA
- 1 page. Replaces 36-10. No initials. Buyer x2 / Seller x2 signature lines only, no date fields.

### TREC 55-1 — Seller's Disclosure Notice
- **4 pages, verified in full.** Replaces 55-0 — form itself states it's for contracts entered on or after Sept. 1, 2023.
- **No initials anywhere on pages 1–3** — just Y/N/U checkboxes on condition items.
- **Page 4 signature block:** Seller signature + date (x2 lines) is the operative execution; below that, a separate acknowledgment block: *"The undersigned purchaser hereby acknowledges receipt of the foregoing notice"* with Purchaser signature + date (x2 lines). **The buyer's signature is a receipt acknowledgment, not a party obligation** — in practice many transactions proceed with only the Seller's signature captured and the buyer's receipt evidenced elsewhere (e.g., referenced in Paragraph 7B of the 20-19 contract). Flag for attorney review before DossieSign hard-blocks completion on a missing buyer signature here — the underlying statute (Tex. Prop. Code §5.008) obligates the *seller* to furnish it; buyer counter-signature is customary practice, not itself the compliance trigger.
- No notarization.

### TREC 40-11 — Third Party Financing Addendum
- 2 pages. Replaces 40-10.
- **Initials required on page 1 only** (same "Initialed for identification by Buyer___ ___ and Seller___ ___" line at the bottom).
- Page 2: Buyer x2 / Seller x2 signature lines, no date fields, no initial line (final page of this form, same pattern as the main contract's last substantive page vs. signature page).
- **Legal-attestation risk point:** Paragraph 2A "Buyer does/does not waive all rights to terminate" and the FHA/VA-required-provision checkboxes materially change buyer's termination rights. A wrong default checkbox here is a real-money mistake (buyer loses the ability to terminate under Paragraph 2B). Flag for extra verification in the build — this is a field where DossieSign should force an explicit selection, never default a box checked or unchecked.

### TREC 25-17, 9-18, 23-20, 30-18 (Farm & Ranch, Unimproved Property, New Home Incomplete Construction, Condo Resale)
- Confirmed (page 1 of each, this session) to carry the **identical initials-footer pattern** as 20-19: "Initialed for identification by Buyer___ ___ and Seller___ ___." Given TREC's stated design intent (same drafting committee, same boilerplate language reused verbatim across the family), treat these as following the same page-by-page initials-through-second-to-last-page / signature-only-last-page pattern as 20-19 **as a working assumption**, but **full page counts and exact final-page layout were not independently confirmed this session** for 24-20, and only page 1 was confirmed for 23-20, 25-17, 9-18, 30-18. Before DossieSign hard-codes a field map for these four contract types, pull each one in full the same way 20-19 was pulled here.

### TREC 38-8 — Notice of Buyer's Termination of Contract
- 1 page. Replaces 38-7.
- **No initials.** Buyer-only signature block (x2 lines) + date field next to each signature. **Seller does not sign this form** — it's a unilateral notice from Buyer to Seller, not a bilateral agreement.
- Paragraph (7) lets Buyer cite "Paragraph 6.D. of the contract (6.C. for Residential Condominium Contract)" — meaning the paragraph numbering differs by contract type; DossieSign's termination-notice logic must key off which underlying contract type is active, not hardcode "6.D." universally.

### TREC 50-0 — Notice of Seller's Termination of Contract
- 1 page, last revised 8-13-18 (oldest form pulled this session, confirms PDF header dates are reliable revision dates).
- **No initials.** Seller-only signature block (x2 lines) + date. Buyer does not sign. Narrower trigger set than 38-8 — only "Buyer failed to deliver earnest money" or "Other" (must cite paragraph).

### TREC 56-0 — Addendum for Seller's Disclosure of Lead-Based Paint / Hazards
**Highest legal-consequence form found this session — flag for mandatory attorney review before building.**
- 1 page, but **6 signature lines**, not 4: Buyer x2, Seller x2, **Buyer's Broker, and Seller's Broker** — each with its own date field. This implements a federal requirement (42 U.S.C. §4852d / EPA-HUD lead disclosure rule referenced directly in the form's own "BROKERS' ACKNOWLEDGEMENT" paragraph), not just a TREC-promulgated convention.
- **Trigger condition:** federally mandated for any residential dwelling built before 1978 — this is a *conditional-mandatory* form (see §4), and getting the trigger wrong (age check, or skipping it) is a federal-law compliance failure with civil penalty exposure under the federal statute, independent of TREC rules.
- Section C ("Buyer's Rights") and Section D ("Buyer's Acknowledgment") are check-one-box elections that materially affect whether Buyer keeps or waives the lead-paint inspection right — same "force explicit selection, never silently default" rule as the financing addendum above.
- **DossieSign must capture broker signatures on this form, not just principal signatures** — this is different from every other form reviewed here and easy to miss if the e-sign field map assumes "buyer + seller only."

### IABS — Information About Brokerage Services (current: IABS 1-2, eff. 01/01/2026)
- Not a contract, not typically counter-signed by the recipient as a legal requirement — it's a required *disclosure notice* a license holder must provide at first substantive communication (with limited exceptions: sub-one-year residential lease, party already represented, or open-house-only contact, per trec.texas.gov). No initials. No TREC-mandated signature line function as a condition of validity — a broker satisfies the obligation by providing it (email, handoff, or a website link is commonly accepted practice), though many brokerages still collect an acknowledgment signature as internal file-compliance practice. **Flag for attorney review** if DossieSign is going to hard-require an IABS signature as a blocking condition — that may be stricter than what TRELA actually requires, and being stricter than the law isn't dangerous, but silently treating "unsigned IABS" as "non-compliant" would be an inaccurate compliance signal to a member.

### T-47 — Residential Real Property Affidavit (TDI, not TREC)
- 2 pages, effective November 1, 2024.
- **Notarized — confirmed.** The form is a sworn affidavit: *"Before me, the undersigned notary... personally appeared Affiant(s) who after by me being duly sworn, stated..."* and closes with a "SWORN AND SUBSCRIBED" block and a Notary Public signature line. This is a real notarization requirement, not just a signature.
- Up to 2 affiant signature lines, each under its own perjury-declaration block — **this is a legal attestation under penalty of perjury**, referenced directly in Paragraph 6C of the 20-19 contract as the mechanism that lets Buyer skip ordering a new survey. A wrong or fabricated T-47 has real fraud/perjury exposure for the affiant, and DossieSign should never auto-fill or pre-check this form's content — it must reflect the actual affiant's sworn knowledge, captured through a genuine notarization workflow (which, per Rule 4 below, e-signature platforms typically cannot substitute for in-person or RON notarization).
- **T-47.1 not verified this session** (see flag above) — do not assume T-47.1 is notarization-free until confirmed from a primary TDI source; the 20-19 contract's own Paragraph 6C references "T-47 Affidavit **or** T-47.1 Declaration" as alternatives, which strongly implies they differ on the notarization axis (that's the whole reason a lender/title company would accept one over the other), but I have not personally re-confirmed T-47.1's current text this session, so treat "T-47.1 = no notary" as **unconfirmed carryover from general professional knowledge, not from a primary source pulled today** — get this confirmed by a licensed TX attorney or by re-pulling the TDI PDF before it's encoded as a rule.

---

## 3. Handwritten / Strikethrough Changes — the subtlest requirement

Heath's framing is correct and matches standard Texas real estate practice, but this is a **contract-law question, not a forms-content question** — I did not find primary-source TREC or TDI text that codifies "every handwritten change must be initialed" as a rule; that principle comes from general contract law (an alteration to a document's terms, made after drafting but before or during execution, needs to be affirmatively adopted by every party bound by it — otherwise a party can later claim the change was never agreed to). **Flag for a licensed TX real estate attorney to confirm before this becomes an enforced gate in DossieSign** — it's exactly the kind of "novel/high-stakes" call this role isn't licensed to finalize alone.

What I can say with confidence from the forms themselves and from how DocuSign/zipForm actually implement this in practice:

1. **Two different mechanisms exist, and they are not interchangeable:**
   - **Pre-execution changes** (negotiating a blank on the printed form — e.g., writing in a different option-fee amount, or striking a printed number and writing a new one — before *any* party has signed): standard practice is strike-through + handwritten correction + **both parties' initials directly adjacent to the specific strike**, at the point the change is made. This is distinct from the form's built-in "Initialed for identification by Buyer/Seller" footer line, which only proves page integrity, not approval of a specific edit.
   - **Post-execution changes** (a term needs to change *after* the contract is already fully signed): TREC's own answer is **Form 39-11, Amendment to Contract** (confirmed above — it's specifically designed for this: sales price, closing date, repair costs, brokerage compensation splits, option-fee extensions, financing deadline changes, "Other Modifications"). A handwritten strike on an already-executed original is not the right tool once signatures exist — an amendment is.

2. **What an e-sign system must do to support the pre-execution case (the "change-initial field adjacent to an edit" Heath described):**
   - A distinct annotation/field type from a signature or an identification-initial: call it a **Manual Change Field**. It has an anchor position (page, x/y coordinates) tied to the specific edited text or blank, not a generic page-bottom location.
   - Each Manual Change Field is linked to **one required initial sub-field per signing party** who is bound by the contract — for a 2-buyer/2-seller deal, that's up to 4 linked initials, not a single shared initial.
   - The document cannot be marked complete/executed until every linked initial is captured — same blocking behavior DocuSign uses for "Initial Here" tags it inserts next to a redline.
   - This only makes sense **before** the envelope is sent for final signature. Once any party has signed, changing the underlying text and asking for a "change initial" instead of a full amendment is the wrong mechanism — DossieSign should route that case to auto-generating a 39-11 Amendment instead of allowing an in-place edit to an already-partially-executed document.
   - Practically: this is the same feature DocuSign calls a "strikethrough + initial" annotation and zipForm implements as an editable clause with a linked initial tag — Heath's instinct to copy them rather than reinvent is right; the risk isn't the UX pattern, it's mis-scoping *when* it's allowed (pre- vs. post-execution) and *who* it's required from (every party bound, not just the one requesting the change).

---

## 4. Mandatory vs. Optional vs. Conditionally-Triggered, by Transaction Type

| Form | Residential resale | New home | Farm & Ranch | Land (unimproved) | Condo | Trigger |
|---|---|---|---|---|---|---|
| 20-19 / 23-20 or 24-20 / 25-17 / 9-18 / 30-18 (the base contract) | Mandatory | Mandatory | Mandatory | Mandatory | Mandatory | Always — one base contract per deal, matched to property type |
| 55-1 Seller's Disclosure Notice | Mandatory (statutory, Tex. Prop. Code §5.008) unless a §5.008 exemption applies (e.g., new construction never occupied, certain trustee/foreclosure sales) | Conditional — often not required for never-occupied new construction | Mandatory (same statute) | Generally N/A (no dwelling) | Mandatory | Statutory — verify exemption list with attorney, don't hardcode "always required" |
| 56-0 Lead-Based Paint Addendum | **Conditional — mandatory if built before 1978** | Not applicable (new construction) | Conditional (same age trigger, if a residence exists) | Not applicable | Conditional | Federal law (42 U.S.C. §4852d) — property age is the trigger; this is the one I'd build a hard, un-skippable gate for |
| 36-11 POA Addendum | Conditional — mandatory in practice if Property is subject to mandatory POA membership (20-19 Para. 6E(2) requires disclosure either way; the addendum is how Buyer gets full POA-related termination rights) | Conditional, same trigger | Conditional, same trigger | Conditional, same trigger | N/A (condo has its own POA/HOA mechanism — see 30-18 §2B/C) | HOA/POA existence |
| 32-5 Condo Resale Certificate / 37-5 Subdivision Info | N/A | N/A | N/A | N/A | Conditional-mandatory | Condo/subdivision-association existence |
| 40-11 Third Party Financing Addendum | Conditional — mandatory whenever financing (not all-cash) | Conditional, same | Conditional, same | Conditional, same | Conditional, same | Financing vs. cash |
| 26-8 Seller Financing Addendum | Conditional | Conditional | Conditional | Conditional | Conditional | Seller-financed deal |
| T-47/T-47.1 | Conditional — triggered when Buyer wants to rely on an existing survey instead of ordering a new one (20-19 Para. 6C) | Conditional, same mechanism | Conditional, same | Conditional, same | Conditional, same | Buyer's Para. 6C election |
| 45-2 Short Sale Addendum | Conditional | Rare/N/A | Conditional | Conditional | Conditional | Sale price < mortgage payoff, lender approval required |
| 41-3 Loan Assumption Addendum | Conditional | Rare/N/A | Conditional | Conditional | Conditional | Buyer assumes existing loan |
| 33-2 / 34-4 Coastal / Gulf Intracoastal Addenda | Conditional | Conditional | Conditional | Conditional | Conditional | Property location (coastal county) |
| 28-2 Environmental/Endangered Species/Wetlands Addendum | Optional (Buyer's choice — form itself says "if Buyer is concerned about these matters... should be used") | Optional | Optional | Optional | Optional | Buyer election, no statutory trigger |
| 39-11 Amendment | Optional/as-needed | Optional/as-needed | Optional/as-needed | Optional/as-needed | Optional/as-needed | Any post-execution change |
| IABS | Mandatory disclosure (with the narrow exceptions listed in §2 above) — practically universal | Same | Same | Same | Same | First substantive communication |
| IABS is not itself part of the closing contract packet — it's a pre-contract disclosure. | | | | | | |

**Septic:** I did not find a standalone TREC "septic disclosure" form this session — the 55-1 Seller's Disclosure Notice covers septic system condition as a checklist item (page 1, "Plumbing System / Septic System / Public Sewer System") rather than as a separate form. Don't build a separate "septic form" trigger; it's already inside 55-1.

**This table is the input for the "template bundle" feature** (buyer bundle, seller bundle, land, ranch, commercial). Commercial transactions are **not covered by any TREC promulgated form** — TREC's forms are explicitly residential/farm-ranch/land only (see 20-19's own header: "NOTICE: Not For Use For Condominium Transactions," and the general TREC forms scope). Commercial deals use TXR or TAR (Texas Association of Realtors commercial forms) or attorney-drafted contracts — **flag this whole category for attorney involvement**, it's outside what a promulgated-forms-based e-sign engine should assume it can fully automate.

---

## 5. Forms Flagged for Extra Verification (real legal consequence if built wrong)

Ranked by how much damage a wrong default does:

1. **56-0 Lead-Based Paint Addendum** — federal statute, civil penalty exposure, 6 required signatures including both brokers, and a property-age trigger that must be computed correctly (pre-1978). Highest priority for attorney review and for a hard-block gate (can't skip if triggered, can't silently default the Section C/D checkboxes).
2. **T-47 / T-47.1** — sworn affidavit under penalty of perjury (T-47) vs. an unverified declaration (T-47.1, pending confirmation) that a title company/lender either will or won't accept — wrong form choice can blow up a closing at the title company, and a fabricated/auto-filled T-47 is a perjury problem, not a UX bug.
3. **20-19 Paragraph 9 / Effective Date field** — anchors every contract deadline (option period, financing, closing). Must be broker/platform-set to the actual date of final mutual acceptance, never auto-set to "today" or to whenever the last click happened if that's different from actual acceptance.
4. **40-11 Third Party Financing Addendum, Para. 2A waiver checkbox** — silently defaulting this either way changes Buyer's termination rights under a real dollar amount at stake (earnest money).
5. **55-1 Seller's Disclosure Notice §5.008 exemption logic** — deciding a form is "not required" is itself a legal determination; a wrong "exempt" default that isn't actually exempt exposes the seller to statutory liability.
6. **36-11 / POA disclosure generally** — Texas Property Code §207.003/§5.012 statutory notice obligations sit underneath this addendum; getting "is/is not subject to mandatory POA membership" wrong on the base contract (Para. 6E(2) on 20-19) is a disclosure failure independent of whether the addendum itself was attached.
7. **Commercial transactions generally** — no TREC promulgated form covers them; any DossieSign feature that implies TREC-form coverage for a commercial deal is misleading by omission.

---

## 6. Not Verified This Session — do not hardcode without re-checking

- Full page counts / complete field layout for **24-20** (New Home, Completed Construction), and full layout beyond page 1 for **23-20, 25-17, 9-18, 30-18**.
- **T-47.1 Declaration** — could not locate/download the current PDF this session (404s on guessed URLs); notarization-free status is carried over from general professional knowledge, not confirmed today.
- **All TXR (Texas REALTORS)-exclusive forms** — `texasrealestate.com/forms-library` is member-login-gated (redirects to Auth0 SSO); I could not pull the current TXR forms list or any individual TXR form this session. TXR forms cover listing agreements, buyer/tenant representation agreements, property management agreements, commercial contracts, and 100+ other member-exclusive forms per Texas REALTORS' own marketing copy ("130+ forms not available elsewhere"). **Given Heath already has working zipForm credentials** (see memory: zipform-credential-login.md), the fastest path to a verified TXR inventory is pulling the live form list from inside zipForm via browser automation, not guessing form numbers from memory. I deliberately did not list specific TXR form numbers in this document because I could not verify them against a primary source, and getting a form number wrong in a legal-execution reference is worse than leaving it blank.
- Exact §5.008 exemption list for the Seller's Disclosure Notice (new construction, foreclosure/trustee sales, certain transfers) — I referenced the general categories from professional knowledge; the precise statutory text should be pulled and attorney-confirmed before it drives a skip-logic gate.
- Item 4's "This form replaces TREC No. 20-18" language is my strongest, most directly-sourced confirmation in this whole document (read directly off the current PDF's own footer) — treat that one as solid.

---

## Sources cited

- [trec.texas.gov/agency-information/contracts](https://www.trec.texas.gov/agency-information/contracts) — master forms index, scraped 2026-09-28
- [trec.texas.gov/sites/default/files/pdf-forms/20-19.pdf](https://www.trec.texas.gov/sites/default/files/pdf-forms/20-19.pdf) — downloaded and read in full, 2026-09-28
- [trec.texas.gov/sites/default/files/pdf-forms/39-11.pdf](https://www.trec.texas.gov/sites/default/files/pdf-forms/39-11.pdf) — downloaded and read in full, 2026-09-28
- [trec.texas.gov/sites/default/files/pdf-forms/36-11.pdf](https://www.trec.texas.gov/sites/default/files/pdf-forms/36-11.pdf) — downloaded and read in full, 2026-09-28
- [trec.texas.gov/sites/default/files/pdf-forms/55-1.pdf](https://www.trec.texas.gov/sites/default/files/pdf-forms/55-1.pdf) — downloaded and read in full, 2026-09-28
- [trec.texas.gov/sites/default/files/pdf-forms/40-11.pdf](https://www.trec.texas.gov/sites/default/files/pdf-forms/40-11.pdf) — downloaded and read in full, 2026-09-28
- [trec.texas.gov/sites/default/files/pdf-forms/25-17.pdf](https://www.trec.texas.gov/sites/default/files/pdf-forms/25-17.pdf) — page 1 read, 2026-09-28
- [trec.texas.gov/sites/default/files/pdf-forms/9-18.pdf](https://www.trec.texas.gov/sites/default/files/pdf-forms/9-18.pdf) — page 1 read, 2026-09-28
- [trec.texas.gov/sites/default/files/pdf-forms/23-20.pdf](https://www.trec.texas.gov/sites/default/files/pdf-forms/23-20.pdf) — page 1 read, 2026-09-28
- [trec.texas.gov/sites/default/files/pdf-forms/30-18.pdf](https://www.trec.texas.gov/sites/default/files/pdf-forms/30-18.pdf) — page 1 read, 2026-09-28
- [trec.texas.gov/sites/default/files/pdf-forms/56-0.pdf](https://www.trec.texas.gov/sites/default/files/pdf-forms/56-0.pdf) — downloaded and read in full, 2026-09-28
- [trec.texas.gov/sites/default/files/pdf-forms/38-8.pdf](https://www.trec.texas.gov/sites/default/files/pdf-forms/38-8.pdf) — downloaded and read in full, 2026-09-28
- [trec.texas.gov/sites/default/files/pdf-forms/50-0.pdf](https://www.trec.texas.gov/sites/default/files/pdf-forms/50-0.pdf) — downloaded and read in full, 2026-09-28
- [trec.texas.gov/forms/information-about-brokerage-services](https://www.trec.texas.gov/forms/information-about-brokerage-services) — scraped 2026-09-28
- [tdi.texas.gov/forms/form15.html](https://www.tdi.texas.gov/forms/form15.html) — scraped 2026-09-28
- [tdi.texas.gov/title/documents/formT-47.pdf](https://www.tdi.texas.gov/title/documents/formT-47.pdf) — downloaded and read in full, 2026-09-28
- `texasrealestate.com/forms-library` — attempted, blocked by member login (Auth0 SSO redirect), not accessible this session

---

*Next step if this is going to drive an actual field-mapping build: (1) get a licensed TX real estate attorney to review §3 (handwritten changes) and the §5 flagged items before they become hard gates; (2) re-pull 24-20 and finish full verification of 23-20/25-17/9-18/30-18; (3) get TXR's live form list via zipForm rather than the public site.*
