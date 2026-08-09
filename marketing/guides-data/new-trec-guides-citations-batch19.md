# Citation trail — new TREC guide pages, batch 19 (2026-08-08/09)

One new guide: the HOA resale certificate ordering process and statutory mechanics, Property
Code Chapter 207. Flagged as a top-confirmed content gap by search volume — TCs deal with resale
certificates on nearly every HOA-property closing, and nothing in the repo covered the process
end-to-end.

**Relationship to existing repo guides, confirmed by reading both before writing:**
- `marketing/guides-data/texas-hoa-addendum-guide.json` (TREC 36-11) covers the *contract-side*
  disclosure obligation — the four delivery-option checkboxes on the addendum form, the buyer's
  3-day post-receipt termination right, and Paragraph C's HOA-fee cap negotiated between the
  parties. It already quotes the addendum's own definition of "Subdivision Information" as
  including "a resale certificate... described by Section 207.003 of the Texas Property Code" but
  does not unpack what Section 207.003 itself requires — this new guide is the direct follow-up,
  covering the *statutory* ordering process: who can request the certificate, the HOA's response
  deadline, what the certificate must contain, the fee cap, and what happens if the HOA misses the
  deadline. New guide cross-links to the addendum guide and vice versa is not needed since the
  addendum guide predates this one and isn't being touched (worktree isolation rule — only my 3
  new files are touched).
- Checked for `texas-hoa-foreclosure-lien-guide.json` per the task brief (a parallel agent may have
  built it) — `git pull origin staging` before starting and a repeat `ls marketing/guides-data/`
  after the pull found no file matching `*foreclosure*`. Not present as of this build; no cross-link
  added. (Section 207.003(b)(15) does require the resale certificate to disclose whether the
  restrictions allow lien foreclosure for unpaid assessments — the new guide mentions this as one of
  the 16 disclosure items but does not attempt to explain HOA foreclosure procedure itself, since
  that's a different statute — Property Code Chapter 209 — and a different guide's job.)

**Primary source and method — same approach as batch 5, extended to a new chapter:**
`statutes.capitol.texas.gov`'s public `/Docs/PR/htm/PR.207.htm`-style URLs serve only the Angular
SPA shell client-side; the reliable path is the Texas Legislative Council's own backing API. Used:

```
GET https://tcss.legis.texas.gov/api/GetStatute/GetStatute/PR/207/207/null/null/null/null/null/null/null/htm
```

Response: a plaintext pointer, `https://tcss.legis.texas.gov/resources/PR/htm/PR.207.htm#207`.
Fetched that `resources` URL directly via `curl` — 200 OK, `Content-Type: text/html`,
`Last-Modified: Fri, 10 Apr 2026`, served directly off `tcss.legis.texas.gov` (Texas Legislative
Council infrastructure, not a third-party mirror or cache). Stripped HTML tags to plain text for
direct quoting; captured the full chapter (Sections 207.001–207.006) in one fetch since Chapter 207
is short. Confirmed the amendment history for each section runs through Acts 2021, 87th Leg., R.S.,
Ch. 951 (S.B. 1588) at the latest (Sections 207.001, 207.003, 207.004, 207.006) — no 88th (2023) or
89th (2025) Legislature amendment touched any section of this chapter, so the text quoted is
current as of this build.

---

## texas-hoa-resale-certificate-guide.json — Property Code Chapter 207

| Claim | Source |
|---|---|
| Chapter title "DISCLOSURE OF INFORMATION BY PROPERTY OWNERS' ASSOCIATIONS," Title 11, Restrictive Covenants | Statute text, chapter header |
| § 207.001(5) — "Resale certificate" means a written statement issued, signed, and dated by an officer or authorized agent of a property owners' association that contains the information specified by Section 207.003(b), verbatim | Statute text, § 207.001(5) |
| § 207.002(a) — chapter applies to a subdivision with a POA "entitled to levy regular or special assessments" | Statute text, § 207.002(a) |
| § 207.002(b) — chapter does NOT apply to a condominium council of owners (Ch. 81) or condominium unit owners' association (Ch. 82), verbatim | Statute text, § 207.002(b) |
| § 207.003(a) — who may request: an owner or the owner's agent, a purchaser of property in the subdivision or the purchaser's agent, or a title insurance company or its agent acting on behalf of the owner or purchaser, verbatim | Statute text, § 207.003(a) |
| § 207.003(a) — 10-business-day response deadline, running from the date the written request AND (per (a-1)) verified evidence of the requestor's authority to order a resale certificate are received, verbatim | Statute text, § 207.003(a) |
| § 207.003(a)(1)-(3) — what must be delivered: current copy of subdivision restrictions, current copy of POA bylaws/rules, and a resale certificate prepared not earlier than the 60th day before the delivery date | Statute text, § 207.003(a)(1)-(3) |
| § 207.003(a-1) — for a purchaser-side request, the POA may require reasonable evidence of a contractual or other right to acquire the property before beginning the process | Statute text, § 207.003(a-1) |
| § 207.003(b)(1)-(16) — the 16 required contents of a resale certificate (right of first refusal/transfer restraints; assessment frequency/amount; pending special assessment amount+purpose; total amounts due and unpaid; approved capital expenditures; reserves; current operating budget and balance sheet; unsatisfied judgments; pending-lawsuit style and cause number; certificate of insurance; known restriction/rule violations; government health/housing code violation notices; administrative transfer fee amount; managing agent name/address/phone; statement on whether restrictions allow lien foreclosure for unpaid assessments; statement of all ownership-transfer fees), verbatim, all 16 mapped 1:1 in guide order | Statute text, § 207.003(b), full subsection |
| § 207.003(c) — fee cap **$375** to assemble, copy, and deliver the Subsection (a) information; separate fee cap **$75** to prepare/deliver a Subsection (f) update, verbatim | Statute text, § 207.003(c) |
| § 207.003(c-1) — POA may require payment before beginning the process but may NOT process payment until the certificate is available for delivery; may NOT charge a fee at all if the certificate isn't provided within the Subsection (a) deadline, verbatim | Statute text, § 207.003(c-1) |
| § 207.003(d) — delivery to the person/address specified in the written request; a request that doesn't specify name and location is not effective; delivery by mail, hand delivery, or an alternative method specified in the request | Statute text, § 207.003(d) |
| § 207.003(e) — POA/agent not required to inspect the property before issuing a certificate or update, unless a dedicatory instrument requires it | Statute text, § 207.003(e) |
| § 207.003(f) — **7-business-day** deadline for an UPDATED resale certificate (distinct from the original 10-business-day deadline), with 3 required contents (right-of-first-refusal waiver status, unpaid special assessment/dues status, changes since the original certificate) | Statute text, § 207.003(f) |
| § 207.003(g) — update requests must be made within **180 days** of the original certificate's issuance, and only by the party who requested the original | Statute text, § 207.003(g) |
| § 207.004(a)-(b) — owner's remedy path: a second request; if the POA still fails to deliver by the 5th business day after the second request (sent certified mail/return receipt or hand-delivered with receipt), owner may seek a court order compelling delivery, a judgment up to **$5,000**, court costs/attorney's fees, and/or authorization to deduct those amounts from future assessments | Statute text, § 207.004(a)-(b)(1) |
| § 207.004(b)(2) + (c) — owner may instead give the buyer an affidavit reciting the two written requests and non-delivery; once given, buyer/lender/title company are not liable for money due or claims that accrued before the affidavit date, and the POA's lien for those amounts automatically terminates | Statute text, § 207.004(b)(2), (c) |
| § 207.005(a) — POA may not deny the validity of any statement in the resale certificate; its lien for undisclosed amounts due as of the certificate's preparation date automatically terminates as to that undisclosed amount; buyer/buyer's agent/owner/owner's agent/lender/title company and its agent are not liable for any debt or claim existing on the certificate's preparation date that the certificate doesn't disclose | Statute text, § 207.005(a) |
| § 207.005(b) — a resale certificate does not affect the POA's right to recover debts/claims arising after the certificate's preparation date, or a lien securing future assessments | Statute text, § 207.005(b) |
| § 207.005(c)-(d) — owner's agent and title company/agent are not liable to a buyer for the POA's delay or failure to deliver; POA and its officers/agents are not liable for delay/failure except as provided by § 207.004 | Statute text, § 207.005(c)-(d) |
| § 207.006 — online-posting requirement applies only to (1) a subdivision of at least 60 lots, or (2) a POA that has contracted with a management company; applicable POAs must make current dedicatory instruments (as filed in county deed records) available on a website maintained by the association or its management company and accessible to members | Statute text, § 207.006(a)-(b) |
| Amendment history for §§ 207.001, 207.003, 207.004, 207.006 runs through Acts 2021, 87th Leg., R.S., Ch. 951 (S.B. 1588) at the latest; no 88th (2023) or 89th (2025) Legislature amendment to any section in this chapter | Statute text, "Amended by:" blocks at the end of each section, full chapter capture |
| Cross-reference to TREC 36-11 / "Subdivision Information" definition quoting § 207.003 | Existing repo guide `texas-hoa-addendum-guide.json`, read for consistency, not re-verified (its own citation trail already covers the form text) |

**Terms defined by cross-reference to other Property Code sections, not independently re-verified
in this pass:** § 207.001 pulls "restrictions" from § 201.003, "dedicatory instrument"/"property
owners' association"/"restrictive covenant"/"management company" from § 209.002, and "regular
assessment"/"special assessment" from § 204.001. The guide uses these terms in their plain,
commonly-understood sense (consistent with how the existing TREC 36-11 guide already uses them)
and does not quote those other sections' definitional text directly, since verifying all three
cross-referenced sections was outside this task's scope. Flagged here rather than silently assumed.

**Flagged as ambiguous/needing judgment, intentionally left undecided in the guide:**
- The 10-business-day clock in § 207.003(a) starts only once BOTH the written request AND (per
  (a-1), for purchaser-side requests) verified evidence of the requestor's authority are in the
  POA's hands. The statute doesn't specify how long the POA gets to review/verify that evidence
  before the clock starts, or what counts as "reasonable evidence" of a contractual right to
  acquire the property — that's left to the POA's judgment on its own request form. The guide
  states the two-part trigger plainly rather than guessing at a fixed sub-deadline the statute
  doesn't supply.
- § 207.003(c-1) bars the POA from charging a fee "if the certificate is not provided in the time
  prescribed by Subsection (a)" but the statute does not say the POA must refund a fee it already
  collected in that scenario, only that it can't charge one going forward / process one until the
  certificate is ready. The guide states what the statute says without extrapolating a refund
  right the text doesn't grant.
- § 207.004's remedies (court order, up to $5,000 judgment, attorney's fees, the buyer-affidavit
  lien-termination mechanic) belong to the OWNER (the seller), not directly to the buyer or the TC
  coordinating the file — a TC's practical lever when a certificate is late is to push the owner to
  send the certified-mail second request, not to pursue the remedy independently. The guide frames
  this as "who holds the remedy" rather than implying the TC or buyer can invoke § 207.004 directly.
- The statute does not define what happens if the POA is unresponsive to the SELLER's own agent
  making the first request versus the buyer's agent or title company making it — all three are
  equally valid requestors under § 207.003(a), and the statute doesn't state a priority order or
  say whether multiple simultaneous requests reset the clock. The guide notes that any of the three
  can request it without asserting a sequencing rule the statute doesn't contain.

**Not flagged as ambiguous — confirmed clean:** the sixteen resale-certificate content items in
§ 207.003(b)(1)-(16) map one-to-one, in the same order, to the guide's sixteen list items, with no
combining, splitting, paraphrase-drift, or renumbering. The two dollar caps ($375 assemble/deliver,
$75 update) and the two response-deadline day-counts (10 business days original, 7 business days
update) are each used exactly once per figure in the guide and matched to their correct subsection
in this table — verified against the statute text side-by-side before publishing.
