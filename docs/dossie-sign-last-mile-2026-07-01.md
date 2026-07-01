# Dossie Sign — Last-Mile Audit (2026-07-01)

**Requested by:** Heath, 05:38 CDT — "doesn't feel confident Dossie Sign is bulletproof."
**Prepared by:** Hadley (General Counsel, Shepard Ventures)
**Scope:** the 8 TREC forms Heath mapped in DocuSeal + the end-to-end signing pipeline.

---

## The one-sentence answer

**Zero of 8 forms are ready for a REALTOR to close a real deal on Monday.** Fill quality varies (2 forms confidently render, 6 have gaps). But the customer-facing signing UI is not wired into the live workspace at all, and the DocuSeal template that would render the master resale contract is broken as of 2026-06-28. Every real signing round-trip in production history has produced a document stuck at status `sent` — never `completed`.

---

## Scoring rubric (0-10)

- **10** = Brittney could close a real Texas deal on it Monday morning without me watching.
- **8-9** = works end-to-end but I want one more round of live testing before a customer touches it.
- **5-7** = fill works, signing path has known gaps, needs an engineer round-trip.
- **1-4** = fill has known field-position errors OR signing path is missing.
- **0** = not implemented.

---

## Per-form audit table

| # | Form | Fill mechanism | Field-position last verified | Multi-signer works? | Real signing round-trip? | Audit trail captured? | Failure recovery? | Confidence (0-10) |
|---|---|---|---|---|---|---|---|---|
| 1 | **TREC 20-18 Resale** (DocuSeal 4018208) | pdf-lib in `fillResaleContract` — 263-widget rules file + Layer-3 validator + self-correction loop; DocuSeal path DISABLED because template returns blank PDFs. | 6 golden regression cases PASS. Real-world v3-FHA prompt on 2026-06-28: fields landed in wrong positions (buyer in seller slot, down-payment in exclusions). No Hadley-signed PASS report on file. | Buyer + Seller yes; second buyer/second seller supported in field map but never tested E2E. | **Never in production.** 8 test envelopes sent 2026-05-30 from demo account — all still `status='sent'`, none `completed`. 22 "signed" documents from Atlas E2E loop 2026-06-28 bypassed the `signature_requests` table entirely. | **No.** DocuSeal issues a Certificate of Completion by default; our webhook doesn't fetch it. Only the merged PDF is stored. | Webhook fires only on `form.completed`; no path for decline/expire/bounce. `status='sent'` envelopes sit in the table forever. | **4** |
| 2 | **TREC 40-11 Third Party Financing** (DocuSeal 4023463) | pdf-lib in `fillFinancingAddendum`; DocuSeal path DISABLED same reason as 20-18. | No golden regression tests. No Hadley-signed PASS. 67-field mapping exists in the DocuSeal KEY_MAP but was never exercised in a real customer flow. | Buyer + Seller supported by field map. | **Never in production.** Not routed to `esign-create` from the live UI. | No. | Same webhook gap. | **3** |
| 3 | **TREC 49-1 Right to Terminate — Lender's Appraisal** (DocuSeal 4023472) | pdf-lib in `fillAppraisalTermination` — only ~10 lines; only 3 waiver-type checkbox branches + property address + appraised value + threshold price. | Never verified against rendered PDF. **No KEY_MAP entry in `docuseal-prefill.js`** — cannot route via DocuSeal even if it worked. | Single-signer form (buyer notice). | **Never in production.** Not routed. | No. | Same gap. | **3** |
| 4 | **Seller's Disclosure Notice (TREC OP-H / 55-0)** (DocuSeal 4023470) | pdf-lib in `fillSellersDisclosure` — 179 AcroForm fields; supports 111 Y/N indexed responses + 29 explanation boxes + section checkboxes. Actually the most complete pdf-lib handler in the file. | Never end-to-end verified. Structure is right; specific SDN response mapping (which field is which numbered question on the form) is fragile because the underlying PDF is an XFA dynamic form pdf-lib strips. **No KEY_MAP in `docuseal-prefill.js`**. | Seller-signer only (`send_for_acknowledgment` action supports Buyer 1 + optional Buyer 2 acknowledgment). Actually usable via `sendForAcknowledgment` path. | **Never in production** via signing round-trip. `send_for_acknowledgment` exists on the API but no UI calls it. | No. | Same. | **3** |
| 5 | **HOA Addendum TREC 36-11** (DocuSeal 4111321) | pdf-lib in `fillHoaAddendum` — 17-field map. Full DocuSeal KEY_MAP exists (verified 2026-06-27 by Atlas). DocuSeal path DISABLED same reason as 20-18. | No golden. No Hadley PASS. | Buyer + Seller supported. | **Never in production.** Not routed. | No. | Same. | **3** |
| 6 | **Amendment TREC 39-10** (DocuSeal 4111320) | pdf-lib in `fillAmendment` — 45 AcroForm fields wired; supports all 10 amendment types (price change, repairs, closing date, seller concessions, lender repairs, option fee, waive option, buyer approval, other modifications, addenda). **No KEY_MAP in `docuseal-prefill.js`**. | Never verified against rendered PDF. | Buyer + Seller supported. | **Never in production.** Not routed. | No. | Same. | **3** |
| 7 | **Backup Contract TREC 11-7** (DocuSeal 4023578) | pdf-lib in `fillBackupContract` — **skeletal, ~10 lines**. Only sets property address, backup amendment deadline, and 2-digit year. All other fields (buyer/seller names, backup priority, primary contract effective date, etc.) fall through blank. **No KEY_MAP in `docuseal-prefill.js`**. **Zero fill records in the database** — never used. | Never verified. Only 3 field slots filled. | Buyer + Seller supported by template roles but not wired. | **Never in production.** Not routed. | No. | Same. | **1** |
| 8 | **Lead-Based Paint OP-L** (DocuSeal 4023469) | pdf-lib in `fillLeadPaintAddendum` — 25 AcroForm fields, all sections B/C/D wired. Full DocuSeal KEY_MAP exists. DocuSeal path DISABLED same reason as 20-18. | Never end-to-end verified. Structure sound. | Buyer + Seller supported. | **Never in production.** Not routed. | No. | Same. | **3** |

**Ready for Monday-closing (confidence 8+): 0 of 8.**

---

## The top 5 blockers, in ship order

### Blocker #1 — There is no customer-facing UI that triggers `/api/esign-create`

The live workspace bundle (`workspace-rvk6ZJHK.js`) makes calls to `/api/fill-forms-batch` (fill the PDF into Storage) but never calls `/api/esign-create` (send it to DocuSeal for signing). A `DossieSignModal.jsx` React component exists in the source tree but is not imported by any other component — it is dead code. No customer can start a signing envelope from the UI today.

**Fix:** wire `DossieSignModal.jsx` (or a rebuilt equivalent) into the workspace transactions view. Give the customer a "Send for signature" button on any filled document row. The button collects the buyer/seller emails, calls `/api/esign-create` with `documentId` + `signers[]`, and shows the returned signing URLs.

**Owner:** Carter.

### Blocker #2 — DocuSeal template 4018208 (TREC 20-18) returns blank PDFs

Atlas verified on 2026-06-27/28 via direct API probes with every documented payload format (per-submitter `values`, per-submitter `fields[]`, top-level `fields[]`, PATCH submitter) that the master resale template silently drops all field values and returns a blank PDF. Every submission for 4018208 in the last 24h of that window had `values: [0,0]` — meaning zero of two submitters received any prefilled data. Heath's v3-FHA prompt produced 4 consecutive blank PDFs. Atlas reverted the code to pdf-lib for the 4 forms that had KEY_MAP entries. The DocuSeal template itself has never been fixed.

**Fix:** rebuild template 4018208 from scratch in the DocuSeal builder. Suspected cause is orphaned fields ("duplicate Seller 2" per the 2026-06-17 handoff note) that make DocuSeal's field-resolution step silently no-op. Same audit needed on the other 7 templates before we trust the DocuSeal path for any of them.

**Owner:** Heath (only he has the DocuSeal login and knows which fields he intended for which paragraph). Hadley to hand-check each template against her TREC-Forms-Knowledge dossiers.

### Blocker #3 — 4 of 8 forms have no DocuSeal field mapping at all

`api/_assets/docuseal-prefill.js` defines DOCUSEAL_TEMPLATES for all 8 forms but KEY_MAP entries for only 4 (resale-contract, financing-addendum, hoa-addendum, lead-paint-addendum). Sellers Disclosure, Amendment, Appraisal Termination, and Backup Contract have no field mapping layer. Even if Heath rebuilt those DocuSeal templates today, our code would submit zero fields to them.

**Fix:** write KEY_MAP entries for the 4 missing forms. Structure identical to the existing 4. Estimate: 200 lines total.

**Owner:** Atlas (mechanical work — reads each DocuSeal template via `GET /templates/{id}`, generates the key map matching Heath's field names, mirrors pattern from the working 4).

### Blocker #4 — Zero Hadley-signed field-position PASS reports exist

Per `feedback_hadley_apv_is_fillform_merge_gate.md` (locked 2026-06-28 by Heath), no fill-form change merges to main until Hadley reads the rendered PDF page-by-page and confirms every field lands in the correct visual position. Not text-grep — position. That gate has never been satisfied for any of the 8 forms. Ground-truth artifacts exist for 20-18 (263-widget rules file, 6 golden cases). The other 7 forms have no such artifact.

**Fix:** run a rendered-PDF field-by-field verification pass on each of the 8 forms with a canonical expected-output table. Loop with Atlas/Carter on any FAIL until zero errors per form. Produce a signed PASS report per form.

**Owner:** Hadley (me). Estimate: 4-6 hours per form for the ones with existing rules files, 8-10 hours per form for the ones without. Total: ~50-70 hours over the next week.

### Blocker #5 — The completion webhook throws away DocuSeal's Certificate of Completion (the legal audit trail)

TREC and UETA (Tex. Bus. & Com. Code §322.007-.009) permit electronic signatures on real estate contracts, but in a dispute the audit trail is the enforceability record — signer identity, IP, timestamp per signature event, document hash chain, delivery method. DocuSeal provides all of this automatically as a Certificate of Completion PDF attached to the submission. Our `esign-webhook` only fetches `submission.documents[0]` (the merged signed PDF) and discards the certificate. If a signer disputes on Brittney's first real deal, we cannot produce the audit trail from our records — we have to log back into DocuSeal and hope the submission is still there.

**Fix:** on `form.completed`, download BOTH the signed PDF and DocuSeal's Certificate of Completion. Store both in Supabase Storage. Add a `signed_certificate_document_id` column to `signature_requests`. Ensure retention is at least 7 years (TX Property Code residential-transaction records rule).

**Owner:** Atlas.

---

## First-customer trial plan (Brittney Kirkland)

Brittney is the natural first real user: verified 80+ deals/year, most active founder per `docs/CUSTOMERS.md`, already trusts Dossie enough to use it on real deals. She should NOT be the debugging user. She should be the confidence-check after Blockers 1-5 are done.

### The exact test

- **Form:** TREC 20-18 Resale ONLY. Nothing else.
- **Deal:** a real Brittney listing she's willing to run in parallel with her normal DocuSign/zipForms process. She uses Dossie Sign for a "shadow copy" — she does not rely on our envelope; she compares our output to her production output.
- **Rounds:** three shadow deals before she uses Dossie Sign as her primary tool. That's ~2-3 weeks at her deal cadence.

### What to instrument BEFORE she touches it

1. Every `/api/fill-form` call from her user_id logs the rendered PDF to a shadow bucket + Telegrams me + Atlas immediately. We eyeball every fill before she sends it.
2. Every `/api/esign-create` call from her user_id sends me + Atlas the signing URL. We open it in a private browser and walk through the signer flow ourselves before she asks a client to.
3. `signature_requests` webhook events for her user_id fanout to a #brittney-live-test Telegram channel so we see every event (viewed / started / completed).
4. On any `form.completed` from her, we auto-download and email me the signed PDF + DocuSeal Certificate of Completion for one-hour visual inspection before we tell her it's ready.

### The two things that will kill her trust

1. **Field lands in wrong slot on the signed PDF.** Non-recoverable. She won't try us again for 6 months. Blocker #4 must be closed before she touches it.
2. **Signing link expires / bounces / signer never opens and we can't tell.** She looks unprofessional to her client. Blocker #5 (audit trail) does not fix this — we also need a "signer hasn't opened in 24hrs" reminder cron + a "signer declined, here's why" alert. Not on the top-5 list because the top 5 must go first, but must be #6.

### What "success" looks like

Three shadow deals through 20-18 with zero field-position errors, zero envelope-drop failures, zero webhook silence. Then she can promote it to her primary contract tool. Then and only then do we open 40-11 (financing) as the second form. Then and only then do we open the other 6, one at a time.

---

## Cannot ship anything else on top of this until

Per the PARAMOUNT rule `feedback_dossie_sign_must_work_before_new_ships.md`:

1. Blocker #1 closed — customer UI actually invokes the signing pipeline.
2. Blocker #2 closed — DocuSeal template 4018208 rebuilt and verified to accept prefills.
3. Blocker #4 closed for TREC 20-18 — Hadley-signed field-position PASS report on file.
4. Blocker #5 closed — audit certificate saved on every completed envelope.
5. One successful production round-trip on Heath's own demo account or Brittney's shadow deal — envelope created, all signers signed, signed PDF + certificate stored in Dossie, no errors in logs.

Blockers 3 (missing KEY_MAPs for 4 forms) and Blocker #4 for the remaining 7 forms are NOT ship gates — they gate expansion of Dossie Sign to those specific forms. The ship gate is "TREC 20-18 alone works end-to-end for one real deal."

Exceptions per the paramount rule: security hotfixes (P0), customer-impacting bug fixes (broken sign-in, broken payment), ToS / legal compliance fixes, and anything Heath explicitly waives ("ship this, I know Sign is broken").

---

## Who does what next

- **Atlas:** Blockers #2 (rebuild templates with Heath), #3 (write 4 missing KEY_MAPs), #5 (fetch + store DocuSeal Certificate of Completion). Estimated: 2-3 days on staging + APV before Hadley gate.
- **Carter:** Blocker #1 (wire DossieSignModal into the workspace, add "Send for signature" button on filled-document rows, plumb through `signers[]` collection). Estimated: 1 day + Quinn regression.
- **Hadley (me):** Blocker #4 for TREC 20-18 first (rendered-PDF field-by-field PASS report). Then repeat for the other 7 in order of usage frequency. TREC 40-11 second, HOA and Lead-Paint third and fourth. Estimated: 6-8 hours per form.
- **Quinn:** post-Atlas APV — sign in as demo, run TREC 20-18 fill → send-for-signature → sign as buyer → sign as seller → check webhook fires → check signed PDF + certificate land in Supabase. Loop with Atlas until zero errors across 5 consecutive attempts.
- **Heath:** approve the DocuSeal template rebuild plan when Atlas surfaces it. Approve the merge only after Hadley signs the PASS report AND Quinn signs the 5-in-a-row report.

---

## What this audit did NOT verify (deferred to Hadley Blocker #4 pass)

- Whether specific field values render at the correct visual position on the rendered PDF for any of the 8 forms.
- Whether Heath's DocuSeal templates match the current TREC-effective versions (20-18 is Jan 3 2025; 40-11 is Jan 3 2025; 36-11 was updated May 28 2026 per `TREC-Addenda-Summary.md` — need to check that our uploaded template is the new one).
- Whether TREC 55-1 (the current mandatory Seller's Disclosure version) is what's in the DocuSeal template, or an older version. Same question for 39-10 vs older Amendment.
- Whether TREC 11-9 (the current Backup Contract Addendum version, per Heath's dossiesign-prepare.js filename `trec-backup-contract-11-9-base64.js`) matches template 4023578, which Heath's memory calls "11-7."

These are catch-me-later items — none of them block Blocker #4 as long as we verify against whichever PDF the DocuSeal template is currently built on.

---

**File saved:** `C:\Users\Heath Shepard\Desktop\MeetDossie\docs\dossie-sign-last-mile-2026-07-01.md`
