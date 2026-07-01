# Self-Improvement Roadmap — 2026-07-01

Ridge, 2026-07-01. Owner: Ridge (queue orchestration) + individual task owners.
Authorized by Heath 2026-07-01 07:07 CDT.

## Purpose

Five capability upgrades Heath authorized on 2026-07-01. These are
infrastructure-tier improvements that make every future ship faster, safer,
and better instrumented. They compete for the same agents as the Dossie Sign
completion loop, so they queue BEHIND Dossie Sign work and only get worked on
between Dossie Sign dispatches (per the coordinator hook in
`api/cron-autonomous-loop.js` that yields when `dossie_sign_dod_progress`
has any red gates).

## Priority + queueing model

- Placed in `docs/TECH-DEBT.md` NOT DONE section with **🚨 SELF-IMPROVEMENT
  2026-07-01** prefix so `gatherTechDebt()` picks them up at SCORE=50
  (TECH_DEBT_URGENT).
- Dossie Sign work stays at SCORE=100 (customer-bug tier per
  `feedback_dossie_sign_must_work_before_new_ships.md`) and will always
  pre-empt these.
- Each item has its own cooldown so parallel progress is possible if Dossie
  Sign is green during a given 4h window.

## The 5 authorized items

### 1. Cross-session memory — Jarvis context mirror finalization

**Why:** Agents keep losing the week's context when a session drops. Rule
`feedback_mirror_memory_to_jarvis_context.md` says every strategic memory
write should also POST to `/api/cole-write-context` so Jarvis reads it, but
the mirror layer isn't fully wired. When Cole restarts, we lose which
customer conversations are hot, which builds are mid-flight, which
decisions were made yesterday.

**Owner:** Atlas ships. Carter drafts.
**ETA:** 2 agent-days after Dossie Sign clears (~4h loop windows).
**Priority:** HIGH inside the self-improvement lane.

**Concrete tasks:**
- [ ] Audit `.claude/projects/**/memory/` writes and count how many mirror to
      `/api/cole-write-context` today (baseline).
- [ ] Add a `mirrorToJarvisContext()` helper in `api/_lib/jarvis-context.js`
      that Cole/Jarvis/agent tools call after every strategic write.
- [ ] Backfill: one-shot script that walks the last 30 days of memory files
      and pushes them into `jarvis_project_context` so Jarvis has full recall.
- [ ] Add a Ridge health check: "how many strategic memory writes in the
      last 7d were mirrored?" → surfaces on `/ventures/reliability`.

**Success metric:** ≥95% of new strategic memory writes appear in
`jarvis_project_context` within 60 seconds.

---

### 2. Regression safety net — Playwright + Vitest CI gate

**Why:** Merges have shipped broken silently multiple times (Dossie Sign
"2xx but no post_id" — months of silent fails, per `feedback_verify_features_before_promoting.md`).
We need a test suite that runs on every merge, exercises every customer-facing
flow signed-in, and blocks merges on failure. No manual verification needed.

**Owner:** Quinn drafts scenarios. Carter drafts CI wiring. Atlas ships.
**ETA:** 3 agent-days after Dossie Sign clears.
**Priority:** HIGH inside the self-improvement lane.

**Concrete tasks:**
- [ ] Quinn: list every customer-facing flow (signup, login, workspace,
      Dossie Sign send, upload, dossier create, share, cancel). One
      Playwright scenario per flow with signed-in fixtures.
- [ ] Carter: draft `.github/workflows/regression-gate.yml` that runs the
      Playwright suite on every PR to `main`. Blocks merge on any red.
- [ ] Carter: draft Vitest coverage for pure logic — extract-form-fields,
      fill-form validators, KPI drift math.
- [ ] Atlas: ship. Verify CI runs on next PR + gates as expected.
- [ ] Ridge: add "last regression run passed?" to `/ventures/reliability`.

**Success metric:** No PR merges to main without a green regression run.
Every customer-facing flow re-verified on every merge, zero human toil.

---

### 3. More outbound tools — Bitwarden, Zoom, Twilio, Stripe deeper

**Why:** The Jarvis SaaS vault + wallet vision needs outbound capabilities we
don't have. Zoom + Twilio are trivial via Zapier and enabled 2026-07-01.
Bitwarden and deeper Stripe are the harder pieces.

**Owner:** Atlas ships. Hadley reviews any customer-touching config.
**ETA:** Zoom + Twilio DONE 2026-07-01 (tools enabled). Bitwarden + deeper
Stripe = 2 agent-days after Dossie Sign clears.
**Priority:** MID inside the self-improvement lane.

**Concrete tasks:**
- [x] Zoom Zapier action enabled 2026-07-01 (10 actions live incl.
      `create_meeting`, `find_meeting`, `find_recording_and_download`,
      `get_summary`). Auth URL pending Heath connect.
- [x] Twilio Zapier action enabled 2026-07-01 (4 actions live incl. `smsv2`,
      `callv2`, `send_whatsapp_message`). Auth URL pending Heath connect.
- [ ] Bitwarden: no direct MCP integration exists. Two options: (a)
      Playwright-driven layer wrapping the Bitwarden web vault UI, or (b)
      Bitwarden CLI wrapper called via server-side subprocess. Flag for
      Atlas to choose based on session-token stability.
- [ ] Stripe deeper: subscription management (upgrade/downgrade mid-cycle),
      refund automation, dispute handling. Extend `api/stripe-webhook.js` +
      add `api/stripe-manage.js` for admin actions.
- [ ] Heath action items surfaced separately: (i) connect Zapier Zoom auth
      URL, (ii) connect Zapier Twilio auth URL. Both one-click.

**Success metric:** Jarvis can schedule a Zoom, send a Twilio SMS, retrieve
a vault credential, and process a refund — all without human touch after
initial auth.

---

### 4. Auto-postmortem on failed missions

**Why:** When a ship breaks (customer bug hits prod, Playwright APV fails
post-merge, cron persistently errors), we should automatically dig into
what happened + propose a rule update. Today this is manual and inconsistent.

**Owner:** Ridge owns. No agent-time from Carter/Atlas needed for MVP.
**ETA:** 1 agent-day. Can start alongside Dossie Sign work (no conflict).
**Priority:** MID inside the self-improvement lane.

**Concrete tasks:**
- [ ] Ridge: build `api/cron-mission-postmortem.js` that runs daily 5 AM CDT.
- [ ] Reads: `support_tickets` closed as bugs in last 24h, `cron_runs`
      transitioning from error→error persistently, any `agent_queue` row
      that flipped to `failed` status.
- [ ] Correlates each failure with the commits that shipped in the 48h
      window before, using `git log --since='48 hours ago'`.
- [ ] For each correlated pair, drafts a `docs/postmortems/YYYY-MM-DD-<slug>.md`
      with: what broke, when, likely cause, proposed rule update (memory file
      or CLAUDE.md gate).
- [ ] Telegrams Heath a summary of the day's postmortems only if ≥1 exists.
      Silence = no failures = healthy.

**Success metric:** Every prod-bug or persistent-cron-fail gets an auto-drafted
postmortem within 24h. Recurring failures get their rule proposal within 48h.

---

### 5. Customer voice / product analytics — PostHog on Dossie

**Why:** We don't know which features Brittney actually uses. We don't know
where signup drops off. We don't know which app pages get zero traffic.
Every product decision today is guesswork.

**Owner:** Carter ships instrumentation. Pierce drafts dashboards +
retention cohorts.
**ETA:** 3 agent-days after Dossie Sign clears.
**Priority:** MID inside the self-improvement lane.

**Concrete tasks:**
- [ ] Choose PostHog (self-host free tier) vs Mixpanel (free up to 1M
      events/mo). PostHog default because we already run Supabase and
      PostHog integrates cleanly.
- [ ] Carter: add PostHog SDK to `Dossie` repo. Wire pageview + button
      click + form fill + Dossie Sign send + doc upload + dossier create.
- [ ] Respect `profiles.is_demo=true` — exclude demo accounts from analytics
      per `project_is_demo_flag.md`.
- [ ] Pierce: build 3 retention cohorts (D1/D7/D30 activation) and one
      funnel dashboard (signup → first doc upload → first dossier).
- [ ] Ridge: add "PostHog receiving events?" health check to
      `/ventures/reliability`.

**Success metric:** Within 7d of live, we can answer "how many founding
members used Dossie Sign this week?" and "where does the app funnel drop
off?" without eyeballing Supabase.

---

## Constraints enforced by the loop

- **Dossie Sign priority preserved.** `gatherDossieSignLastMile()` returns
  before `gatherTechDebt()` in `cron-autonomous-loop.js`, and the
  coordinator hook already yields to the dedicated Dossie Sign completion
  loop when `dossie_sign_dod_progress` has red gates.
- **Silent execution.** Per `feedback_no_permission_asks_ship_missions.md`,
  the loop dispatches without asking. Guardrails escalate only for spend,
  legal, strategy pivot, or force-merge.
- **Cooldowns prevent thrash.** Tech-debt cooldown = 24h, so each item gets
  worked at most once per day.

## How to see progress

- Live: `meetdossie.com/ventures/reliability` (Ridge's dashboard)
- Table: `select * from autonomous_loop_runs where run_ts > now() - interval '7 days' order by run_ts desc;`
- Morning brief: 6 AM CDT daily via Telegram (already wired via
  `cron-autonomous-daily-digest.js`).

## Files this roadmap touches

- `docs/TECH-DEBT.md` — 5 new URGENT-tagged items (below the existing tech
  debt) so `gatherTechDebt()` picks them up.
- `docs/self-improvement-roadmap-2026-07-01.md` — this file.
- No API/code changes yet — those come as the loop dispatches each item.
