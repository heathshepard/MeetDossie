# DOSSIE SYSTEM AUDIT — AUTONOMOUS BUG FINDER

You are an expert QA engineer performing a comprehensive system audit of a production SaaS called **Dossie** — an AI transaction coordinator for Texas real estate agents. The founder cannot manually test everything. Your job is to find real bugs proactively before they cause customer harm.

Work fully autonomously. Read files, query the database, run Playwright browser tests, and report findings. Do not stop until all 10 audit categories are complete. Produce a structured severity report at the end.

---

## SYSTEM CONTEXT

- **Production URL:** https://meetdossie.com
- **Staging URL:** Obtain by running `npx vercel ls` in `C:\Users\Heath Shepard\Desktop\MeetDossie` and finding the latest Preview URL matching `meet-dossie-*-heathshepard-6590s-projects.vercel.app`
- **Supabase project ID:** `pgwoitbdiyubjugwufhk` (use MCP tool `mcp__claude_ai_Supabase__execute_sql` for all DB queries)
- **MeetDossie repo** (Vercel API + deploy): `C:\Users\Heath Shepard\Desktop\MeetDossie`
- **Dossie repo** (React source): `C:\Users\Heath Shepard\Desktop\Dossie`
- **API files location:** `C:\Users\Heath Shepard\Desktop\MeetDossie\api\`
- **Cron jobs:** Listed in `C:\Users\Heath Shepard\Desktop\MeetDossie\vercel.json` under `"crons"` plus external crons (cron-activation-drip, cron-pierce-activation, etc.)
- **Demo accounts:** `demo@meetdossie.com` (Sarah Whitley) and `demo2@meetdossie.com` (John Smith) — both have `is_demo=true` in the profiles table
- **Real paying customers:** 12 founding members at $29/mo (plus 1 friend at $1/mo) — total 13 subscriptions
- **Key tables:** profiles, transactions, documents, action_items, subscriptions, founding_applications, social_posts, email_queue, deadline_reminders, dossier_milestones

---

## HOW TO USE THE TOOLS

- **Read files:** Use the Read tool with absolute paths
- **Search code:** Use Grep tool — never `grep` bash command
- **Find files:** Use Glob tool — never `find` bash command
- **Database queries:** Use `mcp__claude_ai_Supabase__execute_sql` with project_id `pgwoitbdiyubjugwufhk`
- **Browser tests:** Use `mcp__playwright__browser_navigate`, `mcp__playwright__browser_snapshot`, `mcp__playwright__browser_console_messages`, `mcp__playwright__browser_take_screenshot`
- **HTTP requests:** Use `mcp__playwright__browser_network_request` or WebFetch

---

## AUDIT CATEGORY 1: DEMO ACCOUNT ISOLATION

**Goal:** Verify no cron job, email, or metric ever processes demo@meetdossie.com or demo2@meetdossie.com accounts.

**Steps:**

1. Find all cron-*.js files in `C:\Users\Heath Shepard\Desktop\MeetDossie\api\`:
   ```
   Glob: api/cron-*.js in MeetDossie
   ```

2. For each cron file, grep for `is_demo` and `demo@`:
   - **BUG if absent:** any cron that queries `profiles` or `subscriptions` without filtering `is_demo=eq.false` or checking `email NOT LIKE 'demo%'`
   - Crons that send email to real customers MUST exclude demo accounts
   - Crons that only post to social media or Telegram (not email) have lower risk but should still exclude demo data from metrics

3. Run this Supabase query to verify is_demo is set correctly:
   ```sql
   SELECT id, email, full_name, is_demo, subscription_status
   FROM profiles
   WHERE email IN ('demo@meetdossie.com', 'demo2@meetdossie.com');
   ```
   **BUG if:** either row has `is_demo` as null or false

4. Run this query to check if demo users appear in any aggregated metrics queries:
   ```sql
   SELECT COUNT(*) as total, SUM(CASE WHEN is_demo THEN 1 ELSE 0 END) as demo_count
   FROM profiles
   WHERE subscription_status = 'active';
   ```

5. Check `cron-morning-brief.js`, `cron-deadline-reminders.js`, `cron-email-digest.js`, `cron-weekly-newsletter.js`, `cron-activation-drip.js`, `cron-pierce-activation.js`, `cron-followup.js` — each must have explicit demo exclusion.

**Bug severity:** Any demo user receiving a real customer email = CRITICAL. Missing demo filter in metrics = MEDIUM.

---

## AUDIT CATEGORY 2: INTERNAL TEXT LEAKING TO CUSTOMERS

**Goal:** Verify no email or Telegram message sent to real customers contains debug text, variable names, DB column names, undefined values, or internal labels.

**Steps:**

1. Read every file that contains a Resend email send call. Grep `MeetDossie/api` for `resend.com/emails` or `from.*meetdossie.com` to find them. Files to check include: `stripe-webhook.js`, `complete-onboarding.js`, `cron-deadline-reminders.js`, `cron-email-digest.js`, `cron-activation-drip.js`, `cron-pierce-activation.js`, `cron-followup.js`, `cron-weekly-newsletter.js`, `esign-webhook.js`, `send-compliance-packet.js`, `cancel-subscription.js`, `support.js`

2. In each email template (the HTML string passed to Resend), check for:
   - `${undefined}` or unguarded template literals where the variable might be null/undefined
   - Strings like `"Hi there,"` with no name fallback (should use agent's name when available — acceptable fallback is "Hi [First Name]," not "Hi there,")
   - Raw DB column names: `action_item_description`, `transaction_id`, `user_id`, `stripe_customer_id`
   - JSON-like patterns: `{"key":`, `[object Object]`, `null`, `undefined`
   - Internal labels: `TODO`, `TBD`, `PLACEHOLDER`, `[INSERT`, `pending_onboarding`
   - Template variables that were never substituted: `{{`, `%{`, `__NAME__`

3. Check every `sendTelegram` call in the cron files — Telegram messages go to Heath (the founder), not customers, so they can contain internal data. But verify no Telegram message accidentally contains a customer's full transaction details, auth tokens, or service role keys.

4. Specifically check `cron-deadline-reminders.js` — it constructs deadline reminder emails. Verify the deadline label shown to the agent is the friendly label (e.g., "Closing date") not the DB column name (e.g., `closing_date`).

**Bug severity:** Any internal variable name or undefined value in a customer email = HIGH. Generic greeting when name is available = MEDIUM.

---

## AUDIT CATEGORY 3: CRON JOB CORRECTNESS

**Goal:** Every cron endpoint must be properly secured, idempotent, and free of silent error swallowing.

**Steps:**

1. For every `api/cron-*.js` file, check that the handler has auth at the top:
   ```javascript
   // Must have one of these patterns:
   const isVercelCron = req.headers['x-vercel-cron'] === '1';
   const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
   if (!isVercelCron && !isManualAuth) { return res.status(401)... }
   ```
   **BUG if:** any cron file is missing CRON_SECRET auth check entirely

2. Check that every cron has a top-level try/catch. Look for patterns where the main logic runs outside a try block. A cron that crashes without catching will return a 500 but Vercel will show no useful log.

3. Check for duplicate-fire risk — any cron that sends email must either:
   - Track sent state in DB (e.g., `deadline_reminders` table, `activation_email_1_sent_at` column)
   - Use upsert with ON CONFLICT to prevent double rows
   - **BUG if:** a cron queries for records and sends email without marking them as processed, meaning two rapid fires would double-send

4. Run this Supabase query to check for any doubled deadline reminders (same transaction + deadline + days_out sent twice):
   ```sql
   SELECT transaction_id, deadline_type, days_out, COUNT(*) as cnt
   FROM deadline_reminders
   GROUP BY transaction_id, deadline_type, days_out
   HAVING COUNT(*) > 1
   LIMIT 20;
   ```

5. Check `vercel.json` `crons` section — verify no two cron paths are scheduled to fire at the exact same second that could cause race conditions on the same table.

6. Check `cron-activation-drip.js` specifically — it sends a 3-email sequence. Verify it checks that email 1 was sent before sending email 2, and email 2 before email 3. The columns are `activation_email_1_sent_at`, `activation_email_2_sent_at`, `activation_email_3_sent_at` on the profiles table. Verify these columns exist:
   ```sql
   SELECT column_name FROM information_schema.columns
   WHERE table_name = 'profiles'
   AND column_name LIKE 'activation_email%';
   ```

**Bug severity:** Missing CRON_SECRET auth = CRITICAL. No idempotency on email sends = HIGH. Missing error handling = MEDIUM.

---

## AUDIT CATEGORY 4: API ENDPOINT SECURITY

**Goal:** Every customer-facing API endpoint validates auth before doing any work. No secrets leak in responses.

**Steps:**

1. Find all customer-facing endpoints (NOT cron, NOT debug/test files). Key ones to check: `fill-form.js`, `upload-document.js`, `action-items.js`, `documents.js`, `scan-contract.js`, `speak.js`, `esign-create.js`, `esign-status.js`, `esign-download.js`, `form-templates.js` (if it exists), `transactions/*.js`

2. For each endpoint, verify auth is checked **before** any DB query or file operation. The pattern in this codebase uses `verifySupabaseToken` from `./_middleware/auth.js`. Any endpoint that reads or writes customer data without calling `verifySupabaseToken` is a bug.

3. Grep all API files for `SUPABASE_SERVICE_ROLE_KEY` appearing in response bodies:
   ```
   Grep pattern: res\.json.*SERVICE_ROLE|json.*service_role
   ```
   **BUG if:** any endpoint echoes env var contents into a response

4. Check for SQL injection risk — any endpoint that takes user input and constructs a Supabase REST URL by string concatenation without encoding. The pattern `?column=eq.${req.body.something}` is risky if `something` is not validated. Grep for `req.body` or `req.query` values used directly in URL construction without `encodeURIComponent`.

5. Verify CORS headers — customer-facing endpoints should only allow `meetdossie.com` origin, not `*`. Check `fill-form.js`, `esign-create.js`, `scan-contract.js`:
   ```
   Grep pattern: Access-Control-Allow-Origin
   ```
   **BUG if:** non-webhook endpoints use `Access-Control-Allow-Origin: *` (wildcard CORS on endpoints that accept auth tokens)

6. Check `api/get-telegram-token.js` — this file name is alarming. Read it and verify it does not return a real bot token to unauthenticated callers.

**Bug severity:** Auth bypass = CRITICAL. Secret in response = CRITICAL. Wildcard CORS on auth endpoints = HIGH. SQL injection vector = HIGH.

---

## AUDIT CATEGORY 5: DATABASE INTEGRITY

**Goal:** Verify all 12 real customers are properly provisioned and no orphaned/corrupted rows exist.

**Steps:**

1. Verify all 12 paying customers have active subscriptions AND working profiles:
   ```sql
   SELECT p.email, p.full_name, p.is_demo, p.subscription_status,
          s.status as sub_status, s.plan, s.stripe_customer_id
   FROM profiles p
   LEFT JOIN subscriptions s ON s.user_id = p.id
   WHERE p.is_demo IS NOT TRUE
   AND p.email NOT LIKE 'heath.shepard@%'
   AND p.email NOT LIKE '%demo%'
   ORDER BY p.created_at;
   ```
   **BUG if:** any paying customer has `sub_status != 'active'` or null subscription row

2. Check for subscriptions with status='active' but no matching profiles row:
   ```sql
   SELECT s.id, s.user_id, s.plan, s.status, s.stripe_customer_id
   FROM subscriptions s
   LEFT JOIN profiles p ON p.id = s.user_id
   WHERE s.status = 'active'
   AND p.id IS NULL;
   ```

3. Check for orphaned documents (no matching transaction):
   ```sql
   SELECT d.id, d.file_name, d.user_id, d.transaction_id
   FROM documents d
   LEFT JOIN transactions t ON t.id = d.transaction_id
   WHERE t.id IS NULL
   LIMIT 20;
   ```

4. Check for transactions with null or empty address that would cause fill-form to fail:
   ```sql
   SELECT id, user_id, property_address, purchase_price, transaction_type
   FROM transactions
   WHERE (property_address IS NULL OR property_address = '')
   AND user_id IN (SELECT id FROM profiles WHERE is_demo IS NOT TRUE)
   LIMIT 20;
   ```

5. Check founding_applications — every approved application should have a corresponding subscription:
   ```sql
   SELECT fa.email, fa.status, fa.created_at,
          s.status as sub_status
   FROM founding_applications fa
   LEFT JOIN subscriptions s ON s.user_id = (
     SELECT id FROM profiles WHERE email = fa.email LIMIT 1
   )
   WHERE fa.status = 'approved'
   ORDER BY fa.created_at;
   ```
   **BUG if:** any approved application has no corresponding active subscription

6. Verify the `deadline_reminders` table exists and has the expected unique constraint:
   ```sql
   SELECT column_name, data_type
   FROM information_schema.columns
   WHERE table_name = 'deadline_reminders'
   ORDER BY ordinal_position;
   ```
   Then check:
   ```sql
   SELECT indexname, indexdef
   FROM pg_indexes
   WHERE tablename = 'deadline_reminders';
   ```
   **BUG if:** no unique constraint on (transaction_id, deadline_type, days_out) — the idempotency guarantee for deadline reminders depends on this

**Bug severity:** Missing customer subscription = CRITICAL. Missing unique constraint = HIGH. Orphaned documents = LOW.

---

## AUDIT CATEGORY 6: UI SMOKE TEST (Playwright)

**Goal:** Core pages load without JavaScript errors on both staging and production.

**Steps:**

1. First get the staging URL: Use Bash to run `npx vercel ls` in `C:\Users\Heath Shepard\Desktop\MeetDossie` and extract the latest Preview URL.

2. Test each URL below on BOTH staging and production (https://meetdossie.com):
   - `/` (homepage / index.html)
   - `/founding`
   - `/app`
   - `/workspace`
   - `/calculator`
   - `/privacy`
   - `/terms`

3. For each page, use `mcp__playwright__browser_navigate` then `mcp__playwright__browser_console_messages` to capture console output. Then use `mcp__playwright__browser_snapshot` to verify the page rendered.

4. **BUG criteria:**
   - Any page returning non-200 HTTP status = CRITICAL
   - `console.error` or uncaught exceptions = HIGH
   - `console.warn` about React keys, hook violations, or missing env vars = MEDIUM
   - Page that renders a blank white screen (empty DOM) = CRITICAL

5. On `/founding`, take a screenshot and verify:
   - The founding member count is a real number (not "undefined" or "NaN" or "0")
   - The "Apply" or CTA button is visible

6. On `/app` specifically — the page should redirect to login if unauthenticated. Verify it does NOT show a blank white screen or throw an uncaught JS error.

7. On `/workspace` — same as `/app`. Should redirect or show login, not crash.

**Bug severity:** Blank white screen on any page = CRITICAL. JS errors on public pages = HIGH. JS errors on authenticated pages = MEDIUM.

---

## AUDIT CATEGORY 7: FILL-FORM ENDPOINT SMOKE TEST

**Goal:** The `/api/fill-form` endpoint must return `ok:true` with a signed PDF URL for a real demo transaction. This endpoint powers DossieSign (Phase 1) and Talk to Dossie.

**Steps:**

1. Query the DB to get a demo transaction ID:
   ```sql
   SELECT t.id, t.property_address, t.purchase_price, t.user_id
   FROM transactions t
   JOIN profiles p ON p.id = t.user_id
   WHERE p.email = 'demo@meetdossie.com'
   AND t.property_address IS NOT NULL
   LIMIT 1;
   ```

2. You need a valid demo user JWT to call this endpoint. Query Supabase auth to get the demo user's ID, then use the service role key to generate a test token. Alternatively, check if there is a test-fill-form.js or any script that exercises the endpoint locally.

3. Attempt a POST to `/api/fill-form` on the production URL:
   ```
   POST https://meetdossie.com/api/fill-form
   Authorization: Bearer <demo_user_jwt>
   Content-Type: application/json
   
   {
     "transaction_id": "<demo_transaction_id>",
     "form_type": "resale-contract",
     "field_values": {}
   }
   ```
   Use `mcp__playwright__browser_network_request` for this.

4. **BUG if:** response is not `{ ok: true, signedUrl: "https://..." }`. Common failure modes:
   - 500: PDF asset base64 module failed to load (cold start issue)
   - 422: transaction missing required fields
   - 403: auth token not accepted
   - `ok:false, error:"could not fill"`: field mapping failure

5. Read `api/fill-form.js` and verify:
   - All base64 asset requires at the top of the file exist as actual files in `api/_assets/`
   - The form_type switch/case covers at minimum: `resale-contract`, `financing-addendum`, `termination-notice`, `amendment`
   - The Supabase Storage upload uses the correct bucket name (`documents`)

6. Check that `api/_assets/` contains the expected base64 files:
   ```
   Glob: api/_assets/*.js in MeetDossie
   ```
   **BUG if:** any file required in fill-form.js is missing from _assets/

**Bug severity:** fill-form returning 500 = CRITICAL (breaks DossieSign entirely). Missing asset file = CRITICAL. Auth failure = HIGH.

---

## AUDIT CATEGORY 8: EMAIL DELIVERABILITY

**Goal:** All Resend sends use verified meetdossie.com sender addresses. No personal addresses or external addresses hardcoded.

**Steps:**

1. Grep ALL api/*.js files for `from:` patterns in email sends:
   ```
   Grep pattern: from:.*<.*@  (content mode)
   ```

2. Collect every unique `from` address used. Acceptable addresses:
   - `dossie@meetdossie.com`
   - `heath@meetdossie.com`
   - `sign@meetdossie.com`
   - `noreply@meetdossie.com`
   - `info@meetdossie.com`
   - Display name variants like `Dossie <dossie@meetdossie.com>` are fine

3. **BUG if:** any file sends from a non-meetdossie.com domain (e.g., `heath.shepard@kw.com`, `gmail.com`, or any external address)

4. Check `api/_lib/founding-approval.js` — this sends the approval email to applicants. Verify the from address.

5. Check `api/esign-webhook.js` — this sends e-sign completion emails. Verify from address.

6. Check `api/cron-activation-drip.js` — uses `FROM_EMAIL = 'heath@meetdossie.com'` as a raw email address without a display name. Verify this is intentional (Resend accepts bare addresses). **MEDIUM concern** if Resend requires display names for better deliverability.

7. Verify that `dossie@meetdossie.com` (not just `heath@meetdossie.com`) is set up in ImprovMX or Resend as a verified sending domain. You cannot check ImprovMX from code — flag as "requires manual verification."

**Bug severity:** Sending from non-meetdossie.com address = CRITICAL (will hard-fail Resend sending). No display name on bulk sends = LOW.

---

## AUDIT CATEGORY 9: STRIPE WEBHOOK COVERAGE

**Goal:** The stripe-webhook.js handler must cover all event types needed to prevent the known provisioning gap (Terry Katz, Jennifer Beltrán, Lisa Nilsson were never auto-provisioned because direct invoice payments were not handled).

**Steps:**

1. Read `api/stripe-webhook.js` and identify every `event.type` it handles (look for the switch/if-else at the bottom).

2. Verify these event types are handled:
   - `checkout.session.completed` — standard checkout flow
   - `invoice.paid` — direct invoice payments (the known gap)
   - `customer.subscription.created` — safety net for checkout gap
   - `customer.subscription.deleted` — cancellation handling

3. **BUG if `invoice.paid` is NOT handled:** This is a known critical bug. Flag as CRITICAL with note: "Three customers (Terry Katz, Jennifer Beltran, Lisa Nilsson) were manually provisioned because this event was not handled. Without it, any future direct-invoice payment silently fails to provision the customer."

4. Check the `invoice.paid` handler specifically — verify it:
   - Checks `billing_reason` to distinguish first invoice vs. recurring
   - Has idempotency logic (does not re-send welcome email to already-provisioned users)
   - Sends both the welcome email AND the password-set email
   - Notifies Heath via Telegram

5. Run this query to check if any subscription has `status='pending_onboarding'` for more than 48 hours (indicates stuck checkout flow):
   ```sql
   SELECT s.id, s.user_id, s.status, s.created_at, p.email
   FROM subscriptions s
   JOIN profiles p ON p.id = s.user_id
   WHERE s.status = 'pending_onboarding'
   AND s.created_at < NOW() - INTERVAL '48 hours'
   AND p.is_demo IS NOT TRUE;
   ```
   **BUG if:** any real customer has been stuck in `pending_onboarding` for >48h

6. Check if `customer.subscription.updated` is handled — not critical, but renewal/plan-change events should update the subscription row's `current_period_end`.

**Bug severity:** Missing invoice.paid handler = CRITICAL (known gap). Stuck pending_onboarding = HIGH. Missing subscription.updated = LOW.

---

## AUDIT CATEGORY 10: CONTENT AND COPY QUALITY

**Goal:** Customer-facing email templates and social post generation prompts must not produce fabricated stats, internal jargon, or generic/broken copy.

**Steps:**

1. Read the welcome email template in `api/stripe-webhook.js` function `welcomeEmailHtml()`. Check:
   - Name substitution uses a fallback ("there" if no name — acceptable)
   - No placeholder text visible
   - All URLs are real (facebook group link, meetdossie.com links)
   - No internal cost/pricing references like "founding tier" as a raw value

2. Read the set-password email template in `api/stripe-webhook.js` function `setPasswordEmailHtml()`. Verify:
   - The `actionLink` is not hardcoded — it's the generated Supabase recovery link
   - The link expiry notice says "24 hours" (accurate per Supabase default)

3. Read `api/complete-onboarding.js` welcome email template. Verify no `undefined` or null placeholders.

4. Read `api/cron-activation-drip.js` email bodies. Check for:
   - Generic opener "Hi there," with no name (should use `full_name` from profiles)
   - Any reference to internal column names or system labels

5. Read `api/cron-generate-posts.js` — find the Claude/Anthropic prompt used to generate social posts. Verify:
   - The prompt instructs the model NOT to fabricate specific statistics or member counts
   - The prompt uses the correct persona voice rules (third-person, not first-person "I")
   - The prompt specifies the `stat` field max is 10 characters
   - The prompt specifies `hook` max is 8 words

6. Check `api/cron-followup.js` — the follow-up email sequence. Verify:
   - Uses the agent's real name from the `profiles` table
   - Does not reference any internal IDs or system states

7. Run this Supabase query to check for social posts with obviously bad content (too-long stat fields):
   ```sql
   SELECT id, persona, topic, stat, hook
   FROM social_posts
   WHERE LENGTH(stat) > 10
   OR LENGTH(hook) > 60
   ORDER BY created_at DESC
   LIMIT 10;
   ```

**Bug severity:** Fabricated customer count or stats in live posts = HIGH. Generic greeting instead of name = MEDIUM. Bad stat/hook field lengths = LOW.

---

## OUTPUT FORMAT

After completing all 10 categories, produce this exact report:

```
DOSSIE SYSTEM AUDIT — [today's date]

CRITICAL (must fix before next customer signup):
- [Category N — item]: [exact description of bug] — [file path:line number if applicable]

HIGH (fix within 48h):
- [Category N — item]: [description]

MEDIUM (fix this week):
- [Category N — item]: [description]

LOW (nice to have):
- [Category N — item]: [description]

CLEAN (no issues found):
- [Category N — description]: ✅

SUMMARY: X critical, Y high, Z medium, W low issues found.

NEXT ACTIONS (in priority order):
1. [Most urgent fix with the specific file to edit]
2. ...
```

If a category cannot be fully tested due to missing credentials or environment access, note it as "BLOCKED: [reason]" in the CLEAN section rather than skipping it.

Do not mark any category CLEAN unless you have actually executed the checks. Do not guess — verify with real file reads, DB queries, or Playwright tests. A wrong CLEAN is worse than a missing check.
