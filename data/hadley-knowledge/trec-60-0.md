# TREC 60-0 — Addendum for Section 1031 Exchange

## Header

| Field | Value |
|---|---|
| Full title | Addendum for Section 1031 Exchange |
| Form number | TREC No. 60-0 |
| Replaces | (Original 60 — no prior version) |
| Promulgation date printed on form | 11-04-2024 |
| Statutory basis | Section 1031 of the Internal Revenue Code (federal), as amended |
| Mandatory or voluntary | Mandatory when applicable (promulgated) |
| Trigger to attach | Buyer OR Seller intends to use the Property to accomplish an exchange of like-kind properties under IRC §1031 |
| Who signs | Buyer(s) AND Seller(s) |
| One-line summary | Announces one party's intent to structure the transaction as part of a §1031 like-kind exchange and obligates the non-exchanging party to reasonably cooperate, PROVIDED the non-exchanging party incurs no additional expense/liability AND closing is not delayed. |

**Source:** TREC 60-0 PDF (11-04-2024 promulgation) at `trec.texas.gov/sites/default/files/pdf-forms/60-0.pdf`.

## Paragraph-by-paragraph rules

### ¶A — Party identification (Check ONE box)
"[ ] Seller [ ] Buyer intends to use this Property to accomplish an exchange of like-kind properties under Section 1031 of the Internal Revenue Code, as amended."

Mutually exclusive: only ONE party is doing the §1031 exchange in a given transaction. If BOTH parties are doing exchanges (mutual §1031 — rare but possible), a separate special provision or attorney-drafted amendment is more appropriate.

### ¶B — Cooperation obligation of the non-exchanging party
"The parties will reasonably cooperate to accomplish the exchange provided:
(i) the non-exchanging party will not incur any additional expense or liability; AND
(ii) closing will not be delayed as a result of the exchange."

Two hard limitations on cooperation:
1. No additional cost to the non-exchanging party (they can't be forced to pay QI fees, assignment costs, etc.).
2. No closing delay (the exchange can't push out the closing date).

## Deadline math

The FORM ITSELF contains no day-count deadlines. However, §1031 EXCHANGE deadlines (federal IRC) govern the exchanging party's planning:

| §1031 deadline | Clock | Trigger |
|---|---|---|
| Identification period | 45 calendar days | Sale of relinquished property |
| Exchange period (must acquire replacement) | 180 calendar days OR tax return due date (including extensions), whichever is earlier | Sale of relinquished property |

These are FEDERAL statutory windows (IRC §1031(a)(3), Treasury Reg. §1.1031(k)-1). They apply to the exchanging party even though not printed on TREC 60-0.

Practical: the exchanging party has 45 days from closing on the relinquished property to IDENTIFY (in writing to a Qualified Intermediary) up to 3 potential replacement properties (or more under alternative identification rules — 200% rule, 95% rule), and 180 days total to close on one or more of those identified properties.

## Common Q&A a working TX agent would ask

**Q1. What is a §1031 exchange in plain English?**
A. A federal tax deferral mechanism. A taxpayer sells investment/business real property (the "relinquished property"), and instead of paying capital gains tax on the sale, they reinvest the proceeds into another investment/business real property (the "replacement property") within specific timelines. Done correctly, capital gains tax is deferred. The exchange requires a Qualified Intermediary (QI) to hold proceeds — the taxpayer can NEVER touch the money.

**Q2. Can primary residences use §1031?**
A. NO. §1031 applies only to real property "held for productive use in a trade or business or for investment." Primary residences don't qualify. Vacation homes typically don't qualify unless treated as rental investment (Revenue Procedure 2008-16 safe harbor). Personal-use property → no §1031. (IRC §1031(a).)

**Q3. What are the 45-day and 180-day deadlines?**
A. From closing on the relinquished property:
- 45 days to IDENTIFY replacement property(ies) in writing to the QI.
- 180 days (or tax return due date, whichever is earlier) to CLOSE on replacement property.
Both clocks run concurrently and start on the SAME day. Miss either = exchange fails and tax is due. Not printed on TREC 60-0 but critical for the exchanging party. (IRC §1031(a)(3); Treas. Reg. §1.1031(k)-1.)

**Q4. What does "reasonably cooperate" mean for the non-exchanging party?**
A. Sign documents required by the QI (typically an assignment of the contract to the QI + acknowledgment). Attend closing at the arranged time. Nothing more. The non-exchanging party CANNOT be forced to (a) accept additional risk, (b) pay extra costs, or (c) delay closing per ¶B. If the QI's paperwork tries to impose additional liability (rare but happens), the non-exchanging party can refuse.

**Q5. Does the non-exchanging party pay any exchange costs?**
A. No. ¶B(i) explicitly protects them from "any additional expense or liability." The QI fee, assignment fee, escrow fees related to the exchange structure — all on the exchanging party. Non-exchanging party pays only their normal ¶12 expenses.

**Q6. Buyer just discovered Seller is doing a §1031. Does Buyer have a right to object?**
A. Not if ¶B's conditions are met. Buyer must reasonably cooperate. Buyer's only legitimate objection is if the exchange (a) adds cost, (b) delays closing, or (c) introduces liability. Otherwise Buyer signs the QI assignment documents and moves forward. Best practice: attach 60-0 to the initial offer so Buyer isn't surprised at closing.

**Q7. Can we do a reverse §1031 (acquire replacement first, sell relinquished later)?**
A. Yes — via a "reverse exchange" using an Exchange Accommodation Titleholder (EAT). Same 180-day deadline runs from the acquisition of the replacement property (or the reverse — depends on parking structure). TREC 60-0 doesn't distinguish forward vs reverse exchanges; the addendum simply announces intent. Reverse exchanges are more complex and generally require specialized QI/EAT services. (Rev. Proc. 2000-37.)

**Q8. What if the exchange fails mid-transaction?**
A. Failure of the §1031 doesn't affect the TREC contract — the sale still closes at the negotiated price. The exchanging party just doesn't get tax deferral and pays the capital gains. This is why the exchanging party must have back-up plans (Section 1031 boot handling, planning for partial deferral, etc.). TREC 60-0 imposes no penalty on either party for exchange failure.

**Q9. Do we need a Qualified Intermediary?**
A. YES for a standard §1031 (deferred exchange). The taxpayer cannot touch the sale proceeds — they must go through the QI. The QI receives sale proceeds, holds them, and disburses to buy replacement property. Without a QI, the exchange fails on constructive receipt grounds. Common Texas QIs include IPX1031, First American Exchange, and Investment Property Exchange Services (IPX).

**Q10. Does 60-0 apply if only Buyer is doing the exchange (buying replacement)?**
A. Yes — check the "Buyer" box in ¶A. From Buyer's perspective, Buyer needs to acquire the Property within their 180-day exchange window. Seller's cooperation obligation is minimal — sign the QI assignment doc, close on time. Buyer's QI handles the exchange mechanics.

## Notes for the fill engine (Dossie internal)

- ¶A paired mutually-exclusive checkboxes → `exchange_party` (values: seller / buyer)
- Two Buyer, two Seller signature lines
- No date fields in signature block
- No dollar or day-count fields on the form face

## Authoritative + interpretive sources

- Form PDF: https://www.trec.texas.gov/sites/default/files/pdf-forms/60-0.pdf
- TREC form page: https://www.trec.texas.gov/forms/addendum-section-1031-exchange
- 26 U.S.C. §1031 — Internal Revenue Code
- 26 CFR §1.1031(k)-1 — Treasury Regulations (deferred exchange rules)
- Rev. Proc. 2000-37 — Reverse exchange safe harbor
- Rev. Proc. 2008-16 — Vacation home / mixed-use safe harbor
- Federation of Exchange Accommodators (FEA) — industry group / QI directory: 1031.org

## Auto-draft sourcing note

Paragraph rules are direct from the codified TREC 60-0 PDF text (11-04-2024). Q&A pairs are model-generated based on the paragraph rules + federal §1031 framework:
- Q2 primary-residence exclusion — IRC §1031(a); TREC unverified as form-referenced but statutorily correct.
- Q3 45/180-day deadlines — IRC §1031(a)(3); NOT printed on the form itself.
- Q7 reverse exchange framework — Rev. Proc. 2000-37; NOT on the form.
- Q9 QI providers — market observation; TREC unverified as form-referenced.
