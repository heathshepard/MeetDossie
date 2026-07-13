# Session Diary — Dossie / Shepard Ventures

One entry per session. Plain English. Focus: people mentioned, decisions made, open threads, action items. This is the layer the auto-summary drops.

---

## 2026-07-13 (Monday) — Dossie Sign Rounds 7 + 8 both PASS

**Decisions:**
- Round 7 (TREC 36-11 HOA Addendum × Template mode): 8/8 tests PASS on staging AND prod. DoD #21 signer view confirmed with 4/4 prefill values rendered on filled PDF.
- Round 8 (OP-L Lead-Based Paint × Template mode): 11/11 tests PASS on staging AND prod. OP-L is first canonical template with SIX submitters (Buyer 1/2, Seller 1/2, Buyer Broker, Seller Broker). DoD #21 verified by opening BOTH Seller 1 view (sees property + lead-paint knowledge fields) and Buyer 1 view (sees inspection option checkboxes).

**Built:**
- `api/esign-templates.js` — added TEMPLATE_ROLES['4111321'] + TEMPLATE_ROLES['4023469'] (6-role broker split), TEMPLATE_FIELD_MAPPERS for both templates, extended normalizeRoleForTemplate() to route "Buyer Broker"/"Seller Broker" correctly (was incorrectly collapsing to "Buyer 1"), extended registry entries with HOA + Lead-Paint semantic prefill fields.
- `Dossie/src/components/EsignModal.jsx` — added TemplatePicker UI form sections for hoa_addendum (HOA name, resale delivery days, transfer fee, fee payer) and lead_paint_addendum (seller knowledge dropdown, description, records available, inspection option).
- `.tmp/round7-36-11/walk-7-1.js`, `walk-7-2-test21.js` + summary files.
- `.tmp/round8-op-l/walk-8-1.js`, `walk-8-2-test21.js` + summary files.

**Baseline gap (Round 7.1 pre-fix):** 10 PASS / 2 FAIL — property_address + HOA name not populated on 36-11 (default mapper passed keys through unchanged; field names on 36-11 are label-like "Street Address and City" not "property_address").

**GOLD tags today:**
- GOLD-2026-07-13-v10-36-11-hoa-template-support
- GOLD-2026-07-13-v11-op-l-lead-paint-template-support

**Merge state:** Rounds 7 + 8 shipped in single commit `3707e98d`, merged to main via worktree `MeetDossie-atlas12`, prod deploy verified.

**Signer view evidence:**
- 36-11 HOA prod: `.tmp/round7-36-11/walk-7-2-signer-view-buyer1-1783971161073.png`
- OP-L Seller 1 prod: `.tmp/round8-op-l/walk-8-2-signer-view-seller1-1783971169035.png`
- OP-L Buyer 1 prod: `.tmp/round8-op-l/walk-8-2-signer-view-buyer1-1783971169035.png`

**Architectural note:** OP-L is the first canonical template introducing broker submitter roles. The role dispatcher was updated to check for /broker|agent/i FIRST so "Buyer Broker" no longer collapses to "Buyer 1" via the /^buyer/i prefix branch. Also refined the Buyer/Seller regex to only match `^Buyer(\s*\d+)?$` shape, preventing false positives across future templates that mix numbered + broker roles.

---

## 2026-07-11 (Saturday) — Daily Regression Suite v1 shipped

**Decisions:**
- Daily automated regression suite locked. Heath approved after discovering scan-in silently broken 7+ days.
- 4-layer architecture: canonical manifest (117 test points), Playwright runner, delta-aware Telegram alerts, `regression_runs` Supabase table for trend tracking.
- Runner uses PURE Playwright + direct fetch/DB calls. Zero Anthropic API dependency — survives when the Anthropic account is capped (like today).

**Built:**
- `scripts/daily-regression-suite/manifest.md` — 117 test points across 17 categories (auth, pages, api-health, dossier, workspace, documents, fill-form, dossie-sign, amendment, talk-tools, voice, founding, stripe, content, email, cron-health, db-health).
- `scripts/daily-regression-suite/run.mjs` — main runner. Supports `--tiers api,db,cron,ui` and `--categories` filters. `.env.local` auto-loaded on Windows.
- `scripts/daily-regression-suite/_lib/{config,http,supabase,report,api-tests,db-tests,cron-tests,ui-tests,playwright-signin}.mjs` — modular sub-libs.
- `api/cron-regression-suite.js` — Vercel cron entry (API+DB+cron tiers only; Playwright can't run in Vercel serverless). Delta-aware Telegram alerts. Wired to `0 9 * * *` (04:00 CT).
- Supabase migration `create_regression_runs_table` applied. Table columns: run_at, source, base_url, total_tests, passed, failed, skipped, duration_ms, results (jsonb), deltas (jsonb), alert_sent, notes. RLS on, service-role only.
- Package.json shortcuts: `npm run regression`, `regression:api`, `regression:staging`.

**Baseline run findings (real issues surfaced by the suite):**
- 51/59 passing on api+db+cron tiers (86%).
- `db.freshness.audit_logs` FAIL — no audit_logs writes in 7d.
- `db.orphans.documents_transaction` FAIL — 51 orphan documents in DB.
- `db.orphans.action_items_transaction` FAIL — 3 orphan action_items.
- `db.content.social_posts_recent` FAIL — no social_posts created in 24h.
- `db.email.morning_brief_recent` FAIL — no morning_brief_email_log in 30h.
- `cron.cron-alert-health` + `cron.cron-agent-worker-tick` FAIL — genuinely lack telemetry (both crons don't wrap with `withTelemetry`).

**Open threads / pending Heath actions:**
- Wire telemetry into `alert-health.js` + `cron-agent-worker-tick.js` (both crons run but don't record).
- Investigate why `morning_brief_email_log` hasn't fired in 30h (audit trail broken).
- Investigate 51 orphan documents (data integrity issue — likely from bad deletes).
- Investigate why social_posts stopped creating in last 24h (content pipeline stalled).
- Once staging merge lands, Vercel cron will run at 04:00 CT tomorrow and Telegram Heath the delta.

**Tag:** `GOLD-2026-07-12-v1-daily-regression-suite` (to apply after merge).

---

## 2026-05-29 (Thursday)

**People:**
- Amber Higgs — solo broker, referred by Lisa Nilsson (founding member #12). Heath wants to call her about Dossie. Text drafted by Pierce and sent. Awaiting her reply.
- Natalie Megerson — founding member #10, multi-market (SA/Austin/San Marcos), REAL Broker. HOT team-tier lead. Call scheduled June 3 at 10am.
- Danielle Scott — team lead with agents, in-person demo scheduled then pushed. No new date set.
- Ginger Unger — Texas RE educator/influencer, highest-leverage affiliate lead. Heath DM'd her 2026-05-21. No response yet. Sage flagged: follow up this week.

**Decisions made:**
- DossieSign = official brand name for fill-and-sign feature. "Fill it, sign it, send it. All in Dossie."
- Carter runs fully autonomous multi-block builds. Cole is relay/dispatcher only (60-second handoffs). Cole never reviews code.
- FB group posts format locked: group name + media + copy, one at a time. Reply DONE to get next.
- Every person/task Heath mentions gets a memory entry immediately — no exceptions.
- Session diary (this file) starts today to capture what auto-summaries miss.
- DossieSign full chain (agent signer + seller's agent email) built but NOT merged to main — holding until full transaction lifecycle is complete.

**Built today:**
- DossieSign full chain: buyer 1 → buyer 2 → agent → seller's agent gets executed PDF auto-emailed
- Transaction type model (buyer_purchase / seller_listing / etc.) on transactions table
- Wire fraud warning generator (TAR 2517) + delivery log — PLACEHOLDER: Heath needs TAR 2517 PDF from texasrealtors.com member portal
- Option period tracking (fee, earnest money, confirmations + reminders)
- Inspection tracking (inspector info, dates, report received)
- Appraisal tracking (ordered/received/value, gap calculation, TREC 49-1 auto-surface)
- Repair amendment via Talk to Dossie
- Agent activity dashboard in ventures.html (Atlas built)
- Sage social strategy + knowledge base + engagement scripts (3 files in Shepard-Ventures/Marketing/)
- Hadley filed Hiscox E&O insurance docs
- Full transaction lifecycle gap analysis (DOSSIE-TRANSACTION-GAP-ANALYSIS.md)
- Video library project plan (DOSSIE-VIDEO-LIBRARY.md)
- Carter build prompt for full 14-block transaction lifecycle (CARTER-TRANSACTION-BUILD-PROMPT.md)
- Blocks 3-5 in progress (Carter running) — title, HOA, closing checklists next

**Full transaction lifecycle build — COMPLETE (all 14 blocks):**
GOLD-2026-05-29-v7-full-transaction-lifecycle on staging. Buyer-side residential resale from pre-contract to recorded deed. 6 placeholder PDFs need real files before production generators are live (TAR 2517, TREC 36-11, OP-L, TAR 1501, TREC 49-1, T-47). Heath to test on staging then say "merge it."

**Open threads / pending Heath actions:**
- Get TAR 2517 PDF from texasrealtors.com member portal → base64-encode → paste into api/_assets/tar-wire-fraud-base64.js
- Run ventures_agents SQL migration (4 ADD COLUMN statements) for Atlas agent dashboard timing fields
- Revoke both Google App Passwords at myaccount.google.com/apppasswords
- Click Gmail "Send mail as heath@meetdossie.com" confirmation link
- Natalie Megerson call June 3 at 10am
- Mercury bank transfer ($500 when card arrives)
- Check Hiscox retroactive date at hiscox.com (Hadley flagged — determines pre-May coverage)
- Cyber Liability insurance gap — Hiscox E&O doesn't cover data breaches. Hadley recommends Embroker or Coalition/Cowbell quote.
- Cancel window for Hiscox closes June 11 if switching.
- Merge staging → main when full transaction lifecycle build is complete (Blocks 6-14 still running)
- Follow up Ginger Unger (DM sent 2026-05-21, no response — Sage recommends engage with her posts first)
- Send Brittney 30-day testimonial ask (brittney@setxrealty.com)
- Amber Higgs — awaiting her reply to text

**3 FB group posts done today:**
- D/FW REALTORS: option period deadline tip (pure value)
- Texas Real Estate Network: AI contract drafting question (natural DossieSign mention)
- Realtors SA/Boerne/Bulverde/New Braunfels: TC cost math post

**Social posts approved today:**
- Instagram, LinkedIn (founding count fixed to 38), Facebook, 2x Twitter — all approved and queued

---

## 2026-05-29 (Thursday) — afternoon/evening continuation

**People:**
- Amber Higgs — text sent ~17:54 UTC ("Hey Amber a long time no talk lol..."), awaiting reply
- Natalie Megerson — call still scheduled June 3 at 10am
- Ginger Unger — no response to DM (2026-05-21), follow up via engaging her posts first

**Built today (continuation):**
- 6-button transaction type modal — Buyer Purchase, Seller Listing, New Construction, Land Purchase, Lease Landlord, Lease Tenant — built, merged to main
- New Construction section (builder info, 7-phase tracker, CO/possession, punch list)
- Land Details section (acreage, survey, utilities, environmental)
- Residential Lease section (lease terms, key dates, move-in, tenant/landlord info, HOA)
- TREC form handlers: TREC 9-17 (270 AcroForm fields, full fill handler), TREC 23/24/25 (flat PDFs, handlers built but produce unmodified PDF until TREC releases AcroForm versions)
- fill-form.js auto-routing by transaction_type (land → TREC 9, new_home → TREC 23)
- Quinn QA agent — Atlas built; auto-runs after every Carter staging push; reports to Telegram; max 3 Carter loops; Heath still says "merge it" before main

**Staging URL fixed:**
- Vercel Deployment Protection was blocking branch alias URL; Heath disabled it in settings
- Static URL: https://meet-dossie-git-staging-heathshepard-6590s-projects.vercel.app

**Decisions made:**
- Quinn always runs autonomously after Carter pushes to staging — no Heath prompt needed
- Errors found by Quinn always get fixed before merge — no exceptions, no "non-blocking" exemptions
- Heath must explicitly say "merge it" before Cole touches main — Quinn passing is not sufficient
- ZipForms/TAR credentials: .env.local is fine (never goes to GitHub); Heath to add TAR_USERNAME + TAR_PASSWORD
- Heath's voice calibrated from Gmail sent emails — warm, casual, lowercase, never corporate, no typos replicated

**GOLD tags today:**
- Through GOLD-2026-05-29-v15 (TREC form handlers, on staging, Quinn PASSED, awaiting Heath "merge it")

**Open threads / pending Heath actions:**
- Say "merge it" for v15 (TREC form handlers)
- Add TAR_USERNAME + TAR_PASSWORD to .env.local
- Pull TAR 2001 + 2003 PDFs (residential lease forms) — Carter will build handlers once received
- Natalie Megerson call June 3 at 10am
- Amber Higgs — awaiting reply
- Brittney testimonial ask at 30-day mark
- Ginger Unger — engage posts first, then follow up DM
- Hiscox retroactive date check + Cyber Liability quote (deadline June 11)
- Revoke Google App Passwords (akgljxblvweltkuf, uqtzsgsspnhrcvgh)
- Mercury bank transfer ($500 when card arrives)

**Sage build — NOT done:**
- 14-item autonomous capability list (morning intel, influencer outreach, competitor monitoring, etc.) is queued, not built
- Sage has agent file + knowledge base + posting pipeline, but autonomous monitoring loop not yet built

---
