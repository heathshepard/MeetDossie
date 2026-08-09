# Citation trail — new TREC guide page, batch 8 (2026-08-08)

One new guide: `texas-consumer-protection-notice-guide.json`, covering the TREC Consumer
Protection Notice (currently form **CN 1-5**). Same methodology as prior batches: primary
sources fetched directly from trec.texas.gov and the Texas Administrative Code, not trusted from
a single search snippet. A prior scoping pass flagged that CN 1-4 has been superseded by CN 1-5
but said this needed independent confirmation — that confirmation is documented below.

Sources used:
- TREC's live Consumer Protection Notice form PDF, fetched directly and read via the Read tool
  (same two-step process as prior batches — WebFetch saves the binary locally, Read extracts the
  actual page text/image): https://www.trec.texas.gov/sites/default/files/pdf-forms/CN%201-5_0.pdf
- 22 TAC §531.18 (Consumer Information), the TREC rule that adopts the notice by reference and
  sets the posting/display requirements, fetched via Cornell Law's LII mirror of the Texas
  Administrative Code (attempted the Texas Secretary of State's own texreg.sos.state.tx.us portal
  directly first — it returned only a "site has moved" redirect page, no rule text, so LII's
  mirror was used instead; LII mirrors are a secondary source, not primary, and this is flagged
  here rather than silently treated as equivalent to the SOS text):
  https://www.law.cornell.edu/regulations/texas/22-Tex-Admin-Code-SS-531-18
- TREC's own 2023 year-in-review article, which states the mandatory effective date and the
  legislative reason for the CN 1-4 → CN 1-5 update:
  https://www.trec.texas.gov/article/2023-trec-highlights-rule-changes-new-commissioners-legislative-session-outcomes-and-more
- TREC's "3 Places You May Need to Update the Consumer Protection Notice" article, used for the
  prior version's (CN 1-4) effective date and the three-location posting framework this guide
  reuses (office / website / social media): https://www.trec.texas.gov/article/3-places-you-may-need-update-consumer-protection-notice
- Colibri Real Estate blog post (secondary, non-TREC), used only to corroborate the "no longer
  references the real estate inspection recovery fund" description of what changed — cross-checked
  against the actual CN 1-5 PDF text, not relied on alone:
  https://www.colibrirealestate.com/career-hub/blog/trec-updates-two-frequently-used-forms-2023/

## Findings

| Claim | Source |
|---|---|
| Current form is **CN 1-5** (not CN 1-4) | 22 TAC §531.18 text (LII mirror): "The Commission adopts by reference the Consumer Protection Notice, TREC No. CN 1-5"; corroborated by the live PDF at trec.texas.gov itself printing "CN 1-5" at the bottom of the single page |
| Full verbatim text of the notice | Read directly off the fetched CN 1-5 PDF (one page, page-image render — quoted in the guide from that direct read, not reconstructed) |
| Who must provide it: brokers, sales agents, inspectors, and easement/right-of-way (ERW) agents | 22 TAC §531.18 rule text (LII mirror) |
| Posting requirement: displayed in a readily noticeable location in each place of business the broker maintains | 22 TAC §531.18 rule text (LII mirror) |
| Website requirement: link on homepage, labeled either "Texas Real Estate Commission Consumer Protection Notice" (≥10pt) or "TREC Consumer Protection Notice" (≥12pt) | 22 TAC §531.18 rule text (LII mirror) |
| Social media: link may live on the account holder's profile, or on a separate page/website reached via a direct link from the platform or profile | 22 TAC §531.18 rule text (LII mirror) |
| CN 1-5 became mandatory September 1, 2023, replacing CN 1-4, driven by 88th Texas Legislature requiring TREC to update the form | TREC's own 2023 highlights article, direct quote: "The new forms are online and were required for use starting in September [2023]," tied to legislation from the 88th Legislature affecting both the Consumer Protection Notice and the Seller's Disclosure Notice |
| What changed from CN 1-4 to CN 1-5: no longer references the real estate inspection recovery fund (repealed that session) | TREC 2023 highlights article + Colibri Real Estate blog post (secondary, cross-checked); consistent with the live CN 1-5 PDF text itself, which mentions only the **Real Estate Recovery Trust Account** (a separate, still-existing account for broker/sales-agent/ERW-agent judgments) and inspector E&O insurance — no mention of an inspection recovery fund anywhere in the current text |
| No printed revision date appears on the CN 1-5 form itself | Direct read of the fetched PDF — the form shows only "CN 1-5" as its identifier at the bottom of the page, no separate revision-date line the way some other TREC forms carry one |

## Flagged as unresolved / handled conservatively

- **Exact adoption date of the rule amendment that swapped CN 1-4 for CN 1-5 in 22 TAC §531.18
  itself** (as opposed to the September 1, 2023 mandatory-use date for the form) was not
  independently pulled from a Texas Register adoption notice — the SOS portal for the live TAC
  text redirected rather than serving rule text, and a Texas Register archive search was not
  performed this session. The guide states the September 1, 2023 mandatory-use date (TREC's own
  sourcing) and does not claim a separate rule-adoption date beyond that.
- **Whether individual sales agents (as opposed to their sponsoring broker) have any independent
  posting obligation of their own** is not spelled out separately in §531.18 — the rule text reads
  "each license holder shall provide the notice by... displaying it... in each place of business
  the broker maintains," which reads as the broker's physical posting satisfying it for agents
  working from that office. The guide describes this plainly (broker posts at the office; the
  website/social-media link requirement applies to whichever license holder maintains that
  website or profile) rather than asserting a firmer legal conclusion than the rule text supports.
- The Cornell LII page is a secondary mirror of the Texas Administrative Code, not the Secretary of
  State's own site or trec.texas.gov's rule page. It was used because the direct SOS lookup
  redirected without serving content. This is called out above rather than presented as if the
  primary regulator's rule page had been read directly.
