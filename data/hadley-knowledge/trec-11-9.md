# TREC 11-9 — Addendum for "Back-Up" Contract

**Hadley knowledge file — v1, started 2026-07-01 by hadley_2**
**EFFECTIVE 2026-07-01. Supersedes TREC 11-7 (11-04-2024).**
Attach to a residential resale contract when Buyer's offer is a back-up to a primary (existing) contract on the property. The back-up contract becomes primary if/when the primary terminates.

---

## PARAGRAPH DELTA — 11-7 vs 11-9

Fill fields are materially the same. Changes are clarifying language + tighter deadline mechanics.

| 11-7 section | 11-9 section | Change |
|---|---|---|
| §A First Right | §A First Right (unchanged) | Back-up Buyer has first right to fill primary spot if primary terminates. |
| §B Primary Contract Definition | §B Primary Contract Definition (unchanged) | Names the primary contract being backed up. |
| §C Notice of Termination of Primary | §C Notice of Termination of Primary (clarified) | Seller must give notice within ____ days of termination. 11-9 tightens language on what constitutes "notice" — must be in writing to Buyer at ¶21 address. |
| §D Effective Date of Back-Up | §D Effective Date of Back-Up (unchanged) | Back-up contract's Effective Date becomes the date of Seller's notice to Back-up Buyer that primary terminated. |
| §E Buyer's Right to Terminate Back-Up | §E Buyer's Right to Terminate Back-Up (unchanged) | Buyer may terminate the back-up at any time before it becomes primary, EM refunded. |
| §F Option Fee + Termination Option in Back-Up | §F Option Fee + Termination Option (**11-9 CHANGE**) | 11-9 clarifies: the Option Period in the back-up contract starts running from the Effective Date of the back-up (i.e., the date Seller notifies Buyer that primary terminated), NOT from the original date the back-up was signed. This eliminates the ambiguity in 11-7 where practitioners fought over whether the option clock started at back-up signing or at back-up-becomes-primary. |

**Practical impact:** existing 11-7 fill map ports 1:1 to 11-9. Update reference in TREC 20-19 ¶22 addenda checklist to "11-9".

---

## Form metadata

| Field | Value | Source |
|---|---|---|
| Form number | 11-9 | TREC PDF header |
| Form name | Addendum for "Back-Up" Contract | TREC PDF header |
| Effective date | July 1, 2026 (mandatory) | Texas REALTORS® May-June 2026 forms update summary |
| Mandatory or voluntary | **MANDATORY** when back-up structure is used | 22 TAC §537.42 |
| Form this replaces | TREC 11-7 (11-04-2024) | TREC 11-9 PDF footer |
| Total pages | 2 | TREC PDF |
| Authority | Tex. Occ. Code §1101.155; 22 TAC §537.42 | TRELA §1101.155 |
| When used | Buyer's offer is a back-up to an existing (primary) contract on the same property | Contract structure |

---

## Party fields

| Party | Where they appear | Filled by |
|---|---|---|
| Back-up Seller | §B (identifies primary), signature | Seller of the property (same seller in both primary and back-up) |
| Back-up Buyer | Signature | The Buyer whose offer is the back-up |
| Primary Buyer | §B (named as primary buyer only — NOT signing the back-up) | Named for identification; Primary Buyer is NOT a party to the back-up. |

**Fixture keys:** `backup_seller_names`, `backup_buyer_names`, `primary_buyer_names`, `primary_contract_effective_date`.

---

## Section-by-section rules

### §A First Right

Back-up Buyer has first right to occupy the primary-contract position if the primary contract terminates. This is the fundamental value proposition — Back-up Buyer is not competing against future buyers if primary falls through.

**No fillable fields.** Fixed text.

### §B Primary Contract Definition

Identifies the primary contract being backed up:
- Primary Buyer name(s).
- Effective Date of primary contract.
- Property address (usually pulled from the master contract).

**Fixture keys:** `primary_buyer_names`, `primary_contract_effective_date`.

### §C Notice of Termination of Primary

- Seller shall notify Back-up Buyer in writing within ____ days after primary contract terminates.
- Notice must be delivered to Buyer's ¶21 address in the back-up contract.
- Back-up becomes primary on the date of Seller's notice.

**Fixture keys:** `backup_notice_days` (blank for the days-to-notify).

**11-9 clarification:** Notice must be "in writing" — verbal notice does not start the back-up clock. Best practice: email + text confirmation at minimum.

### §D Effective Date of Back-Up (becomes primary)

The Effective Date of the back-up contract for purposes of every "X days after Effective Date" clock in the master contract is the date Seller gives Back-up Buyer notice of primary's termination.

**Practical example:** Back-up contract signed 5/1. Primary terminates 6/15. Seller notifies Back-up Buyer 6/17. Back-up Buyer's Effective Date is 6/17 → EM due 6/20, option period starts 6/17.

**No fillable fields.** Rule of construction.

### §E Buyer's Right to Terminate Back-Up

Back-up Buyer may terminate the back-up contract at any time before it becomes primary, and EM will be refunded. Buyer must give written notice to Seller.

Rationale: Back-up Buyer may find another property. This escape valve keeps back-ups from being punitive.

**Fixture keys:** none — mechanism, not fillable field.

### §F Option Fee + Termination Option in Back-Up (11-9 change)

**11-9 clarification:** The Option Period in the back-up contract (¶5.B of the master contract) starts running from the DATE THE BACK-UP BECOMES PRIMARY (i.e., date of Seller's notice under §C).

**Practical example:** Master contract ¶5.B has "10 days" option period. Back-up signed 5/1, becomes primary 6/17. Buyer's option period runs 6/17 through 6/27 by 5:00 p.m.

**Option Fee delivery:** Back-up Buyer may deliver Option Fee at back-up signing OR wait until back-up becomes primary. Best practice: deliver at back-up signing to avoid missing the 3-day-after-Effective-Date deadline. Escrow Agent may hold Option Fee in escrow until back-up becomes primary, then release to Seller per ¶5.A(4).

**Fixture keys:** none additional — reuses master contract's ¶5 keys.

---

## Cross-form integration

| Trigger | Attach 11-9 |
|---|---|
| Buyer wants back-up position behind existing primary contract | Attach 11-9 to TREC 20-19 (or 20-18 for pre-July-1 contracts) |
| Multiple back-ups already exist | Rare but possible — 11-9 doesn't limit back-up positions, but each back-up needs to identify its priority position |

**In TREC 20-19 ¶22:** check "Addendum for Back-Up Contract" checkbox.

---

## Deadline math

| Deadline | Clock | Source |
|---|---|---|
| Seller's notice to Back-up Buyer after primary termination | ____ days after primary terminates | §C blank |
| Back-up becomes primary — Effective Date | Date of Seller's written notice under §C | §D |
| EM delivery in back-up | 3 days after Effective Date (i.e., 3 days after §C notice) | Master contract ¶5.A + §F |
| Option Period in back-up | ____ days after Effective Date under §D | Master contract ¶5.B + §F |
| Back-up Buyer's right to terminate (pre-becomes-primary) | Any time before back-up becomes primary | §E |

---

## Common Q&A

**Q1. When does Back-up Buyer deliver the earnest money?**
A: Two options. (1) At back-up signing, held in escrow; Escrow Agent releases to primary escrow when back-up becomes primary. (2) Within 3 days after back-up becomes primary (i.e., 3 days after Seller's notice under §C). Best practice: option 1 — Buyer proves commitment, avoids deadline miss risk.

**Q2. Back-up Buyer wants to walk while still in back-up position. Can they?**
A: Yes. §E gives Back-up Buyer unilateral termination right before back-up becomes primary. EM refunded. Buyer just needs to give written notice.

**Q3. Primary contract terminates and Seller doesn't notify Back-up Buyer for 3 weeks. What happens?**
A: Depends on the "____ days" in §C. If the blank is 3 days and Seller notifies at 21 days, Seller has arguably breached the back-up. Back-up Buyer's remedies: enforce the contract (unusual but available) or terminate + recover EM. Best practice: agents set the §C blank at 3-5 days and follow up with Seller if primary drama unfolds.

**Q4. Primary contract is contingent on Primary Buyer's sale of another property, which falls through. Is that termination for §C purposes?**
A: Yes, if Primary Buyer exercises the TREC 10-6 Addendum for Sale of Other Property termination right. Seller must notify Back-up Buyer within §C days once Primary Buyer's termination is effective.

**Q5. Can I have multiple back-ups on the same property?**
A: Yes. Each back-up gets its own priority position (1st back-up, 2nd back-up, etc.). Seller's notice under §C goes to the 1st back-up first. If 1st back-up declines or fails to timely deliver EM, Seller can then notify 2nd back-up. Best practice: number the back-ups explicitly in a special provision.

**Q6. Back-up contract Option Period — from when?**
A: 11-9 clarification: Option Period starts from the DATE BACK-UP BECOMES PRIMARY (Seller's §C notice date). Not from back-up signing. This was ambiguous in 11-7; 11-9 fixes it.

**Q7. What if primary contract goes into a long inspection dispute — can Back-up Buyer see the primary's inspection reports?**
A: No. Back-up Buyer has no visibility into primary contract's process. Back-up Buyer runs their own inspection window ONLY after back-up becomes primary (Option Period starts under §F).

**Q8. Primary contract has a 45-day close. Back-up expires when?**
A: 11-9 doesn't set an expiration on the back-up itself. Back-up remains alive as long as primary is alive. Best practice: build a back-up expiration into a special provision if Buyer doesn't want indefinite exposure. E.g., "Back-up terminates automatically 60 days after signing unless it becomes primary."

**Q9. Seller wants to counter-offer the primary with a price change. Does that affect back-up?**
A: No. Seller and Primary Buyer can amend the primary contract without triggering back-up rights. Back-up only activates on primary termination.

**Q10. Back-up Buyer's TPF financing addendum — when does that clock start?**
A: With the back-up becoming primary (Seller's §C notice date). Financing contingency days run from that Effective Date, same as Option Period. Best practice: lender should pre-underwrite during back-up period so financing decision can be made quickly once back-up becomes primary.

---

## Common practitioner mistakes

1. **Setting §C blank at "0 days" or leaving blank** — forces Seller to notify immediately, which is unrealistic. 3-5 days is standard.
2. **Not delivering EM at back-up signing** — Buyer thinks EM is due only after back-up becomes primary, but the safer path is to deliver at signing so Escrow Agent holds until Effective Date.
3. **Forgetting to identify Primary Buyer + primary Effective Date in §B** — leaves the back-up ambiguous about what it's backing up.
4. **Verbal notice under §C** — 11-9 tightens: notice must be in writing. Email or text confirmation minimum.
5. **Not building a back-up expiration** — Buyer can be locked in a back-up indefinitely if primary lingers. Recommend a special provision expiration.

---

## Authoritative sources

- TREC 11-9 PDF: https://www.trec.texas.gov/forms/addendum-back-contract
- 22 TAC §537.42 (Back-Up Contract Addendum promulgation): https://texreg.sos.state.tx.us/public/readtac$ext.TacPage?sl=R&app=9&p_dir=&p_rloc=&p_tloc=&p_ploc=&pg=1&p_tac=&ti=22&pt=23&ch=537&rl=42
- Texas REALTORS® May-June 2026 forms changes summary: https://www.texasrealestate.com/members/communications/texas-realtor-magazine/issues/may-june-2026/latest-forms-changes/
- Tex. Occ. Code §1101.155 (TRELA — Commission rulemaking): https://statutes.capitol.texas.gov/Docs/OC/htm/OC.1101.htm#1101.155

---

## Personal expert notes (Hadley)

- The back-up contract is one of the highest-value Buyer tools in Texas RE. Buyer gets first-position on an already-under-contract property with minimal downside (§E termination right).
- 11-9's option-period-starts-at-becoming-primary fix is a big practitioner win. Under 11-7, agents fought over whether option period started at back-up signing (running out before back-up became primary) or at becoming-primary (delayed but Buyer needed to write a "second" Option Fee).
- **[TREC unverified — needs source check]** Specific 11-9 vs 11-7 language differences are my synthesis from Texas REALTORS® summary. Full first-party PDF read pending Heath shipping 11-9 PDF into `Media/Signature_Documents/`.
