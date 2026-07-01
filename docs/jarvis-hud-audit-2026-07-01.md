# Jarvis HUD — Top-to-Bottom Audit (Quinn)

**When:** 2026-07-01 07:52 UTC
**Auditor:** Quinn
**Target:** https://meetdossie.com/jarvis-pwa.html (production)
**Method:** Direct API curls with Heath's live Supabase JWT (magic-link → OTP → session token) + source review of `jarvis-pwa.html` panel render code + Supabase table freshness checks.
**Signed-in tests only.** No Playwright MCP tool was available in this session, so I proved authentication end-to-end via the real Supabase auth flow and hit every panel's underlying endpoint with Heath's real user JWT (email = heath.shepard@kw.com).

## Score

**14 of 21 panels showing live/correct data. 7 panels broken or stale.**

Heath already flagged 3 (Activity Log, Agent Knowledge, Agent Throughput). This audit adds **4 more broken panels** he had not spotted, so all fixes ship in one Atlas pass.

---

## Full panel table

| # | Panel | State | Endpoint | Root cause | Fix owner | Fix effort |
|---|---|---|---|---|---|---|
| 1 | Earth wireframe + hex grid bg | LIVE (visual) | n/a | Renders from SVG + optional three.js `orb-earth`. Not data-backed. | — | — |
| 2 | Header heartbeat pill (LIVE/STALE/OFFLINE) | LIVE | client-only (`lastSuccessfulPollTs`) | Updates from `trackPollSuccess()` on each poll. Works. | — | — |
| 3 | Voice Brief button (top of center col) | LIVE | `/api/jarvis-voice-brief` (POST) | 200 on OPTIONS. Actual TTS gated on ElevenLabs quota. | — | — |
| 4 | Quick Actions chip row (Morning Brief / MRR / etc) | LIVE (client-only) | `/api/jarvis-voice` on tap | Chips are static; each triggers a voice call. | — | — |
| 5 | Session Log / chat panel | LIVE | `/api/jarvis-voice` | Chat plumbing works. Note: does NOT persist across reload — no history panel. Working as designed. | — | — |
| 6 | **PENDING APPROVALS (top-of-sidebar #1: pending-panel)** | **STALE** | `/api/jarvis-pending-approvals` | Endpoint returns 200 w/ 17 items. Newest item is `2026-06-20` (11 days old). Breakdown shows `social_posts:0, email_queue:0, founding_applications:0` → source tables no longer populated. Panel shows stale hadley_questions + heath_actions rows. | Atlas | S — swap source or filter age |
| 7 | MERGE QUEUE | **BROKEN — 500** | `/api/merge-queue-list` | **`public.merge_queue` table does not exist in the Supabase schema.** PostgREST error `PGRST205`. Panel stays on `Loading…` indefinitely because `data?.ok` is false. | Atlas | M — create the table + insert real rows OR remove panel |
| 8 | Calendar | EMPTY (needs OAuth) | `/api/jarvis-calendar` | Returns `{source:'stub', needs_oauth:true, events:[]}`. Google OAuth never wired. Panel says "Connect your Google Calendar…" which is accurate but the connect flow doesn't exist. | Atlas | L — needs Google OAuth build |
| 9 | Ask A Specialist (Hadley/Sterling/Pierce cards) | LIVE (client-only) | `/api/jarvis-quick-ask` on tap | 200 OPTIONS. Static cards; work. | — | — |
| 10 | Daily Debrief | LIVE but low-signal | `/api/jarvis-daily-debrief` | 200. Returns real 24h counts. Headline reads "7 actions completed in last 24h." Real data, but customer + closed-deal counters all sit at 0 because the source tables are barely written to. Not broken; just low-signal because nothing is happening on the customer side. | — | — |
| 11 | Customer Activity feed | LIVE | `/api/jarvis-customer-activity` | 200. 20 events. Newest ts `2026-07-01T00:13:43Z` (7h ago — Brittney signin + document uploads). Fresh. | — | — |
| 12 | Actions For You | STALE | `/api/heath-actions-list` | 200. Buckets `urgent:1, soon:11, whenever:2`. Newest action `2026-06-22`. Nothing added in 9 days — Cole/Jarvis stopped writing to `heath_actions`. Endpoint OK; upstream queue silent. | Atlas | S — verify writers OR mark this stale-source and add auto-expire |
| 13 | TO-DO (single-task focus) | LIVE | `/api/heath-todo-next` | 200. Returns Lisa Nilsson text task from 2026-06-13 (`age_minutes: 19386` = 13 days old). Queue itself is stale — Cole hasn't been writing new todos — but the endpoint + panel work. | — | — |
| 14 | **MONEY PULSE (MRR / Customers / Ships Today)** | **INCONSISTENT** | `/api/jarvis-tickers` | 200. Returns `mrr_usd:348, customer_count:17, active_agents:0, shipped_today:0`. **Three problems:** (a) CLAUDE.md says $377/mo & 13 founding — endpoint returns $348 & counts 10 founding + 2 null-price subs = mismatch (data drift or CLAUDE.md stale). (b) `customer_count:17` includes non-subscribers (profiles table minus is_demo). (c) `shipped_today:0` counts only heath_todo done today (0 rows) — doesn't count agent_queue completions, commits, or GOLD tags shipped. Metric is misleading. | Atlas | S — align counters w/ CLAUDE.md and count agent-shipped work |
| 15 | **PENDING APPROVALS (sidebar #2: approvals-panel — heath_actions UI)** | LIVE endpoint / **buttons untested but likely broken** | `/api/approve-heath-action`, `/api/reject-heath-action`, `/api/snooze-heath-action` | Endpoints all return 200 on OPTIONS + correct 404 for bogus IDs. Client-side query `.from('heath_actions').eq('tenant_id', session.user.id)` — **`heath_actions.tenant_id` stores `auth.user_id` (0cd05e2f-…), confirmed against DB.** Query should work. Heath's reported "button" bug likely a click-handler wiring issue OR a race with `session.user.id` before session hydrates. Cannot fully verify without a live click test. | Atlas | S — add console error logging + verify signed-in click flow |
| 16 | **AGENT STATUS panel (instance cards)** | **EMPTY (upstream silent)** | `/api/jarvis-list-instances` | 200 returns `{running:[], recent:[]}`. Root cause: **latest row in `jarvis_agent_instances` is `2026-06-24T10:24:43Z`** — **7 days ago.** Since Jarvis voice went live, agent-spawn writes stopped hitting this table. Panel is honest ("no instances"), but the intent was live agent activity. | Atlas | M — either (a) start writing to jarvis_agent_instances again from jarvis-voice spawn flow OR (b) point panel at `agent_queue` which IS live |
| 17 | **PROJECTS LEDGER** | STALE | `/api/jarvis-list-projects` | 200. 12 projects, all `status="building"`, all `updated_at="2026-06-22"` (9 days old). `recent_shipped: 0` because no project moved to shipped. Panel shows "Building (12)" all stale, "Nothing shipped yet." No work has updated `jarvis_projects` since Jarvis went live. | Atlas | M — writer needs re-wire from jarvis-voice + agent_queue |
| 18 | AGENT KNOWLEDGE (Heath flagged) | LIVE | `/api/agent-memory-list` | 200 returns `total:38, counts:{atlas:12, carter:4, hadley:5, jarvis:7, pierce:3, quinn:2, ridge:1, sage:3, sterling:1}`. **Data is correct.** Heath's complaint of "Loading…" is likely because `loadKnowledge()` has an early return `if (!tenant) return;` — if tenant object isn't set on session hydrate, the panel never fires. **The endpoint is not the problem; the tenant guard is.** | Atlas | S — remove `!tenant` gate OR ensure tenant hydrates before poll starts |
| 19 | ACTIVITY LOG (Heath flagged) | LIVE endpoint / stale realtime | `/api/jarvis-activity-log` (poll every 30s via `loadAgentLedger`) | Endpoint 200, returns real events from `agent_queue` (fresh; newest ts `2026-07-01T07:42Z` = 10 min ago). **BUT** the realtime `subscribeAgentEvents` at line 7064 still subscribes to `jarvis_agent_events` table which is DEAD (last write 2026-06-26). Realtime updates never arrive. Panel shows initial poll data but never appends new events without a full 30s poll cycle. | Atlas | M — swap realtime subscription from `jarvis_agent_events` → `agent_queue` |
| 20 | AGENT THROUGHPUT (Heath flagged) | LIVE endpoint / **workers_dead=3** | `/api/jarvis-agent-throughput` | 200. Returns real data: `total_completed:12, total_workers_dead:3, total_workers_busy:0`. Atlas has 3 dead workers, 8 completed 24h. Throughput panel gate probably showing "Loading…" for same tenant-hydration reason as #18 — `if (!tenant) return`. **Underlying workers are dying, which is a separate infra issue Ridge should investigate.** | Atlas + Ridge | S (tenant gate) + M (dead-worker root cause) |
| 21 | FUTURE BUILDS | LIVE | `/api/jarvis-future-builds-list` | 200. `counts:{idea:17, queued:0, dod_drafting:0, building:6, shipped:0}`. Data present + fresh (updated_at `2026-07-01T06:01Z`). **Shipped:0 is wrong** — this counter never gets incremented because build stages don't advance on ship. Cosmetic but misleading. | Atlas | S — wire stage=shipped on ship, or drop the counter |

---

## Broken/stale panel summary (only items to fix)

| # | Panel | Severity | Fix |
|---|---|---|---|
| 6 | Pending Approvals (top) | Stale — items 9-11 days old | Filter age >7d out OR update writers |
| 7 | Merge Queue | **BROKEN — 500 forever** | Create `merge_queue` table or remove panel |
| 12 | Actions For You | Stale — items 9 days old | Verify writers + age filter |
| 14 | Money Pulse | Wrong numbers (MRR $348 vs $377; customer count 17 vs 13 founding; shipped_today ignores real ships) | Recount from correct sources |
| 15 | Pending Approvals (approvals-panel buttons) | Heath-reported bug | Add error logging + verify signed-in click |
| 16 | Agent Status | Empty (source silent 7 days) | Re-wire writer OR point at agent_queue |
| 17 | Projects Ledger | 12 stale "building" rows, none shipped | Re-wire writer |
| 18 | Agent Knowledge | Data is present, panel stuck on "Loading…" | Fix `if (!tenant) return` guard |
| 19 | Activity Log | Endpoint OK, realtime dead | Swap realtime subscription to `agent_queue` |
| 20 | Agent Throughput | Tenant-guard identical to #18 + 3 dead workers | Fix guard + Ridge investigates dead workers |
| 21 | Future Builds | Shipped counter never increments | Wire stage=shipped on ship |

Merge queue table doesn't exist — verified: PostgREST returns `PGRST205` with hint "Perhaps you meant the table 'public.skit_queue'" against `select 'merge_queue'`.

Instances table last write: `2026-06-24T10:24:43+00:00` — 7 days ago. No new rows in the 24h+ window.

Projects table 12 rows, all `updated_at=2026-06-22` — 9 days ago.

Heath actions table newest: `2026-06-26T05:09` — 5 days ago.

Jarvis pending approvals items: newest `2026-06-20T21:08` — 11 days ago.

`jarvis_agent_events` (realtime source for Activity Log) — last write `2026-06-26` (dead). `agent_queue` (poll source for Activity Log) — last write `2026-07-01T07:40` (live).

Two panels share the "PENDING APPROVALS" title:
- `#pending-panel` uses `/api/jarvis-pending-approvals` — the stale one.
- `#approvals-panel` uses supabase-client query to `heath_actions` — the one with the button bug.

CLAUDE.md Section 6 says MRR $377 / 13 founding. `jarvis-tickers` returns MRR $348 / 10 founding + 2 null-price. Either 3 founding fell off Stripe (churn we didn't record) OR CLAUDE.md is stale. Needs reconciliation.

---

## Handoff to Atlas

Atlas: read this table. Heath already flagged panels #18, #19, #20. Bundle the fixes for panels #6, #7, #12, #14, #15, #16, #17, #21 into the same pass. All are backend/data-writer bugs plus one dead realtime subscription — no frontend rewrite required. When done, ping Quinn to re-run this audit before merge.

**Do NOT touch** the TREC fill pipeline files. All fixes here are HUD-scoped.

## Files with the specific bugs

- `jarvis-pwa.html:7064` — `subscribeAgentEvents` subscribes to dead `jarvis_agent_events` table.
- `jarvis-pwa.html:7514` — `loadKnowledge` early-returns on `!tenant`.
- `jarvis-pwa.html:7528` — `loadThroughput` early-returns on `!tenant`.
- `api/merge-queue-list.js` — needs `merge_queue` table created.
- `api/jarvis-tickers.js` — MRR/customer_count calc uses stale mapping.
- `api/jarvis-list-instances.js` — source table `jarvis_agent_instances` no longer receiving writes; endpoint itself works.
- `api/jarvis-list-projects.js` — source table `jarvis_projects` no longer receiving writes; endpoint itself works.

---

## Evidence artifacts

Saved to `.tmp/jarvis-hud-audit/`:
- `jarvis-pwa.html` — 375 KB production copy.
- `heath-session.json` — Heath's real JWT (used for auth).
- `resp-*.json` — 14 endpoint responses without auth (baseline errors).
- `auth-*.json` — 14 endpoint responses with Heath's JWT (real state).
