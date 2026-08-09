# Citation trail — new TREC guide page, batch 13 (2026-08-08/09)

One new guide: TRID's (TILA-RESPA Integrated Disclosure) three-trigger rule for the Closing
Disclosure's mandatory 3-business-day waiting period. This is **federal law**, not a TREC or
Texas-specific rule — it governs the mortgage lender's Closing Disclosure (CD), not the TREC
contract itself. It's included in the TREC guides library because it directly affects how a TC
builds a closing timeline around ¶ 9 of a TREC contract: a change late in the process can blow up
a scheduled closing date, and most agents/TCs believe (wrongly) that *any* CD edit resets the
3-day clock. The prior deep-research pass flagged 12 CFR § 1026.19(f)(2) as the actual rule and
this pass independently re-verified the primary source text rather than trusting that summary
secondhand.

**Primary source and how it was reached:** `eCFR.gov`'s direct URL for 12 CFR Part 1026 redirects
(302) to `unblock.federalregister.gov`, an interstitial/bot-check page — consistent with JS-wall
problems seen on other government sites, this one on the federal side rather than Texas state
sites. Rather than fight that wall, went to `law.cornell.edu/cfr/text/12/1026.19` (Cornell Legal
Information Institute — LII mirrors the official CFR text verbatim, not a summary/paraphrase site)
and `law.cornell.edu/cfr/text/12/1026.2` for the "business day" and "consummation" definitions.
Cross-checked the (a)(6)(ii) specific "business day" definition's list of which sections it applies
to (confirming § 1026.19(f)(1)(ii) and (f)(1)(iii) are on that list) against the CFPB's own
regulation viewer, `consumerfinance.gov/rules-policy/regulations/1026/2/` — a second, independent
federal source (Consumer Financial Protection Bureau, the agency that authored and enforces
Regulation Z / TRID), not just a second copy of the same LII mirror.

---

## trid-closing-disclosure-three-day-rule-guide.json — 12 CFR § 1026.19(f) (Regulation Z / TRID)

| Claim | Source |
|---|---|
| § 1026.19(f)(2)(i) — general rule: if the CD becomes inaccurate before consummation, creditor must provide a corrected CD so the consumer receives it "at or before consummation" (no new waiting period), except as provided in (f)(2)(ii), verbatim | law.cornell.edu/cfr/text/12/1026.19, paragraph (f)(2)(i) |
| § 1026.19(f)(2)(ii)(A) — new 3-day wait required if "the annual percentage rate disclosed under § 1026.38(o)(4) becomes inaccurate, as defined in § 1026.22," verbatim | Same source, (f)(2)(ii)(A) |
| § 1026.19(f)(2)(ii)(B) — new 3-day wait required if "the loan product is changed, causing the information disclosed under § 1026.38(a)(5)(iii) to become inaccurate," verbatim | Same source, (f)(2)(ii)(B) |
| § 1026.19(f)(2)(ii)(C) — new 3-day wait required if "a prepayment penalty is added, causing the statement regarding a prepayment penalty required under § 1026.38(b) to become inaccurate," verbatim | Same source, (f)(2)(ii)(C) |
| § 1026.19(f)(1)(ii)(A) — general timing rule: creditor "shall ensure that the consumer receives the disclosures required under paragraph (f)(1)(i) of this section no later than three business days before consummation," verbatim, with its own cross-referenced exceptions to (f)(2)(i) etc. | Same source, (f)(1)(ii)(A) |
| § 1026.19(f)(1)(iii) — mailbox-rule presumption: if the CD is "not provided to the consumer in person, the consumer is considered to have received the disclosures three business days after they are delivered or placed in the mail," verbatim (this is a rebuttable presumption — actual documented earlier receipt, e.g. an e-sign timestamp, controls) | Same source, (f)(1)(iii) |
| § 1026.2(a)(6)(i) — general "business day" definition: "a day on which the creditor's offices are open to the public for carrying on substantially all of its business functions," verbatim | law.cornell.edu/cfr/text/12/1026.2, (a)(6)(i) |
| § 1026.2(a)(6)(ii) — specific "business day" definition used for the CD waiting period: "all calendar days except Sundays and the legal public holidays specified in 5 U.S.C. 6103(a)," verbatim, and confirmed this specific (not the general) definition is the one that governs § 1026.19(f)(1)(ii) and (f)(1)(iii) | Cross-checked on two independent sources: law.cornell.edu/cfr/text/12/1026.2 AND consumerfinance.gov/rules-policy/regulations/1026/2/ (CFPB's own regulation viewer — the agency that wrote/enforces Reg Z), both list § 1026.19(f)(1)(ii) and (f)(1)(iii) among the sections using the (a)(6)(ii) specific definition |
| § 1026.2(a)(13) — "consummation" defined as "the time that a consumer becomes contractually obligated on a credit transaction," verbatim — i.e., loan-document signing, not deed recording/funding | law.cornell.edu/cfr/text/12/1026.2, (a)(13) |
| Federal legal holidays under 5 U.S.C. 6103(a) named as examples (New Year's, MLK Day, Washington's Birthday, Memorial Day, Independence Day, Labor Day, Columbus Day, Veterans Day, Thanksgiving, Christmas) | Quoted directly within the (a)(6)(ii) text pulled from law.cornell.edu/cfr/text/12/1026.2 |

**Scope note stated explicitly in the guide, not left implicit:** TRID/Regulation Z applies to
*closed-end consumer credit transactions secured by real property* — i.e., most purchase-money
mortgages and many refinances. It does not apply to cash transactions (no lender, no CD at all —
a Texas cash deal only has ¶ 9A's contractual closing date, no federal waiting period), and does
not extend the way stated here to open-end credit (HELOCs use different Reg Z disclosures, not the
integrated CD). This is federal law, not a TREC or Texas Insurance/Property Code rule, so it applies
nationwide — the guide frames it for a TX audience by connecting the CD waiting period to the
closing-date mechanics of TREC ¶ 9A and the financing addenda (TREC 40-11 etc.), not by claiming
Texas has its own separate version of the rule.

**Flagged as ambiguous / left to the reader's own lender coordination, intentionally not resolved
in the guide:** the regulation does not specify who is responsible for tracking the CD delivery
timestamp on a given file (lender/closer normally owns this, not the listing or buyer's agent) —
the guide states this is the lender's/closer's compliance obligation, not something a TC or agent
executes, and frames its practical value as "know when to expect a closing date might move versus
when a routine correction is happening in the background with no closing impact."

**Not flagged as ambiguous — confirmed clean on direct comparison of both fetches:** the
three-trigger list in (f)(2)(ii)(A)-(C) matches exactly what the prior deep-research pass reported
(APR tolerance, loan product change, prepayment penalty addition) — independently re-verified
against primary text rather than re-used from that summary.
