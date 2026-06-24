# Heath Actions Approve-Send Test Plan

**Date:** 2026-06-24  
**Carter Instance:** carter_7  
**Task:** Finish WIP heath-actions email approval system (commit 9ed4551) — implement approve-execute endpoint, dry-run mode, failure tracking.

## Changes Made

### 1. Fixed Endpoint: `/api/heath-actions-approve-execute.js`

**Files:**
- `api/heath-actions-approve-execute.js` (lines 1-196)
- `supabase/migrations/20260622_heath_actions_extend.sql` (lines 1-23)

**Key fixes:**
- Support both structured `payload.to` and direct `recipient_email` column paths
- Add `?dry_run=1` query parameter for validation without sending
- Add `failure_reason` column to track execution errors
- Mark failed actions with `status='failed'` instead of 500 crashing
- True idempotency via `status='done'` check

**Lines changed:** 
- `api/heath-actions-approve-execute.js`: 196 lines (complete rewrite, lines 51-105 refactored)
- `supabase/migrations/20260622_heath_actions_extend.sql`: +1 line (failure_reason column, line 15)

### 2. Schema Migration Applied

**Migration:** `20260622_heath_actions_extend.sql`  
**Status:** Applied to production Supabase (pgwoitbdiyubjugwufhk)  
**New columns:**
- `action_type` TEXT (enum: manual, send_email, send_telegram, process_refund, execute_purchase)
- `payload` JSONB
- `approved_at` TIMESTAMPTZ
- `executed_at` TIMESTAMPTZ
- `execution_result` JSONB
- `failure_reason` TEXT

### 3. Test Action Created

**Action ID:** `24a7912f-971a-4621-b0eb-7d1170f8477a`  
**Recipient:** heath.shepard@kw.com  
**Subject:** "Heath actions approve-send test 2026-06-23"  
**Body:** "This is a test of the approve-and-send email workflow. If you see this, the full pipeline works end-to-end."  
**Status:** pending  
**Payload structure:**
```json
{
  "to": "heath.shepard@kw.com",
  "subject": "Heath actions approve-send test 2026-06-23",
  "body_text": "This is a test of the approve-and-send email workflow. If you see this, the full pipeline works end-to-end."
}
```

## Test Execution Plan

### Phase 1: Dry-Run Validation (Carter — Atlas staging deploy)
**Endpoint:** `POST /api/heath-actions-approve-execute`  
**Payload:** 
```json
{
  "action_id": "24a7912f-971a-4621-b0eb-7d1170f8477a",
  "dry_run": 1
}
```
**Expected Response (200):**
```json
{
  "ok": true,
  "type": "send_email",
  "message_id": null,
  "dry_run": true,
  "would_send_to": "heath.shepard@kw.com",
  "would_subject": "Heath actions approve-send test 2026-06-23",
  "would_from": "heath@meetdossie.com",
  "validated_at": "2026-06-24T..."
}
```
**Pass Criteria:** 
- Status 200
- `dry_run: true`
- `would_send_to` matches recipient
- `validated_at` present
- Database action record UNCHANGED (status still 'pending')

### Phase 2: Live Send (Atlas APV after dry-run passes)
**Endpoint:** `POST /api/heath-actions-approve-execute`  
**Payload:**
```json
{
  "action_id": "24a7912f-971a-4621-b0eb-7d1170f8477a"
}
```
**Expected Response (200):**
```json
{
  "ok": true,
  "type": "send_email",
  "message_id": "re_<random>",
  "sent_to": "heath.shepard@kw.com",
  "executed_at": "2026-06-24T..."
}
```
**Pass Criteria:**
- Status 200
- `message_id` present (Resend format: `re_*`)
- `sent_to` matches recipient
- Database action record updated:
  - `status = 'done'`
  - `approved_at = <timestamp>`
  - `executed_at = <timestamp>`
  - `execution_result` contains message_id
  - `failure_reason = null`

### Phase 3: Idempotency Check (Atlas confirms re-submission is safe)
**Endpoint:** `POST /api/heath-actions-approve-execute` (same payload as Phase 2)  
**Expected Response:** Same as Phase 2, with `message: 'Already executed'` field added  
**Pass Criteria:**
- Status 200
- Returns cached `execution_result` (same message_id as first send)
- No second email sent to inbox

### Phase 4: Email Delivery Verification (Heath checks mailbox)
**Mailbox:** heath.shepard@kw.com  
**Expected:**
- Email arrives within 30 seconds of Phase 2
- Subject: "Heath actions approve-send test 2026-06-23"
- Body contains full test message
- From: heath@meetdossie.com

## Failure Scenarios (error handling verification)

### Missing payload → 422
**Payload:** `{ "action_id": "..." }` with action having no payload/recipient  
**Expected:** 422 `{ "ok": false, "error": "Email action missing payload or recipient_email" }`  
**Result:** Action marked `status='failed'`, `failure_reason` recorded

### Invalid email → 422
**Payload:** action with `to: "not-an-email"`  
**Expected:** 422 `{ "ok": false, "error": "Invalid recipient email: ..." }`  
**Result:** Action marked `status='failed'`

### Resend API error → 422
**Condition:** RESEND_API_KEY invalid or Resend rate-limited  
**Expected:** 422 `{ "ok": false, "reason": "Resend error message" }`  
**Result:** Action marked `status='failed'`, `failure_reason` contains Resend error

## Rollback Plan

If Phase 2 fails:
1. Manual fix to endpoint code
2. Re-run dry-run to validate fix
3. Carter redrafts commit on top of ec9b270
4. Atlas redeploys + re-runs Phase 2

If email lands in spam:
- Verify Resend domain setup + SPF/DKIM for heath@meetdossie.com
- Check Resend logs for delivery status

## Commits

- `ec9b270` — FIX: heath-actions endpoint + dry_run + failure_reason (Carter)
- `d39bd83` — ADD: insert-test-heath-action.js helper (Carter)

## Sign-Off

- **Carter (Draft):** Completed audit, fixes applied, migration applied, test action inserted
- **Atlas (Ship + APV):** Pending after Carter draft
- **Quinn (QA):** Pending after Atlas deployment to staging

---

**Next:** Atlas pulls main, applies fixes, builds, pushes staging, runs Phase 1-3 dry-run via Playwright, reports pass/fail.
