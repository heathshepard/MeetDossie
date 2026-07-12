# Dossie Daily Regression Suite — Canonical Test Manifest

**Version:** v1 (2026-07-11) — Locked after scan-in silently broken 7+ days.
**Owner:** Cole (writes deltas to Telegram). Atlas maintains coverage.
**Schedule:** Vercel cron 04:00 CT (API subset). Local Playwright runner (PC-side) covers UI subset.
**Table:** `public.regression_runs`
**Report dir:** `.tmp/regression-runs/`

## Test-ID convention

`{category}.{feature}.{variant?}`

Examples: `auth.signin.demo` / `dossier.talk.buyer_purchase` / `api.health.chat`.

## Runner tiers

Each test declares `tier`:

- **`api`** — pure fetch or DB probe. Runs in Vercel cron + local runner. Fast (<5s).
- **`ui`** — Playwright signed-in. Local runner ONLY (Vercel serverless has no Chromium).
- **`db`** — Supabase probe. Runs in Vercel cron + local runner.
- **`cron`** — reads `cron_runs` table. Runs in Vercel cron.

Vercel cron runs `api`+`db`+`cron` tiers. Local runner runs ALL tiers (superset).

## Pass/fail rubric

- **PASS** — assertion holds AND response time < declared budget AND zero uncaught page errors (UI only).
- **FAIL** — assertion violated OR timeout OR page error thrown.
- **SKIP** — dependency missing (e.g. no CRON_SECRET locally). Not counted as failure.

## Non-destructive rule

Every test that mutates data:
- Only touches `demo@meetdossie.com` scope
- Prefixes all created rows with sentinel `REGRESSION-{ts}-`
- Records `id`s created and deletes them in teardown
- Never touches real customer rows (WHERE `user_id != <demo>` is forbidden)
- Stripe test-mode key only; never `sk_live_`

---

## Category 1 — Auth & session (tier: ui unless noted)

- [ ] `auth.signin.demo` — Sign in demo@meetdossie.com via /workspace
  - Assert: session cookie set, redirects to /workspace UI, no console errors
  - Budget: 6000ms
- [ ] `auth.session.persistence` — Reload /workspace, still signed in
  - Assert: no sign-in modal, user email visible
  - Budget: 4000ms
- [ ] `auth.signout` — Click sign out
  - Assert: session cleared, back to /app
  - Budget: 3000ms
- [ ] `auth.session.api` (tier: api) — GET /api/config returns demo profile shape
  - Budget: 2000ms

## Category 2 — Landing pages (tier: ui)

- [ ] `pages.home` — GET / renders
- [ ] `pages.app` — GET /app renders
- [ ] `pages.founding` — GET /founding renders + form present
- [ ] `pages.faq` — GET /faq renders
- [ ] `pages.calculator` — GET /calculator renders
- [ ] `pages.workspace_signed_in` — /workspace renders with demo dossiers
- [ ] `pages.help` — GET /help renders + articles visible
- [ ] `pages.jarvis_pwa` — GET /myjarvis renders + SIGN IN button bound
- [ ] `pages.terms` — GET /terms renders
- [ ] `pages.privacy` — GET /privacy renders

Each page: budget 8000ms, zero console errors (filtered noise), ≥1 interactive element.

## Category 3 — API health (tier: api)

Every /api/* endpoint that a customer path touches. Assert HTTP 2xx or 401 (auth-gated is fine) and response < 5000ms.

- [ ] `api.health.core` — GET /api/health = { status: 'ok' }
- [ ] `api.health.config` — GET /api/config 200
- [ ] `api.health.transactions` — GET /api/transactions (auth) 401 or 200
- [ ] `api.health.documents` — GET /api/documents 401 or 200
- [ ] `api.health.action_items` — GET /api/action-items 401 or 200
- [ ] `api.health.chat` — POST /api/chat with empty body — 400 (not 500)
- [ ] `api.health.founding_count` — GET /api/founding-count = { spots_taken, spots_remaining }
- [ ] `api.health.notify_founding` — POST /api/notify-founding-application 400 on empty
- [ ] `api.health.get_scan_upload_url` — GET returns 401 (not 500)
- [ ] `api.health.get_document_upload_url` — GET returns 401 (not 500)
- [ ] `api.health.scan_contract` — POST returns 401 (not 500)
- [ ] `api.health.extract_form_fields` — POST returns 401 or 400 (not 500)
- [ ] `api.health.fill_form` — POST returns 401 (not 500)
- [ ] `api.health.fill_form_via_docuseal` — POST returns 401 (not 500)
- [ ] `api.health.draft_amendment` — POST returns 401 (not 500)
- [ ] `api.health.generate_card` — POST returns 401 (not 500)
- [ ] `api.health.generate_broll` — POST returns 401 (not 500)
- [ ] `api.health.create_checkout_session` — POST returns 400 or 200 (not 500)
- [ ] `api.health.stripe_webhook` — GET returns 405 (POST-only)
- [ ] `api.health.audit_env_vars` — GET returns 401 (not 500)
- [ ] `api.health.founding_count_ratio` — spots_taken + spots_remaining = 25 (invariant)

Budget per endpoint: 5000ms.

## Category 4 — Dossier creation (tier: ui + db)

- [ ] `dossier.modal.buyer_purchase` — Open "+ New Dossier" modal, pick buyer_purchase, submit
  - Assert: DB row inserted with correct transaction_type, sentinel prefix, deletes after
  - Budget: 15000ms
- [ ] `dossier.modal.seller_listing` — Same via modal, seller_listing
- [ ] `dossier.talk.buyer_purchase` — Via Talk to Dossie: "Create buyer purchase for 1247 Sample Way"
  - Assert: DB row inserted with property_address='1247 Sample Way' and transaction_type='buyer_purchase'
- [ ] `dossier.talk.seller_listing` — Via Talk to Dossie: seller listing
- [ ] `dossier.talk.new_construction` — Via Talk to Dossie: new construction (TREC 23-15)
- [ ] `dossier.talk.farm_ranch` — Via Talk to Dossie: farm & ranch (TREC 25-15)
- [ ] `dossier.talk.residential_lease` — Via Talk to Dossie: residential lease (TAR 2001)
- [ ] `dossier.list.render` — After create: GET /workspace shows the dossier tile
- [ ] `dossier.detail.render` — Click dossier tile, deal detail page renders

## Category 5 — Workspace UI (tier: ui)

- [ ] `workspace.milestones.section` — Milestones section renders
- [ ] `workspace.checklist.section` — Checklist section renders + items visible
- [ ] `workspace.timeline.section` — Timeline section renders
- [ ] `workspace.milestones.card_open` — Click any milestone card → detail modal opens
- [ ] `workspace.checklist.toggle` — Toggle checklist item → optimistic UI + POST /api/action-items succeeds (rolls back)
- [ ] `workspace.settings.open` — Settings drawer opens

## Category 6 — Documents (tier: ui + api)

- [ ] `documents.list.render` — Documents tab renders (may be empty)
- [ ] `documents.upload_url.sign` — POST /api/get-document-upload-url signed as demo → signed URL returned
- [ ] `documents.scan_url.sign` — POST /api/get-scan-upload-url signed as demo → signed URL returned
- [ ] `documents.upload.roundtrip` — Upload 1KB test PDF via signed URL → row appears in documents table
  - Non-destructive: row auto-deleted in teardown
- [ ] `documents.scan.roundtrip` — Trigger /api/scan-contract on demo doc → returns 200 + extracted fields
  - This is the exact class of bug (scan-in) that motivated this suite.
- [ ] `documents.delete.roundtrip` — Delete the test doc → row gone

## Category 7 — Fill-form (tier: ui + api)

- [ ] `fillform.talk.draft_20_19` — Talk to Dossie: "Draft 20-19 for [test dossier]"
  - Assert: form_templates row updated with filled fields, PDF renders
  - Budget: 45000ms (LLM call)
- [ ] `fillform.edit.field_update` — Change one field via workspace UI → PATCH persists
- [ ] `fillform.pdf.download` — Download filled PDF → response has application/pdf content-type + non-zero body
- [ ] `fillform.hadley.no_recent_incidents` (tier: db) — Query customer_experience_incidents WHERE severity='critical' AND created_at > now()-24h AND category='fillform' — should be 0

## Category 8 — Dossie Sign (tier: ui)

- [ ] `dossiesign.dashboard.render` — /admin/dossie-sign renders progress table
- [ ] `dossiesign.simple_send.modal` — Simple Send modal opens from dossier detail
- [ ] `dossiesign.trec_template.pick` — TREC template picker shows 8 forms
- [ ] `dossiesign.place_fields.editor` — Place fields editor loads a template PDF
- [ ] `dossiesign.signature_requests.render` (tier: db) — signature_requests table has ≥ 1 row for demo (seeded)

## Category 9 — Amendment (tier: ui + db)

- [ ] `amendment.talk.draft` — Talk to Dossie: "Draft an amendment for [test dossier] to change close date"
  - Assert: amendments row inserted
  - Budget: 30000ms
- [ ] `amendment.list.render` — Amendment appears in dossier detail

## Category 10 — Talk to Dossie tool calls (tier: ui)

Signed-in chat with tool assertions. Each: budget 30000ms.

- [ ] `talk.tool.create_dossier` — "Create dossier for 999 Test Way" → tool call fires + DB row
- [ ] `talk.tool.update_deal_field` — "Change price to 400000" → transactions.sale_price updated
- [ ] `talk.tool.draft_amendment` — covered by `amendment.talk.draft`
- [ ] `talk.tool.add_action_item` — "Add task: call inspector" → action_items row inserted
- [ ] `talk.tool.list_dossiers` — "Show my deals" → tool returns array

## Category 11 — Voice interface (tier: ui)

- [ ] `voice.orb.render` — Voice orb visible on workspace
- [ ] `voice.pwa.signin_button` — /myjarvis SIGN IN button bound (covered by pages.jarvis_pwa)

## Category 12 — Founding application (tier: ui + api + db)

- [ ] `founding.form.render` — /founding form has all 7 fields
- [ ] `founding.submit.api` (tier: api) — POST /api/notify-founding-application with REGRESSION- payload → 200 + Telegram silently succeeds
  - Non-destructive: row inserted, deleted in teardown by sentinel prefix
- [ ] `founding.count.invariant` (tier: api) — /api/founding-count.taken + .remaining = 25
- [ ] `founding.scarcity.banner` — /founding banner shows current count

## Category 13 — Stripe checkout (tier: api)

Test mode ONLY. Never touches real customer subscriptions.

- [ ] `stripe.checkout.founding_session` — POST /api/create-checkout-session with test payload → returns session URL
- [ ] `stripe.webhook.method_gate` — GET /api/stripe-webhook returns 405
- [ ] `stripe.subscriptions.recent_activity` (tier: db) — subscriptions table has at least 1 row updated in last 7d (or skip if none this week)

## Category 14 — Content pipeline (tier: db + api)

- [ ] `content.social_posts.recent` — social_posts has ≥ 1 row created in last 24h
- [ ] `content.publish_approved.recent` — cron_runs shows cron-publish-approved ran in last 60m
- [ ] `content.zernio_health` (tier: db) — platform_health_state has last_probe_ok=true for ≥ 3 of 5 platforms
- [ ] `content.calendar.populated` — content_calendar has 25 rows (invariant)
- [ ] `content.posting_schedule.populated` — posting_schedule has ≥ 30 rows (invariant, 5 platforms × 6+ slots)

## Category 15 — Email flow (tier: db + api)

- [ ] `email.queue.recent` — email_queue OR outbound_email_queue processed a row in last 24h
- [ ] `email.morning_brief.recent` — morning_brief_email_log has row from last 24h
- [ ] `email.follow_up.compose` (tier: ui) — Talk to Dossie: "Draft follow-up to [demo party]" → email_queue row appears

## Category 16 — Cron health (tier: cron)

Read `cron_runs` table. For every cron scheduled to run daily-or-more-often, assert `last_run > now() - (interval + 2h buffer)`.

- [ ] `cron.alert_health` — every 5m → last_run < now() - 15m
- [ ] `cron.publish_approved` — every 30m → last_run < now() - 90m
- [ ] `cron.staging_watcher` — every 2m → last_run < now() - 15m
- [ ] `cron.send_outbound_emails` — every 1m → last_run < now() - 15m
- [ ] `cron.agent_queue_tick` — every 1m → last_run < now() - 15m
- [ ] `cron.pull_post_analytics` — daily 06:00 → last_run < now() - 30h
- [ ] `cron.platform_health_checker` — every 2h → last_run < now() - 4h
- [ ] `cron.followup_check` — every 15m → last_run < now() - 45m
- [ ] `cron.morning_brief` — daily 12:00 UTC → last_run < now() - 30h
- [ ] `cron.morning_ops_digest` — daily 13:00 UTC → last_run < now() - 30h
- [ ] `cron.daily_platform_health` — daily 03:00 → last_run < now() - 30h
- [ ] `cron.autonomous_loop` — daily 11:00 → last_run < now() - 30h
- [ ] `cron.dossie_sign_completion_loop` — every 20m → last_run < now() - 60m
- [ ] `cron.deadline_reminders` — daily 13:05 → last_run < now() - 30h
- [ ] `cron.email_digest` — daily 13:00 → last_run < now() - 30h
- [ ] `cron.pipeline_health` — daily 13:00 → last_run < now() - 30h
- [ ] `cron.self_improvement_daily` — daily 10:00 → last_run < now() - 30h
- [ ] `cron.calculator_deadline_reminders` — daily 13:00 → last_run < now() - 30h
- [ ] `cron.dossie_full_diagnostic` — daily 10:00 → last_run < now() - 30h
- [ ] `cron.codebase_facts_indexer` — every 6h → last_run < now() - 8h

## Category 17 — DB health (tier: db)

- [ ] `db.orphans.transactions_user` — transactions WHERE user_id NOT IN (auth.users) = 0
- [ ] `db.orphans.documents_transaction` — documents WHERE transaction_id NOT IN (transactions) = 0
- [ ] `db.orphans.action_items_transaction` — action_items WHERE transaction_id NOT IN (transactions) = 0
- [ ] `db.rls.customer_tables_enabled` — transactions/documents/action_items/social_posts/subscriptions all rls_enabled = true
- [ ] `db.invariant.founding_seats` — subscriptions WHERE tier='founding' AND status='active' ≤ 25
- [ ] `db.invariant.no_duplicate_founding_email` — no duplicate (email, tier='founding') in subscriptions
- [ ] `db.freshness.cron_runs` — cron_runs table has ≥ 20 rows updated in last 24h (system is alive)
- [ ] `db.freshness.audit_logs` — audit_logs has ≥ 1 row in last 7d

---

## Coverage total (target)

- Auth: 4 · Pages: 10 · API health: 21 · Dossier: 9 · Workspace: 6 · Documents: 6
- Fill-form: 4 · Dossie Sign: 5 · Amendment: 2 · Talk tools: 5 · Voice: 2 · Founding: 4
- Stripe: 3 · Content: 5 · Email: 3 · Cron: 20 · DB: 8

**Total: 117 test points** (v1 baseline; grows as customer surface grows).

## When to add a new test point

Any time a customer reports a bug that a script could have caught:
1. Add row to this manifest
2. Add the assertion to the correct `_lib/*-tests.mjs`
3. Bump total count
4. Commit under `chore(regression): +1 test point for [feature]`

That is the only way regressions get baked in permanently.
