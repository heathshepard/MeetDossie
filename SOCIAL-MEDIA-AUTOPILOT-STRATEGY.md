# Social Media Autopilot — Build Strategy

**Status:** Backlog (CLAUDE.md section 8). Not yet started.
**Owner:** Heath
**Strategic doc created:** 2026-05-21
**Last reviewed:** 2026-05-21

The customer-facing extension of Dossie's in-house social pipeline. Lets agents connect their FB/IG/LinkedIn/TikTok, get auto-drafted daily posts personalized to their book, approve with one tap, publish everywhere.

---

## 1. Personalization stance — fully personalized

| Approach | Pro | Con |
|---|---|---|
| Generic posts (same content for all) | Easy maintenance | Spammy at scale, agents won't pay $20/mo |
| Lightly personalized (name/brokerage/market in templates) | Manageable | Looks templated up close |
| **Fully personalized (listings, deals, sphere, market data)** | Real value, justifies price | More complex inputs |

**Decision: fully personalized.** Otherwise the feature isn't worth charging for, and customers (Texas REALTORS) need to look authentic.

**Inputs we already have:**
- Agent profile (name, brokerage, market, photo)
- Closed deals (from `dossier_milestones`)
- Active dossiers
- TREC knowledge (Dossie's existing expertise)

**Inputs we DON'T have yet:**
- Active listings (MLS integration — varies by region, harder than it sounds)
- Sphere / CRM contacts
- Personal media

---

## 2. Content pillars — start with 5, never 20

Tight library = manageable QA. Sprawling library = maintenance nightmare.

1. **Market insight** — "Did you know homes in Boerne close 6 days faster than the Texas average?" (uses public market data, no agent inputs needed)
2. **TREC education** — "Most agents don't realize TREC paragraph 23 lets you..." (Dossie's existing expertise)
3. **Just closed** — "Just closed on 1847 Vintage Way — 25 days from contract to keys" (pulls from `dossier_milestones`)
4. **Sphere check-in** — "Texas friends, who's thinking about buying this fall? Hit reply" (universal evergreen)
5. **Behind-the-scenes** — "This week: 3 inspections, 1 amendment, and a closing card that made my client cry. Real estate." (light-touch authenticity; needs weekly inputs from agent)

**MVP scope: pillars 1, 2, 4 only** (zero agent-specific input data needed). Phase 2 adds 3, 5.

---

## 3. Architecture — multi-tenant the safe way

The whole point: **same code, different rows. Never per-agent systems.**

```
agent profile data ──┐
                     ▼
              template engine
              (Claude Haiku + pillar)
                     │
                     ▼
              approval queue
              (per-agent Telegram or in-app)
                     │
              approved ▼
              Zernio publish OR direct platform APIs
              (per-agent connected accounts)
                     │
                     ▼
              analytics + failure alerts
              (centralized to admin)
```

Reuses ~80% of the in-house pipeline (`cron-generate-posts.js`, `cron-send-for-approval.js`, `cron-publish-approved.js`). Multi-tenancy = `WHERE agent_id = X` rather than building parallel systems.

---

## 4. Failure modes + mitigations

| Failure | Likelihood | Mitigation |
|---|---|---|
| Bad content generated (hallucination / wrong fact) | Medium | Mandatory human approval. Never full auto-post. |
| Agent doesn't approve, pipeline silently dies | High | Auto-skip after 24h. Email alert to agent at 72h dormancy. |
| Zernio account auth expires | High at scale | Centralized alert to Heath + agent. Auto-pause that agent's pipeline. |
| Bad template causes complaints | Medium | Retire within 24h. Version templates so rollback = 1 commit. |
| Compliance issue (Fair Housing, REALTOR® TM) | Critical | Pre-approve every template by Heath OR a Texas RE attorney before deploying. Locked template library. |
| Image/media generation fails | Medium | Always have a fallback (template-rendered card with text only). |
| MLS data quality / freshness | Medium | Manual override always available. Agent can edit any post before approval. |
| Edge case: agent has zero listings + zero deals | High at MVP | Fallback to evergreen pillars (1, 2, 4). |

---

## 5. The Zernio multi-tenant question — load-bearing unknown

Currently Heath has ONE Zernio Pro plan at $18/mo, connected to MeetDossie's social accounts. For customers to use it:

**Option A — Each customer has their own Zernio account ($18/mo each)**
Pass through cost or eat it. Linear scale. Easiest integration.

**Option B — Master Zernio account, agents connect via OAuth sub-accounts**
Depends on Zernio's multi-tenant pricing model. Need to call Zernio sales before designing.

**Option C — Skip Zernio entirely, use direct Meta Graph API / LinkedIn / X / TikTok APIs**
Handle OAuth + posting ourselves. More code but cheaper at scale. Right long-term answer.

**This question MUST be resolved before the cost model is finalized.** Path forward: call Zernio about multi-tenant pricing, then decide A/B/C.

---

## 6. Phased rollout

### Phase 1 — Beta (4 weeks, 5 founding members)
- 3 templates only (Market insight, TREC education, Sphere check-in)
- Text-only posts (no images)
- Per-agent Telegram approval (reuses existing flow)
- 1 post per platform per day max
- Heath manually monitors first 100 posts
- Single tenant (each agent) maps to one set of pipeline rows

### Phase 2 — General availability (after 4 weeks of clean Phase 1 operation)
- Add Just-Closed + Behind-the-Scenes templates (requires dossier data integration)
- Add image generation (HCTI card or Pexels stock)
- Open to all founding members
- $20/mo add-on, $10/mo for founding members (50% discount)

### Phase 3 — Scale (when at 25+ paying users)
- Native FB Graph + IG API instead of Zernio (lower per-user cost)
- Multi-platform variant generation (each post tuned per platform)
- Agent self-serve dashboard (pause/resume/adjust frequency)
- Possible price drop to $15/mo as API costs come down at scale

---

## 7. Cost math

| Cost component | Per user / month |
|---|---|
| Claude Haiku for content gen (~180 posts) | $0.30 |
| Image generation (HCTI or Pexels API) | $0.50–1.00 |
| Zernio multi-tenant (Option A worst case) | $0–18 |
| Direct platform APIs (Option C at scale) | ~$0 |
| Supabase storage + DB rows | <$0.10 |
| **Total realistic cost** | **$1–20 / user / month** |

**Price target depends on Zernio decision:**
- If Zernio multi-tenant works at reasonable rates: $20/mo add-on, $10/mo for founders
- If direct platform APIs (Phase 3): $15/mo add-on, $7.50/mo for founders

Margin target: minimum 70%.

---

## 8. Maintenance estimate

If architected right (single pipeline + tight template library + mandatory approval):
- **2 hours per week** monitoring failures + tuning templates
- **+0.5 hours per new customer** onboarding (OAuth setup, account linking)
- **Quarterly: 1 day** template refresh + compliance review

If architected wrong (per-agent systems, no approval gate, sprawling template library):
- **10+ hours per week firefighting at 20+ customers.** Don't do this.

---

## 9. Non-negotiable design constraints

1. **Mandatory human approval before every post.** Approval is the safety net.
2. **Template library capped at 5 in v1, max 10 ever.** Sprawl kills.
3. **Single pipeline, multi-tenant by row** — never per-agent codepaths.
4. **All failure alerts centralized** to one admin queue (Heath sees everything, fixes once, fix applies to all).
5. **Per-agent caps + rate limits** — max 1-2 posts/day/platform/agent. Prevents spam.
6. **Template versioning** — when a template changes, version it. 1-commit rollback.
7. **Compliance review before any template ships.** Texas RE attorney sign-off for v1 templates.

---

## 10. Priority ranking

This is the **#2 add-on priority** after Amendment Drafting:
- Higher revenue potential than Reply Monitoring
- Lower per-user API cost than AI Autopilot
- Pure value-add (saves agents 5+ hours/week)
- Reuses tech already built for the in-house pipeline

Build order suggested:
1. Amendment Drafting (highest customer impact)
2. **Social Media Autopilot** ← this doc
3. Reply Monitoring
4. AI Autopilot

---

## 11. Pre-build decisions still pending

Before starting the build, resolve these:

- [ ] Zernio multi-tenant pricing — call sales
- [ ] Decide A/B/C on Zernio path (drives ~$18/user/mo cost decision)
- [ ] Texas RE attorney for template compliance review (or accept Heath's own review for v1)
- [ ] Image strategy — AI-generated (cost + failure modes) vs. agent-uploaded vs. stock-pulled
- [ ] MLS integration question (for Just-Closed and Listing Showcase pillars in Phase 2)

---

## 12. Success metrics

Phase 1 (beta) success looks like:
- 5/5 beta users still posting at 4 weeks
- <2 hours/week maintenance from Heath
- Zero compliance flags
- Average approval rate ≥80% (agent approves ≥80% of drafted posts unchanged)

Phase 2 (GA) success looks like:
- 25+ paying users on the add-on at 90 days
- Sub-2% churn on the add-on (separate from base churn)
- Net Promoter on add-on: ≥40

If those metrics don't hold, pause and re-scope before pushing harder.
