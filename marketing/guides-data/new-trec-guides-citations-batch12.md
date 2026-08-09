# Batch 12 citation trail — TC disclosure proposal (regulatory-watch, /answers/)

## Verification outcome

**CONFIRMED REAL**, with one correction to the secondhand brief: the brief cited a
"meeting recap dated 04/30/2026." The actual BRAC meeting where this was discussed
and the referral to the Broker-Lawyer Committee was made occurred **April 8, 2026**,
not April 30. No TREC article dated 04/30/2026 was found. All other substance of
the brief (committee name, the exact ask to investigate a consumer disclosure form
identifying licensed vs. unlicensed TCs) is verified verbatim against TREC's own
published recap.

Built as an **/answers/ page**, not a /guides/ page — see "Format decision" below.

## Source chain (all trec.texas.gov, fetched 2026-08-09)

1. **Primary source — the referral itself.**
   "BRAC Meeting Recap: Recommendations on Intermediary, Inactive Licenses, and
   Transaction Coordinator Oversight"
   https://www.trec.texas.gov/article/brac-meeting-recap-recommendations-intermediary-inactive-licenses-and-transaction
   - Meeting date: **April 8, 2026**. Committee: **Broker Responsibility Advisory
     Committee (BRAC)**.
   - Verbatim: "BRAC asked the Broker-Lawyer Committee to investigate the possible
     development of a consumer disclosure form about transaction coordinators,
     including identifying whether a transaction coordinator is licensed or
     unlicensed."
   - Public comment covered: TCs handling sensitive contract/financial/client
     information; TCs working across multiple brokerages creating unclear
     supervision/accountability lines; consumer-protection concerns.
   - The article does **not** describe a vote adopting anything — it describes
     BRAC's committee-to-committee referral (asking the Broker-Lawyer Committee
     to investigate). No form, no rule, no requirement resulted from this meeting.

2. **Committee existence confirmation.**
   https://www.trec.texas.gov/about-commission/broker-responsibility-advisory-committee
   — confirms BRAC exists as a standing TREC advisory committee.

3. **Broker-Lawyer Committee's own April meeting — did NOT yet act on the referral.**
   "Broker-Lawyer Committee Reviews Contract Form Updates at April Meeting"
   https://www.trec.texas.gov/article/broker-lawyer-committee-reviews-contract-form-updates-april-meeting
   - Meeting date: **April 10, 2026**.
   - Verbatim: flagged "broader issues, including time-of-the-essence clauses and
     considerations related to transaction coordinators," with "these discussions
     will continue at future meetings." No disclosure form drafted, no vote taken.

4. **Most recent status — BRAC tabled the topic July 14, 2026.**
   "BRAC Discusses Inactive License Education, AI, and Industry Transparency"
   (found via trec.texas.gov/news-articles listing, published 07/29/2026,
   covering the committee's **July 14, 2026** meeting)
   - Verbatim: "The committee continued its discussion on transaction coordinators
     and possible ways to improve transparency for consumers." ... "After hearing
     public input and discussing potential disclosure options, BRAC agreed to
     table the topic until the next meeting."
   - Next BRAC meeting confirmed in the article: **Wednesday, October 7, 2026** —
     the earliest point any further movement (including whether the Broker-Lawyer
     Committee has produced anything) is likely to surface.
   - This is the most current status found as of the 2026-08-09 verification date:
     **still tabled, no draft form, no proposed rule, nothing adopted.**

## Format decision: /answers/ not /guides/

Checked `scripts/build-guides.js` and `scripts/build-answers.js`, plus one
existing hand-authored time-sensitive page (`guides/trec-july-2026/index.html`,
not JSON-driven) and the `/answers/` JSON pattern
(`marketing/answers-data/what-is-a-transaction-coordinator-texas.json` etc.).

- `guides/trec-july-2026` covers **settled, mandatory, dated law** (TREC forms
  becoming compliance-required July 1, 2026) — it earns a full guide with a
  countdown-style deadline banner because there's a real deadline and a
  do-this-by-then checklist.
- This topic has **none of that**: no form, no rule, no deadline, no checklist —
  just "a committee asked another committee to look into something, then tabled
  it." Forcing that into a full guide's body length/structure would pad content
  that doesn't exist yet.
- The `/answers/` template already has the exact scaffolding this needs for
  free: a prominent "Updated [date]" freshness badge in the hero (AEO freshness
  signal, and here doubles as the "check the date, verify before relying on
  this" cue), a short TL;DR block up top, and a citable, direct-answer format —
  well suited to "is X required in Texas" query patterns AI assistants and
  Google's AI Overviews actually ask.
- Slug chosen to match the answers-data question-phrased convention (see
  `do-i-need-tc-texas-real-estate.json`, `can-seller-back-out-during-option-period-texas.json`):
  **`is-a-tc-disclosure-form-required-in-texas`**.

## Framing requirements applied in the JSON/body copy

- Top-of-page TL;DR states plainly, as of 2026-08-09: this is a proposal under
  discussion, not a current legal requirement; no form exists; nothing is
  required of any agent, broker, or TC today.
- Body explicitly walks the timeline (Apr 8 referral → Apr 10 BLC ack → Jul 14
  tabled → Oct 7 next meeting) so a reader sees this has moved slowly and is
  still unresolved, not imminent.
- Explicit "verify current status before relying on this" language near the top
  and in an FAQ answer, with a direct link to TREC's own BRAC recap page so a
  reader/agent can check for a newer recap themselves.
- No CTA copy implies Dossie tracks or fulfills a disclosure requirement that
  doesn't exist — CTA kept generic (deadline tracking), not tied to this
  unresolved proposal.
- Draft originally included a claim that Dossie discloses its AI role to
  end-clients "from day one." A verification pass against the actual product
  (client email templates in `assets/workspace-*.js`, which sign off as the
  agent — "I've got the rest. - Dossie" — with no AI/automated labeling, and
  `api/_lib/group-post-generator.js`, which explicitly forbids phrases like
  "an AI tool" in outward copy) found this **unsupported and contradicted** by
  the repo's own copy rules. Struck from the final JSON entirely — the page
  makes no claim about Dossie's own disclosure practices.
