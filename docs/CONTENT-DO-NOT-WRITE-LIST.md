# Content Do-Not-Write List — Texas Real Estate

Guardrail for any generator (nightly content pipeline, group-post drafts, video
scripts) touching real estate practice, contract mechanics, or legal/regulatory
topics. Trigger: an auto-drafted group post asserted a "contrarian take" on
escalation clauses that was wrong for Texas — see Question 1 below.

**Author:** Hadley (General Counsel, not a licensed attorney). **Researched:**
2026-09-14. **Scope:** Texas only — Heath is TX-licensed at KW City View, San
Antonio; content must read like it comes from someone who actually practices
here.

**Block levels (machine-readable):**
- `HARD_BLOCK` — never publish this claim/topic in this form, no exceptions.
- `CORRECTION_REQUIRED` — topic is publishable, but only with the specific
  Texas-correct framing noted. A generator producing the wrong version must be
  rejected and rewritten, not just flagged.
- `ATTORNEY_REVIEW` — Hadley's read is below, but this is genuinely unsettled
  or high-stakes enough that a licensed TX attorney should sign off before
  Heath relies on it publicly at scale. Treat as `HARD_BLOCK` until that
  happens.

Related standing rules this list sits under (memory): `heath-marketing-must-pass-practitioner-test.md`
(content must carry the real exception, not a flat take) and
`listing-copy-never-signal-weakness.md` (never concede seller weakness). Those
govern *tone*; this file governs *fact*.

---

## Machine-readable index

| topic_id | topic | block_level | one-line reason |
|---|---|---|---|
| escalation_clauses | Escalation / "relative bid" clauses | HARD_BLOCK | No TREC form; agent-drafted language is UPL under 22 TAC §537.11(b)(5); KW company policy separately prohibits it |
| agent_drafted_contingency_language | Any custom contract/contingency language outside a TREC or broker-approved form | HARD_BLOCK | Same §537.11(b)(5) prohibition — not limited to escalation clauses |
| dual_agency_illegal | "Dual agency is illegal in Texas" | CORRECTION_REQUIRED | Texas allows it via statutory intermediary status (Tex. Occ. Code §§1101.559–.560), not a flat ban |
| attorney_review_period | "Texas has an attorney review period" | HARD_BLOCK | No such mechanism in TX; do not conflate with the option period |
| option_period_mislabeled | Option period described as a "due diligence period" or "contingency" | CORRECTION_REQUIRED | TX option period (Paragraph 23) is a paid, unrestricted termination right — different legal structure than other states' terms |
| earnest_money_to_broker | Earnest money described as going to the agent/broker | CORRECTION_REQUIRED | Since TREC's 2021 rule change, earnest/option money goes to the title company/escrow agent named in the contract |
| as_is_no_recourse | "As-is means the seller has zero liability / buyer waives inspection" | CORRECTION_REQUIRED | Prudential v. Jefferson Assocs. — as-is defeats DTPA/fraud claims only absent fraudulent inducement/concealment; Seller's Disclosure obligations (Prop. Code §5.008) still apply |
| attorney_required_at_closing | "You need an attorney to close in Texas" | CORRECTION_REQUIRED | TX closings run through title companies, not attorneys (unlike many East Coast states) |
| transfer_tax | Texas real estate "transfer tax" or "mortgage recording tax" | HARD_BLOCK | Texas has neither; false if stated as a TX closing cost |
| title_insurance_shop_rate | "Shop around for a better title insurance rate" | CORRECTION_REQUIRED | TDI promulgates title premiums (Ins. Code §2703.151) — same rate at every underwriter; only ancillary fees (escrow, search, doc prep) vary |
| squatters_fast_takeover | "Squatters can take your house in [days/weeks]" | HARD_BLOCK | TX adverse possession requires years of continuous possession (Civ. Prac. & Rem. Code Ch. 16); true squatters are a criminal trespass/eviction matter, not a fast property-right claim |
| foreclosure_judicial_slow | Foreclosure described as a slow court process | CORRECTION_REQUIRED | TX foreclosure is non-judicial under Prop. Code §51.002 — can run as fast as ~41 days after a cure notice |
| foreclosure_redemption_general | "You can redeem your house after a mortgage foreclosure sale" | HARD_BLOCK | No general post-sale redemption right for TX mortgage foreclosures; redemption rights exist only for tax foreclosure sales (separate statute, separate timeline) |
| verbal_deal_binding | "A verbal agreement/counteroffer is binding" | HARD_BLOCK | Statute of Frauds (Bus. & Com. Code §26.01) requires real estate contracts in writing |
| community_property_ignored | Title-vesting, divorce-sale, or inherited-property content that assumes common-law/equitable-distribution rules | CORRECTION_REQUIRED | Texas is a community property state — ownership/vesting logic differs from the majority of states |
| seller_financing_casual | Seller financing / "rent-to-own" presented as a simple handshake deal | ATTORNEY_REVIEW | Heavily regulated as an executory contract under Prop. Code Ch. 5, Subch. D — mandatory disclosures, no-prepayment-penalty rule, right to convert to warranty deed; penalties for noncompliance. Heath has live deals touching this (Nopalito, Dr. Crockett) — do not publish generic content here without attorney sign-off |
| str_blanket_rule | "Texas allows/bans short-term rentals" as a single statewide rule | CORRECTION_REQUIRED | STR regulation in TX is municipal (San Antonio, Austin, etc. each have their own ordinances) — no blanket state rule to cite |
| public_legal_opinion | Answering "is this clause enforceable" / giving a specific legal opinion in a public group or comment | HARD_BLOCK | UPL exposure plus reliance liability — redirect to "talk to a real estate attorney," don't answer the legal question |
| fair_housing_steering_language | "Good schools," "family neighborhood," "safe area," "up-and-coming," or any protected-class-adjacent characterization of a neighborhood/buyer fit | HARD_BLOCK | Fair Housing Act steering risk — applies nationally, but is a standing landmine for public-facing agent content |
| generic_national_commission_claim | "Seller always pays buyer's agent commission" stated as a flat rule | CORRECTION_REQUIRED | Post-NAR-settlement (Aug 2024), commission is negotiated per-transaction everywhere, not TX-specific but currently a live accuracy trap |

---

## Question 1 — the escalation clause answer, sourced

**Short version:** "Not admissible" is not the right way to describe this, and worth
correcting in Heath's own language too. It's not an evidence-law problem — it's a
**regulatory drafting prohibition**. The precise framing: *no TREC promulgated
form exists, Texas REALTORS' own guidance says agents cannot draft the
language, TREC rule calls it unauthorized practice of law if they do, and
KW's internal policy separately bans it.* Four independent reasons to keep it
out of the funnel, not one.

**1. No TREC promulgated form or addendum.** Confirmed — there is no
escalation-clause addendum in TREC's form library. When one shows up in a TX
deal it's typically hand-inserted into Paragraph 11 (Special Provisions) of
the One to Four Family Residential Contract, or as a non-TREC addendum — both
of which run straight into the problem below.

**2. Texas REALTORS' published guidance.** Confirmed and direct: their
members' guidance, *"Can You Use Escalation Clauses?"*, states license
holders may not draft this language and directs agents to have the buyer
consult an attorney if one is wanted, or — if a seller receives an offer
containing one — advise the seller to seek counsel or ask the buyer to
resubmit without it using TXR 1926 (*Seller's Invitation to Buyer to Submit
New Offer*). [texasrealestate.com/members/posts/can-you-use-escalation-clauses](https://www.texasrealestate.com/members/posts/can-you-use-escalation-clauses/)

**3. The actual rule.** 22 Tex. Admin. Code §537.11(b)(5): license holders
may not "draft language defining or affecting the rights, obligations, or
remedies of the principals of a real estate transaction, including
escalation, appraisal, or other contingency clauses." TREC's own guidance is
explicit that an agent who drafts this kind of language is engaging in the
unauthorized practice of law. [law.cornell.edu/regulations/texas/22-Tex-Admin-Code-SS-537-11](https://www.law.cornell.edu/regulations/texas/22-Tex-Admin-Code-SS-537-11)
— TREC has flagged real examples it considers violations, e.g. Special
Provisions language like "Buyer will pay $1,000 more than any other offer,"
because making price contingent on outside variables affects the parties'
rights/remedies.

**4. KW company policy, separately.** Search turned up Keller Williams
guidance prohibiting agents from writing "relative bid"/"sharp offer"
language (escalation clauses) in offers, with the stated rationale that it
exposes buyers to paying more than their true ceiling. I could not pull the
primary KW Command/policy-manual page directly (search-engine-indexed
secondary source only — a KW-affiliated blog, not KW corporate itself), so
flag this one as **worth Heath confirming against his own MLS/brokerage
compliance portal** rather than treating it as fully verified. The TREC/TAR
prohibition above stands on its own regardless.

**5. Is there a financing/appraisal conflict too?** Yes, structurally — same
rule, same paragraph: TREC groups escalation clauses with appraisal and
"other contingency" clauses because all three share the defect of making
price or performance depend on facts outside the four corners of the
promulgated contract, which is exactly the kind of legal-effect drafting
agents aren't licensed to do.

**Bottom line for the content pipeline:** any post on escalation clauses is
either (a) explaining *why they don't work in Texas and what to do instead*
(attorney-drafted addendum, or TXR 1926 to ask for a clean resubmission) — a
legitimate, practitioner-credible topic — or (b) a HARD_BLOCK if it drafts,
endorses, or gives specific advice on the language itself. The killed post
was doing the latter.

**Flag:** items 1–3 above are sourced to primary/quasi-primary material (TREC
rule text via Cornell LII, Texas REALTORS' own member guidance) and I'd treat
them as solid. Item 4 (KW-specific policy) is secondary-sourced only —
confirm before citing KW policy by name in outward-facing content.

---

## Notes on the rest of the list

Several entries above (community property, seller financing, foreclosure
mechanics, statute of frauds) are areas where getting the general shape right
is easy but getting a specific fact pattern right is not — especially
seller-financing content, given Heath has two live deals touching executory
contracts right now. Anything narrower than the general educational framing
in this doc — i.e., anything that reads like advice on a specific
transaction — needs a licensed TX real estate attorney, not Hadley, before it
goes out under Heath's name.

This list is a starting set, not exhaustive. Add to it the same way this one
was built: when a generator produces a take that sounds right for "real
estate" in general but is wrong for Texas specifically, it goes here with a
citation, not just a one-off correction.
