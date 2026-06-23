# APV Brief for Atlas: Email Approval System

**From:** Carter (Product Engineering)
**To:** Atlas (Deploy + Verify)
**Status:** Staging branch ready for APV

---

## What Changed

Email approval system for Jarvis HUD:
- Heath can now tap "APPROVE & SEND" on agent-drafted emails
- Modal shows preview (to/from/subject/body)
- Tap Send → Resend API fires → action marked done

**Commit on staging:** 9ed4551 (git log shows: "WIP: heath-actions email approval system")

---

## APV Workflow

### 1. Deploy to Staging

```bash
git checkout staging
git pull origin staging
# Vercel auto-deploys on push; can also:
npx vercel --prod  # (Only if Vercel env is connected)
```

### 2. Migrate Schema

Run locally with .env.local (SUPABASE vars):
```bash
node scripts/create-test-email-action.js
```

This creates a test action:
- ID: (printed to stdout)
- Title: "Approve email: Tiffany Gill double-billing follow-up"
- Recipient: demo@meetdossie.com (for safe testing)
- Status: pending
- action_type: send_email

### 3. APV on Staging URL

Sign in as Heath:
- Email: heath.shepard@kw.com
- Password: (from .env.local DEMO_PASSWORD or real password)
- Go to Jarvis PWA staging URL

**Expected:** ACTIONS FOR YOU panel shows the new email action

#### Test Flow

1. **Find action** — Scroll ACTIONS FOR YOU panel, find "Tiffany Gill" card
2. **Tap APPROVE & SEND** — Button should be prominent/golden
3. **Verify modal** — Shows:
   - To: demo@meetdossie.com
   - From: Pierce - Dossie <heath@meetdossie.com>
   - Subject: "Re: Your Recent Dossie Charge – We Got This"
   - Body: Email preview (multi-line text)
   - Two buttons: "SEND" (green) and "CANCEL"
4. **Tap SEND** — Modal should close, card should show checkmark + "Sent at [timestamp]"
5. **Verify toast** — "Email sent (message_id)" should appear briefly
6. **Verify Resend** — Check https://resend.com/dashboard/emails → look for outbound to demo@meetdossie.com with subject matching

### 4. Success Criteria

- [ ] Modal appears on APPROVE & SEND tap
- [ ] Modal shows correct email details
- [ ] Send button fires without errors
- [ ] Action card updates to show completion
- [ ] Toast shows message_id
- [ ] Resend dashboard shows email sent to test recipient
- [ ] No console errors (check browser DevTools)

### 5. Failure Modes to Watch

| Failure | Check |
|---|---|
| Modal doesn't appear | Is `action_type='send_email'` set in DB? Is `payload` JSONB valid? |
| Send fails with 422 | Is `payload` missing required fields (to, subject, body_html/body_text)? |
| Send fails with 401 | Is Heath JWT valid? Check Authorization header. |
| No email in Resend | Was API call successful (200)? Check execution_result in DB. |
| Modal stuck loading | Check browser console for fetch errors. |

### 6. Proof Screenshot

After success, capture:
1. Full Jarvis HUD showing action card with checkmark
2. Modal showing email preview (before send)
3. Toast confirmation message
4. Resend dashboard showing sent email

---

## Rollback Plan

If critical failure:
1. `git checkout main` and revert to last known GOLD tag
2. Or run: `git revert 9ed4551 && git push staging`
3. Vercel auto-redeploys from git

---

## Files Atlas Will See

| File | Change |
|---|---|
| `supabase/migrations/20260622_heath_actions_extend.sql` | Schema migration (auto-applied by Supabase) |
| `api/heath-actions-approve-execute.js` | NEW: Execute endpoint (Vercel deploys auto) |
| `api/heath-actions-create.js` | Updated to accept action_type + payload |
| `jarvis-pwa.html` | Modal UI + event handlers |
| `scripts/create-test-email-action.js` | Helper script (run locally) |

---

## Next After APV Pass

Jarvis will ping Heath with screenshot proof. Heath approves merge to main. Cole/Jarvis handles merge SOP.

