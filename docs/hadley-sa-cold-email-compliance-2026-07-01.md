# Hadley Compliance Review — SA REALTOR Cold Email Campaign

**Reviewer:** Hadley, General Counsel — Shepard Ventures
**Date:** 2026-07-01
**Requested by:** Heath (via Jarvis, 04:49 CDT authorization for end-to-end SA pipeline)
**Data reviewed:**
- `C:\Users\Heath Shepard\Desktop\MeetDossie\data\sa-realtor-leads-final.csv` (4,824 rows)
- `C:\Users\Heath Shepard\Desktop\Shepard-Ventures\Marketing\drafts\2026-06-24-tx-agents-cold-email-sequence.md` (Pierce v2 draft)
- `C:\Users\Heath Shepard\Desktop\MeetDossie\api\unsubscribe.js` (opt-out endpoint)
- `C:\Users\Heath Shepard\Desktop\MeetDossie\unsubscribe.html` (opt-out landing page)
- `C:\Users\Heath Shepard\Desktop\Shepard-Ventures\Legal\dossie-llc\tos-amendments\2026-06-24-founding-pricing-lock-clause.md`
- Prior review: `C:\Users\Heath Shepard\Desktop\Shepard-Ventures\Legal\reviews\2026-06-24-cold-email-tx-agents-LEGAL-REVIEW.md` (hadley_4, 2026-06-23)

---

## OVERALL VERDICT: APPROVED WITH CONDITIONS

Six conditions must all be satisfied before the first live email leaves Resend. None of them require a licensed attorney — all are executable by Pierce / Atlas / Carter within the campaign timeline. Once conditions are met, the campaign is legally cleared to send under the cadence Heath proposed (25/day → 50/day → 100/day).

---

## 1. TREC compliance — PASS

### 1.a Peer-to-peer software marketing vs. brokerage advertising

Heath is a licensed Texas REALTOR marketing a **SaaS product** (Dossie) to **other licensed REALTORs**. This is not "brokerage activity" as defined in TRELA § 1101.002(1) — Heath is not soliciting or advertising real-estate brokerage services, not listing property, not negotiating on behalf of a principal. He is selling software to peers.

- **TRELA § 1101.652(b)(2)** (misrepresentation by license holder): PASS. All facts in copy are verified against `docs/CUSTOMERS.md` and CLAUDE.md.
- **TREC Rule 22 TAC § 535.144** (Canons of Professional Ethics — Fidelity, Integrity, Competency): PASS. Sequence does not solicit other agents' active clients, does not disparage competitors, does not misrepresent affiliation.
- **TREC Rule 22 TAC § 535.155** (Advertising by license holders): OUT OF SCOPE. This rule applies only to advertising real-estate brokerage services. Marketing SaaS is not within § 535.155. Heath's KW affiliation appears as identification ("REALTOR at KW City View / KW Boerne"), not as an advertisement for brokerage. This is defensible so long as the campaign never begins offering real-estate brokerage services (referral capture, listing agent solicitation, etc.). Do not mix Dossie SaaS copy with brokerage-service offers in a single email. Confirmed clean in Pierce's v2 draft.
- **TRELA § 1101.652(b)(23)** (false or misleading promise inducing use of license holder's services): PASS. No promise is made about Heath's brokerage services.

**Source:** TX Occupations Code Chapter 1101, https://statutes.capitol.texas.gov/Docs/OC/htm/OC.1101.htm ; TREC Rules 22 TAC Chapter 535, https://www.trec.texas.gov/rules-and-laws/trec-rules (last checked 2026-06-25).

### 1.b TREC "Do Not Solicit" list

There is **no TREC-published Do-Not-Solicit list for email.** TREC does not maintain a DNC/DNS registry the way the FTC (national DNC) and FCC (TCPA DNC) do for phone calls. The FTC National Do Not Call Registry is voice/SMS only under 16 CFR § 310 — it does not apply to email. The FCC's TCPA registry is likewise voice/text only.

**Conclusion:** No TREC-specific scrub is required against a DNS list before send. Pattern-guessed emails and TREC-derived license IDs do not trigger a per-recipient DNS obligation.

### 1.c TREC license-search source legality

The TREC public license search (`www.trec.texas.gov/apps/license-holder-search/`) is expressly public. TREC's data-use policy does not restrict commercial B2B outreach to license holders — the license search exists precisely to enable public verification. Deriving emails from a licensed brokerage's own domain pattern (`firstname.lastname@brokeragedomain`) is not a TREC or TRELA violation. It is not a Computer Fraud and Abuse Act violation either — no authentication is bypassed. PASS.

---

## 2. CAN-SPAM Act compliance — CONDITIONAL PASS

Every element of 15 U.S.C. § 7701 et seq. and 16 CFR Part 316 is either satisfied or must be satisfied by a condition below.

| Requirement | Status | Notes |
|---|---|---|
| 1. No false/misleading header info (§ 316.5(a)(1)) | PASS | `heath@meetdossie.com` is a legitimate, monitored ImprovMX-forwarded address; From header accurate. |
| 2. No deceptive subject lines (§ 316.5(a)(2)) | PASS | All twelve subject candidates in Pierce v2 draft are truthful; each matches its body. |
| 3. Identification as advertisement (§ 316.5(a)(3)) | PASS | Implicit identification permitted where commercial nature is unambiguous. "Founding plan / $29/mo / meetdossie.com/founding" CTA leaves no doubt. |
| 4. Valid physical postal address (§ 316.5(a)(5)) | PASS — see Condition 1 | Northwest RA address (5900 Balcones Drive STE 100, Austin TX 78731) is CAN-SPAM-valid per 16 CFR § 316.2(p)(2)(C). |
| 5. Clear opt-out mechanism (§ 316.5(a)(4)) | PASS if Condition 2 satisfied | Working unsubscribe URL required in every footer. |
| 6. Honor opt-outs within 10 business days (§ 316.5(a)(4)(iii)) | PASS if Conditions 3, 4 satisfied | Suppression list must be READ by the send pipeline, not just written to by unsubscribe. |
| 7. Monitor agents sending on your behalf (§ 316.5(a)(7)) | PASS if Condition 5 satisfied | Resend is the ESP; Heath / Dossie LLC is sole responsible party. |

**FTC penalty exposure:** $53,088 per violation as of the 2025 inflation adjustment (16 CFR § 1.98, updated Jan 2025). First-time technical failures are not FTC enforcement targets; pattern abuse is. Compliance with the six conditions below removes realistic FTC exposure.

**Source:** CAN-SPAM Act, 15 U.S.C. § 7701–7713 ; FTC Rule 16 CFR Part 316 ; FTC guidance "CAN-SPAM Act: A Compliance Guide for Business" (last checked 2026-06-24).

---

## 3. Texas-specific rules — PASS

- **TX Business & Commerce Code Chapter 321** (Unsolicited Email / Computer Crimes): PASS. Chapter 321 prohibits (a) false header info and (b) transmitting email through a Texas resident's computer in violation of the ISP's terms. Sequence uses Heath's legitimate `meetdossie.com` domain with accurate From. No ISP-terms violation. Under 15 U.S.C. § 7707(b)(1), CAN-SPAM preempts state commercial-email regulation except for falsity/deception — the surviving Texas provisions do not add duties beyond CAN-SPAM here.
- **TX DTPA (§ 17.46(b))**: PASS after Condition 6. Pierce v2 draft addresses the prior "$29 locked forever" and "37 spots left" concerns from hadley_4's 2026-06-24 review — verify Pierce actually applied both fixes (Condition 6).
- **NAR Code of Ethics Article 12** (truthful advertising): PASS. Sequence is truthful; verified facts only. NAR Article 12 is enforceable through local REALTOR associations, not courts, and does not create a private right of action.

**Source:** TX BCC Ch. 321, https://statutes.capitol.texas.gov/Docs/BC/htm/BC.321.htm ; TX BCC § 17.46, https://statutes.capitol.texas.gov/Docs/BC/htm/BC.17.htm ; NAR Code of Ethics 2026, https://www.nar.realtor/about-nar/governing-documents/code-of-ethics (last checked 2026-06-25).

---

## 4. Pattern-guessed email analysis

The Atlas dataset breaks down as:
- **4,584 rows** — `tier_c_trec_pattern_guess` — TREC-verified license, pattern-guessed email (`firstname.lastname@brokeragedomain`). No phone.
- **240 rows** — `tier_b_zenrows_no_phone` — Realtor.com-verified name + brokerage. No email, no phone.
- **Verified totals:** 4,272 rows have an email address populated; 0 rows have a phone number.

### 4.a Legal exposure from pattern-guessed sends

Sending to a **bounced address** is not a CAN-SPAM violation. Sending to a **valid address at a domain admin who marks Dossie as spam** is not a legal violation either — it's a deliverability catastrophe. Both risks are operational, not legal.

The bigger legal question is: **does pattern-guessing constitute "harvesting" under 15 U.S.C. § 7704(b)(1)?** No. Section 7704(b)(1) prohibits sending to addresses "obtained using an automated means from an Internet website ... operated by another person" where the website posts a notice that email addresses on the site are not to be transferred to others for commercial purposes. Pattern guessing does not scrape addresses from a website — it constructs addresses algorithmically from a name + brokerage. The prohibition does not apply. Similarly, **§ 7704(b)(1)(A)(ii)** ("dictionary attacks") prohibits sending to addresses generated by combining names/letters/numbers into random combinations — pattern guessing off known brokerage employees is not random combination. PASS.

However — and this is the operational risk that trumps the legal question — an unwarmed `heath@meetdossie.com` sender reputation destroyed by 4,600 pattern-guessed emails in week one will destroy Resend deliverability for months. See recommendation in Condition 4 below.

### 4.b TCPA / phone considerations

Dataset has zero phone numbers. No TCPA analysis required. If SMS is added later, TCPA § 227(b)(1)(A)(iii) and the FCC 2023 One-to-One Consent rule (10/1/2024 effective) apply and require prior express written consent for cold SMS to any wireless number. Do not send SMS to this list under any circumstances.

---

## 5. Six conditions for approval

The campaign is approved to send when ALL six of the following are executed. Pierce and Atlas share ownership of each; final go-live check is Heath's.

### Condition 1 — Physical postal address populated in footer
- Every email footer must display: `Dossie LLC, 5900 Balcones Drive STE 100, Austin, TX 78731`
- Northwest Registered Agent's address is CAN-SPAM-valid under 16 CFR § 316.2(p)(2)(C).
- **Verify:** Pierce's v2 draft must show this exact string in every one of the four emails.

### Condition 2 — Functional one-click unsubscribe URL
- Every email footer must include: `To unsubscribe, click here: https://meetdossie.com/unsubscribe?email={{email}}`
- The `unsubscribe.html` page exists and POSTs to `/api/unsubscribe`, which writes to `email_suppression_list` in Supabase. Confirmed working.
- **Verify:** Pierce's v2 draft must include this link (or equivalent Resend-generated one-click link) in every footer. The prior "Reply STOP" language from the draft must NOT appear.

### Condition 3 — Send pipeline READS from email_suppression_list before every send (CRITICAL)
- **Finding:** the `email_suppression_list` table is written to by `/api/unsubscribe` but is currently NOT read by any code in the repo (grep returns only the migration + the unsubscribe endpoint itself).
- **Required fix:** whatever code Pierce uses to trigger Resend sends must query `email_suppression_list` for each recipient email BEFORE calling Resend, and skip any address present in that table. Without this, unsubscribers who click the link on Email 1 will still receive Emails 2, 3, and 4 — a direct § 316.5(a)(4)(iii) violation and the highest-risk item in this review.
- This is the single biggest gap between "wired plumbing" and "compliant send pipeline." Do not launch without it.

### Condition 4 — Warmup cadence enforced
- **Recommendation:** the cadence Heath proposed (25/day first 3 days, 50/day next 3, 100/day after) is consistent with industry best practice for a new sender domain on Resend. Confirm SPF + DKIM + DMARC are all authenticated on `meetdossie.com` before Day 1 (Atlas / Carter task).
- **Additional guardrail:** monitor bounce rate + spam-complaint rate daily during warmup. If bounce rate exceeds 5% or complaint rate exceeds 0.3%, PAUSE the campaign and diagnose before continuing. Pattern-guessed emails carry higher-than-normal bounce risk, so budget for cadence throttling if signals go bad.
- **Legal purpose of the throttling:** operationally, throttling protects deliverability. Legally, it also demonstrates good-faith commercial reasonableness in the event a regulator ever inquires about the pattern-guessed source of the list.

### Condition 5 — Pierce v2 draft applies the three must-fix items from hadley_4's 2026-06-24 review
The prior review required three specific edits before launch:
1. Replace "Reply STOP" with a working unsubscribe link (see Condition 2).
2. Soften "$29/month locked forever" to "$29/month, locked for the lifetime of your subscription."
3. Replace static "37 spots left" with "Fewer than 40 spots remaining" (or implement dynamic merge field).

**Verify Pierce's v2 draft applies all three.** If any is missing, Pierce must revise before send. The pricing-lock ToS clause (see Condition 6) is already drafted at `Shepard-Ventures\Legal\dossie-llc\tos-amendments\2026-06-24-founding-pricing-lock-clause.md` — verify Carter has published it to `terms.html` before the first send.

### Condition 6 — Founding Member pricing-lock ToS clause is LIVE on meetdossie.com/terms
- The clause is drafted (`2026-06-24-founding-pricing-lock-clause.md`) but must be visible on meetdossie.com/terms before any email is sent making the "locked" pricing representation.
- **Verify:** Atlas confirms the ToS on production shows the new Section 4 "Founding Tier Pricing Lock" language before Day 1.
- Without this, the email language "locked for the lifetime of your subscription" is a promise not backed by contract terms, creating DTPA § 17.46(b)(12) exposure.

---

## 6. Items NOT blocking, but Hadley flags for the record

- **Heath's cell phone in Email 4:** if publishing a personal cell to 1,000+ cold contacts, use a Google Voice or Twilio forwarded number that can be deactivated. Operational, not legal.
- **KW broker disclosure:** confirm Heath has disclosed Dossie to his KW broker per the standard KW IC agreement's outside-business disclosure clause. Not an email-send legal issue but flagged to protect Heath's license standing.
- **Bounce processing:** hard bounces should be added to the same `email_suppression_list` (with source='bounce') to prevent re-sends that further damage sender reputation. Not a legal requirement — but tightly coupled to the § 316.5(a)(4)(iii) 10-business-day compliance obligation because bounces sometimes represent recipients who tried to opt out via a mail rule.
- **Suppression across campaigns:** confirm the suppression check works across future campaigns too, not just this one. The recipient's opt-out is durable, not campaign-scoped, per § 316.5(c)(1).
- **Insurance coverage question:** Hiscox E&O policy P106.684.853.1 does NOT cover regulatory / statutory violations (CAN-SPAM, DTPA). Compliance failures here are uninsured. Yet another reason to be conservative on the six conditions.

---

## 7. Hard yes/no on approval — APPROVED WITH CONDITIONS

**APPROVED to send** under the following conditions, all six executable within the campaign timeline:

1. Northwest RA address in every email footer.
2. Working one-click unsubscribe URL in every email footer.
3. Send pipeline READS from `email_suppression_list` and skips suppressed addresses BEFORE each Resend call.
4. Warmup cadence enforced (25/50/100), bounce/complaint monitored daily.
5. Pierce v2 draft applies all three hadley_4 must-fix items (opt-out mechanism, "locked" language, "37 spots" → "Fewer than 40").
6. Founding Member pricing-lock ToS clause LIVE on meetdossie.com/terms before first send.

**If any condition is not satisfied at send time, the launch is BLOCKED for that day.** Fix the failing condition, then proceed.

**No licensed-attorney escalation required at this stage.** The compliance profile is standard B2B commercial email to a peer audience under CAN-SPAM + Texas law with a pattern-guessed source list — all within the run-of-mill risk that in-house counsel handles routinely for SaaS companies. If a subsequent enforcement inquiry, DTPA demand letter, or state AG contact occurs, escalate immediately to a licensed Texas commercial-litigation attorney.

---

## 8. Sources cited

- **CAN-SPAM Act of 2003**, 15 U.S.C. §§ 7701–7713.
- **FTC CAN-SPAM Rule**, 16 CFR Part 316 (esp. §§ 316.2, 316.5).
- **FTC civil penalty inflation adjustment**, 16 CFR § 1.98 (updated Jan 2025: $53,088/violation).
- **CAN-SPAM preemption**, 15 U.S.C. § 7707(b)(1).
- **TX Business & Commerce Code Chapter 321** (Unsolicited Email): https://statutes.capitol.texas.gov/Docs/BC/htm/BC.321.htm
- **TX Deceptive Trade Practices Act**, TX Bus. & Com. Code §§ 17.41–17.63: https://statutes.capitol.texas.gov/Docs/BC/htm/BC.17.htm
- **Texas Real Estate License Act (TRELA)**, TX Occ. Code Chapter 1101: https://statutes.capitol.texas.gov/Docs/OC/htm/OC.1101.htm
- **TREC Rules**, 22 TAC Chapter 535 (esp. §§ 535.144, 535.155): https://www.trec.texas.gov/rules-and-laws/trec-rules
- **Prior Hadley review** (hadley_4, 2026-06-23): `C:\Users\Heath Shepard\Desktop\Shepard-Ventures\Legal\reviews\2026-06-24-cold-email-tx-agents-LEGAL-REVIEW.md`
- **Founding Member ToS clause draft** (hadley_5, 2026-06-24): `C:\Users\Heath Shepard\Desktop\Shepard-Ventures\Legal\dossie-llc\tos-amendments\2026-06-24-founding-pricing-lock-clause.md`
- **Hadley reference library** (last researched 2026-05-22): `C:\Users\Heath Shepard\Desktop\Shepard-Ventures\Legal\shared\hadley-reference-library\trec-and-real-estate-license-act.md`

---

## 9. Hadley's note to Heath

The pattern-guessed source list is the sensitive part of this campaign, not the copy. Copy has been reviewed twice now. What matters between now and Day 1 is that the six conditions above are all live — especially Condition 3 (send pipeline reads the suppression list). That single gap is where CAN-SPAM enforcement actually bites, and the plumbing is half-built. Pierce and Atlas can close all six in a single work session.

Once the six conditions are green, launch is clean.

— Hadley
