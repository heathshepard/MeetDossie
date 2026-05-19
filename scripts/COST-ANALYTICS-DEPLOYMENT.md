# Cost Analytics Dashboard - Deployment Guide

## What Was Built

A comprehensive cost analytics dashboard for tracking usage and costs across all metered services (ElevenLabs, Anthropic, Resend, Creatomate, HCTI). Includes per-user breakdowns, alerts, and real-time cost visibility.

---

## Files Created/Modified

### Created:
1. **scripts/create-usage-logs-table.sql** — Database schema for usage tracking
2. **api/_lib/usage-logger.js** — Utility module for fire-and-forget usage logging
3. **api/admin-cost-analytics.js** — API endpoint for cost analytics data
4. **scripts/COST-ANALYTICS-DEPLOYMENT.md** — This file

### Modified:
1. **api/speak.js** — Added ElevenLabs usage logging
2. **api/chat.js** — Added Anthropic usage logging for chat and action modes
3. **api/scan-contract.js** — Added Anthropic usage logging for contract scans
4. **admin.html** — Added Cost Analytics section with tables, cards, and alerts

---

## Step 1: Run SQL Migration

**CRITICAL: This must be done first before any API changes go live.**

1. Open Supabase SQL Editor: https://supabase.com/dashboard/project/pgwoitbdiyubjugwufhk/sql/new
2. Copy the entire contents of `scripts/create-usage-logs-table.sql`
3. Paste into SQL Editor
4. Click "Run" to execute
5. Verify success:
   ```sql
   SELECT * FROM public.usage_logs LIMIT 1;
   ```
   Should return "0 rows" (table exists but empty).

---

## Step 2: Deploy to Staging

```bash
# From MeetDossie repo
git checkout staging
git add .
git commit -m "Add cost analytics dashboard and usage tracking"
git push
```

Vercel will auto-deploy to staging URL:
https://meet-dossie-nc8tcpjt5-heathshepard-6590s-projects.vercel.app

---

## Step 3: Test on Staging

1. **Verify admin dashboard loads:**
   - Navigate to staging URL + `/admin.html`
   - Log in with heath.shepard@kw.com
   - Scroll to "Cost Analytics" section
   - Should show all $0.00 (no usage yet)

2. **Generate test usage:**
   ```bash
   # Test ElevenLabs logging (requires userId in request body)
   curl -X POST https://meet-dossie-nc8tcpjt5-heathshepard-6590s-projects.vercel.app/api/speak \
     -H "Content-Type: application/json" \
     -d '{"text": "This is a test", "userId": "<demo-user-id>"}'

   # Test Anthropic logging (userId already in chat.js requests)
   # Use the app normally - chat and scan will auto-log
   ```

3. **Check Supabase for logged usage:**
   ```sql
   SELECT * FROM usage_logs ORDER BY created_at DESC LIMIT 10;
   ```

4. **Refresh admin dashboard:**
   - Reload `/admin.html`
   - Cost Analytics section should show test usage
   - Verify per-user breakdown appears

---

## Step 4: Deploy to Production

**Only after testing confirms it works on staging:**

```bash
git checkout main
git merge staging
git push
```

Vercel will auto-deploy to https://meetdossie.com

---

## How It Works

### Logging Flow:

1. **API endpoint called** (speak.js, chat.js, scan-contract.js)
2. **Service executes** (ElevenLabs TTS, Anthropic API, etc.)
3. **Usage logged asynchronously** via `usage-logger.js` helper
4. **Demo users excluded** (checks `profiles.is_demo = false`)
5. **Logged to `usage_logs` table** with user_id, service, units, cost

### Cost Calculation:

- **ElevenLabs:** `(characters / 1000) * $0.30`
- **Anthropic Sonnet:** `(input_tokens / 1M) * $3 + (output_tokens / 1M) * $15`
- **Anthropic Haiku:** `(input_tokens / 1M) * $0.25 + (output_tokens / 1M) * $1.25`
- **Resend:** `(emails / 1000) * $1.00`
- **HCTI:** $0 per render (first 50 free, then $14/mo flat)
- **Creatomate:** $0.05 per render (estimated)

### Admin Dashboard:

- **Overview cards:** Total cost this month, breakdown by service
- **Per-service tables:** Top 5 users per service
- **Per-user table:** Sortable by total cost, shows voice/chat/scan/email breakdown
- **Alerts:** Users over $10/month, HCTI approaching/exceeding free tier

---

## Current Limitations

1. **No historical data:** Only tracks usage AFTER deployment. Pre-existing usage not logged.

2. **Client updates needed for full coverage:**
   - `speak.js` now accepts optional `userId` in request body
   - `scan-contract.js` now accepts optional `userId` in request body
   - Existing clients may not send userId → usage won't be logged for those calls
   - Update React app to pass userId when calling these endpoints

3. **Estimated costs for scan-contract:**
   - Scan makes 2-3 Anthropic calls (identify, audit, optional extract)
   - Currently logs estimated ~8000 tokens per scan
   - For precise tracking, would need to capture actual usage from each call

4. **Email logging not yet wired:**
   - `logResend()` helper is available
   - Need to add to all email-sending endpoints (send-email.js, send-compliance-packet.js, etc.)
   - Add as needed in future updates

5. **System-level usage:**
   - Social media posts (cron jobs) don't have a userId
   - Can log with `userId = null` for system-level tracking
   - Admin dashboard currently only shows user-attributed costs

---

## Pricing Constants

Defined in `api/_lib/usage-logger.js` and `api/admin-cost-analytics.js`:

```javascript
const PRICING = {
  elevenlabs_per_1k_chars: 0.30,
  anthropic_sonnet_input_per_1m: 3.00,
  anthropic_sonnet_output_per_1m: 15.00,
  anthropic_haiku_input_per_1m: 0.25,
  anthropic_haiku_output_per_1m: 1.25,
  resend_per_1k_emails: 1.00,
  hcti_monthly_free: 50,
  hcti_paid_per_month: 14.00,
  creatomate_per_render: 0.05,
};
```

**To update pricing:** Edit both files and redeploy.

---

## Testing Checklist

- [ ] SQL table created in Supabase
- [ ] Staging deployment successful
- [ ] Admin dashboard loads without errors
- [ ] Cost Analytics section visible
- [ ] Test usage logged to database
- [ ] Admin dashboard shows test usage
- [ ] Per-user table populates correctly
- [ ] Alerts appear when thresholds exceeded
- [ ] Production deployment successful
- [ ] No errors in Vercel logs

---

## Troubleshooting

**Admin dashboard shows $0.00 for everything:**
- Check Supabase: `SELECT COUNT(*) FROM usage_logs WHERE created_at >= date_trunc('month', NOW());`
- If 0 rows, usage isn't being logged → check API endpoint logs for errors
- If rows exist, check admin-cost-analytics.js response in browser DevTools

**Usage not logging:**
- Check `profiles.is_demo` flag for test users (demo users are excluded)
- Verify userId is being passed in API requests
- Check Vercel function logs for "[usage-logger]" errors

**Admin dashboard fails to load:**
- Check browser console for JavaScript errors
- Verify `/api/admin-cost-analytics` endpoint is deployed
- Check Network tab: should see 200 response from cost analytics API

**Costs seem wrong:**
- Verify pricing constants match current provider pricing
- Check `usage_logs.metadata` for actual token counts
- Compare estimated costs to actual provider bills

---

## Future Enhancements

1. **Historical charts:** Add cost trends over time (month-over-month)
2. **Budget alerts:** Set per-user or total budget limits, send email when exceeded
3. **CSV export:** Download usage logs for accounting/billing
4. **System usage tracking:** Log cron job usage separately (social posts, etc.)
5. **Real-time usage from scan-contract:** Capture actual token counts instead of estimates
6. **Email usage tracking:** Add logging to all email-sending endpoints

---

## Questions for Heath

1. **Should we track system-level usage** (cron jobs, social posts) separately, or only user-attributed costs?
2. **Budget thresholds:** What cost per user/month should trigger an alert? (Currently $10)
3. **React app updates:** Should I update the Dossie React app to pass userId to speak and scan endpoints, or handle that separately?
4. **Email logging priority:** Which email endpoints should we add logging to first? (send-compliance-packet.js, send-email.js, etc.)

---

## Summary

- **Database:** `usage_logs` table tracks all metered service consumption
- **API endpoints:** Automatically log usage after successful service calls
- **Admin dashboard:** Real-time cost visibility with per-user breakdowns and alerts
- **Deployment:** SQL migration required BEFORE code push
- **Testing:** Use staging first, then production after verification

All logging is fire-and-forget (non-blocking) and excludes demo users automatically.
