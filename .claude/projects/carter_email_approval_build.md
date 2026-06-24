# EMAIL APPROVAL SYSTEM BUILD — Carter Drafter Checklist

**Brief:** One-tap approve + send emails from Jarvis HUD actions panel. Heath drafts via agents (Pierce, etc.), taps "APPROVE & SEND" in Jarvis, sees confirmation modal with email preview, taps Send → Resend API fires → action marked done.

**Status:** In flight (Carter drafting)

---

## Completed

- [x] Extended `heath_actions` schema with `action_type`, `payload`, `approved_at`, `executed_at`, `execution_result`
  - Migration file: `supabase/migrations/20260622_heath_actions_extend.sql`
  - Supports: `manual` (default), `send_email`, `send_telegram`, `process_refund`, `execute_purchase`
  - Added indexes on `action_type + status`, `approved_at` for efficient queries

- [x] Built `/api/heath-actions-approve-execute.js` endpoint
  - POST /api/heath-actions-approve-execute { action_id }
  - Validates action ownership (RLS), action_type, payload structure
  - For `send_email`: calls Resend API, stores message_id in execution_result
  - Sets approved_at, executed_at, status='done' on success
  - Idempotent: re-submit returns cached result
  - Returns: { ok: true, message_id, executed_at } on success
  - Sender validation: hardcoded allowlist (heath@meetdossie.com, noreply@, support@)

- [x] Updated `/api/heath-actions-create.js` to accept `action_type` and `payload` for future agent usage
  - Agents can now POST with action_type='send_email' + full payload structure
  - Backward compatible: defaults to 'manual' type if not specified

- [x] Updated `jarvis-pwa.html` UI
  - Added CSS for email approval modal + APPROVE & SEND button styling
  - Modal shows: To, CC, BCC (if present), From, Subject, Body preview
  - Added HTML for modal overlay (hidden by default)
  - Updated `renderActions()` to detect `action_type='send_email'` and render APPROVE & SEND button
  - Added `onApproveEmailClick()` handler: fetches action payload, populates modal, shows overlay
  - Added `sendEmailFromModal()` handler: calls /api/heath-actions-approve-execute, handles success/error
  - Modal closes on Send success, Cancel, or overlay click
  - All event listeners attached dynamically on page load

- [x] Created `/scripts/create-test-email-action.js` for APV setup
  - Inserts test email action with Tiffany double-billing scenario
  - Recipient defaults to demo@meetdossie.com for safe testing
  - Used before APV to seed test action in DB

---

## TODO (Atlas to deploy + verify)

- [ ] Push staging to Vercel (auto-deploy from git)
- [ ] Run migration: `node scripts/create-test-email-action.js` (requires .env.local SUPABASE vars)
- [ ] APV on staging:
  - [ ] Sign in as Heath (healthshepard@kw.com / password)
  - [ ] Navigate to Jarvis PWA (staging URL)
  - [ ] Verify test email action appears in ACTIONS FOR YOU panel
  - [ ] Tap APPROVE & SEND button
  - [ ] Modal pops up showing: To=demo@meetdossie.com, Subject, Body preview
  - [ ] Tap "Send" button
  - [ ] Verify: action card collapses, toast shows "Email sent (message_id)", Resend receives request
  - [ ] Check Resend dashboard for outbound email (demo@meetdossie.com)
- [ ] Verify no merge blockers (git grep '<<<<<<<' returns zero)
- [ ] Screenshot: modal + success state for proof

---

## Constraints

- DO NOT push to main yet (staging only per SOP)
- Resend API key in Vercel env (already configured: RESEND_API_KEY)
- No arbitrary FROM addresses (sender validation required)
- Heath approval = ONLY path for agent-drafted emails to send
- RLS enforces tenant ownership (single-tenant for now: heath.shepard@kw.com)

---

## Files Modified

| File | Lines | Change |
|---|---|---|
| `supabase/migrations/20260622_heath_actions_extend.sql` | 26 | NEW: schema extension (action_type, payload, approved_at, executed_at, execution_result, indexes) |
| `api/heath-actions-approve-execute.js` | 205 | NEW: execute endpoint, Resend integration, idempotent logic |
| `api/heath-actions-create.js` | +11 | Updated to accept action_type + payload in request body |
| `jarvis-pwa.html` | +300 | Modal CSS (~120 lines), modal HTML, renderActions() update, event handlers (onApproveEmailClick, sendEmailFromModal, modal close logic) |
| `scripts/create-test-email-action.js` | 80 | NEW: helper script to seed test action |

---

## Next Steps (Atlas)

1. Checkout staging branch
2. `git push origin staging` → Vercel auto-deploys to staging URL
3. Wait for deployment (check Vercel dashboard)
4. Run: `SUPABASE_URL=xxx SUPABASE_SERVICE_ROLE_KEY=xxx node scripts/create-test-email-action.js`
5. APV: sign in, find action, tap button, verify modal + send
6. Report back to Jarvis with screenshot + message_id proof
7. If all clear: prepare for merge to main (Jarvis → Heath approval)

