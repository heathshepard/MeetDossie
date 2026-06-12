# Dossie QA Loop — Continuous Improvement Log

**Loop active since:** 2026-06-11
**Benchmark:** Human-TC equivalence across all 5 scenario types

---

## Benchmark Gates (all must pass to exit loop)

- ✅ Dossie fills ANY TREC form correctly with one natural-language request
- ✅ Dossie drafts ANY standard agent-to-X email (buyer, lender, title, agent-agent) in right tone/details
- ✅ Dossie answers "what's next?" with concrete next actions, form names, TREC paragraph citations
- ✅ Dossie identifies TREC compliance issues proactively (e.g., "Option period ends Friday")
- ✅ Dossie manages full transaction lifecycle without agent spelling out each step

---

## Scenario Rotation (daily 6 AM CDT)

| Day | Scenario | Status |
|---|---|---|
| 1 (Mon) | New buyer dossier → TREC 20-18 via Talk to Dossie → DossieSign → track | Queued |
| 2 (Tue) | Seller dossier → TREC 1-4 forms → welcome email → milestone | Queued |
| 3 (Wed) | Inbound amendment → TREC 39-10 via voice → DossieSign | Queued |
| 4 (Thu) | Lender intro + title company emails via Talk to Dossie | Queued |
| 5 (Fri) | Deadline-driven: option period expiring → morning brief + notifications | Queued |

---

## Findings Log

### Round 1 (2026-06-11, Day 1: Buyer Contract Flow)

**Status:** Stub execution (no real testing yet)
**Findings:** 1 P0 blocker

- **P0 – Class C (Tool design gap):** Talk to Dossie does not route natural-language "fill contract" requests to extract-form-fields.js. Current routing incomplete.

**Next:** Implement full Playwright test for buyer flow end-to-end.

---

**End of log**
