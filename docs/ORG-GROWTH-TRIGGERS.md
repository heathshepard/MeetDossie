# Shepard Ventures — Org Growth Trigger Catalogue

**Purpose:** Heath's organizational decisions (which new agent to spin up next) are triggered by *measurable signals*, not gut feel. This file is the canonical trigger list. It's read by:

- **Cole** at the start of every session (proactive surfacing)
- **The weekly "org-check" cron routine** in Anthropic's cloud (Mondays 14:00 UTC)
- **Heath** when he wants a refresher on what's on the horizon

When any trigger fires, Heath gets a Telegram via `meetdossie.com/api/notify` recommending the next agent. He decides yes/no.

---

## Currently spun-up

| Agent | Role | Spun up | First job |
|---|---|---|---|
| **Cole** | Chief of Staff / Orchestrator | 2026-05-22 | Telegram interface + agent routing |
| **Hadley** | General Counsel | 2026-05-22 | Dossie LLC formation (complete); Operating Agreement draft (next) |
| **Pierce** | Growth, Conversion & Customer Success | 2026-05-23 | Activation funnel fix; 7-day welcome drip |
| `content-verifier` | Subagent — fact-check guardrail | (existing) | Run on every cron-generated post |

---

## On the horizon — triggered when…

### Tier 2 — likely within 30-60 days

#### **Head of Product**
Fires when any of:
- Paying customer count ≥ 25
- ≥ 5 distinct customer feature requests in a 7-day window that Heath can't quickly prioritize
- Any single roadmap decision sitting unresolved for > 48 hours
- Heath asks "what should I build next" twice in two weeks

Why: roadmap decisions get harder as feedback volume grows. Today Cole + Heath handle this ad-hoc — fine at 10 customers, won't scale at 25+.

#### **CFO / Finance**
Fires when any of:
- MRR ≥ $500/month
- Total monthly vendor spend ≥ $200/month (currently $48.33 fixed)
- Year-end ≤ 60 days away (Q4 tax/bookkeeping prep)
- First serious cash flow or runway question Heath asks
- Any investor inquiry or fundraising consideration
- Dossie LLC's first quarterly franchise tax filing approaches

Why: Hadley handles legal-side entity formation; CFO handles operational money (Stripe reconciliation, P&L, tax K-1 prep, vendor consolidation, unit economics, runway). Real value once money is flowing and a real accountant would charge to do this monthly.

### Tier 3 — triggered by specific events

#### **VP Sales**
Fires when any of:
- First Team-tier ($199/mo) signup ready to close (Natalie Megerson is the current candidate)
- First Brokerage-tier (custom pricing) interest expressed
- ≥ 3 customers ask about multi-seat / brokerage pricing in 30 days

Why: B2B-style sales motion differs from self-serve founding signups. Multi-seat sales has discovery calls, custom proposals, procurement. Self-serve doesn't.

#### **CTO / Engineering Lead**
Fires when any of:
- First customer SOC2 / security questionnaire request
- Major incident or outage requiring a written postmortem
- 2+ production regressions in a single 7-day window
- Codebase touches a security-sensitive area Cole doesn't feel sharp on
- First serious architecture decision affecting future scalability

Why: Cole writes code competently for the current scale, but won't push back hard on tech debt or security. A dedicated CTO agent does.

#### **Data Analyst** (likely named when spun up)
Fires when any of:
- Paying customer count ≥ 50 (enough for cohort signal)
- Pierce running ≥ 2 simultaneous A/B tests
- Heath asks "what's our churn rate" / "what's our CAC" / "what's our LTV" and the answer doesn't exist
- Activation dashboard in `/admin` is built but underused (someone needs to read it)

Why: Pierce is a strategist who uses analytics; she doesn't run them at depth. At ≥50 customers there's enough signal to justify a dedicated analyst.

#### **TX Real Estate SME** (likely named when spun up)
Fires when any of:
- Feature decisions requiring deep TREC / TRELA / TAR knowledge come up > 1x/week and the in-app TREC features need expansion
- Expansion to a second state's real-estate vertical (e.g., adding California)
- A regulator inquiry or TREC complaint

Why: Hadley does adjacent regulatory work but doesn't have the day-to-day TREC TC industry knowledge. Could be its own agent, or could be Hadley's expansion.

### Tier 4 — specialty subagents (low overhead, no full role)

#### **Code Reviewer**
Fires when:
- Any production bug ships that should have been caught at PR time (the HCTI `google_fonts: true` bug went stale for 5 days — that was the trigger to think about this agent, but wasn't enough to spin up yet)
- Security-sensitive change without a second set of eyes

#### **Brand-Voice Critic**
Fires when:
- Heath flags voice inconsistency on outgoing copy > 1x in a 30-day period
- A founder ever says "this didn't sound like Dossie"

#### **Privacy Auditor**
Fires when:
- First new feature touches sensitive user data (driver's license scans, etc.)
- First privacy-related customer question
- New subprocessor added (changes to Privacy Policy)

---

## How to update this file

Cole appends new tier or new trigger conditions as roles emerge from real bottlenecks. When an agent is spun up, move them from "On the horizon" to "Currently spun-up." Keep the historical reasoning so Heath can audit why a role was created.

**Last updated:** 2026-05-23 by Cole on creation.
