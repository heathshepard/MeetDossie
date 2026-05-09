# DOSSIE RUNBOOK — API Keys, Rotation, and Emergency Procedures

This document is the authoritative reference for every secret, where it lives, how to rotate it, and what to redeploy afterward.

---

## KEY ROTATION CHECKLIST (Standard Procedure)

Use this for **all** key rotations unless specified otherwise below:

1. **Get new key from provider** (see provider-specific sections below)
2. **Update in Vercel dashboard:**
   - Go to https://vercel.com/heathshepard-6590s-projects/meet-dossie/settings/environment-variables
   - Find the variable → Delete
   - Add it back with the new value
   - **IMPORTANT:** Do NOT mark as Sensitive — breaks local `vercel env pull`
3. **Pull to local:**
   ```bash
   npx vercel env pull .env.production.local
   ```
4. **Redeploy:**
   ```bash
   npx vercel --prod
   ```
5. **Verify:**
   - Check https://meetdossie.com/api/health
   - All services should report `"ok"`
6. **Special case — TELEGRAM_BOT_TOKEN:**
   - After Vercel update, ALSO manually edit `.env.production.local` in MeetDossie repo
   - Restart Claude Code:
     ```bash
     cd "C:\Users\Heath Shepard\Desktop\MeetDossie"
     claude --dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official
     ```

---

## API KEYS INVENTORY

### SUPABASE_URL
- **Value:** `https://pgwoitbdiyubjugwufhk.supabase.co`
- **Where:** Vercel env vars (production, preview, development)
- **Provider:** Supabase project settings → API → Project URL
- **Rotation:** N/A (fixed per project)
- **Used by:** All client-side pages, all API functions, all Python scripts

### SUPABASE_PUBLISHABLE_KEY
- **Value:** `sb_publishable_bx3yp5_...` (new format, starts with `sb_publishable_`)
- **Where:** Vercel env vars (production, preview, development)
- **Provider:** Supabase project settings → API → Project API keys → `anon` / `public` key
- **Rotation:** Use standard checklist above
- **Used by:** All client-side pages via `/api/config`, all unauthenticated Supabase operations
- **Notes:** Client-safe, RLS-protected. Served via `/api/config.js` to browser.

### SUPABASE_SERVICE_ROLE_KEY
- **Value:** `eyJhbGciOiJ...` (JWT, starts with `eyJ`)
- **Where:** Vercel env vars (production only)
- **Provider:** Supabase project settings → API → Project API keys → `service_role` key
- **Rotation:** Use standard checklist above
- **Used by:** Server-side API functions that need admin access
- **Security:** **NEVER** expose to client. Server-only. Bypasses RLS.

### TELEGRAM_BOT_TOKEN
- **Value:** `8703562086:AAHPBQTFJBPx_sKQBltA-LKgAMzwotNEvS8`
- **Where:** Vercel env vars (production, preview, development) + `.env.production.local`
- **Provider:** @BotFather on Telegram → `/newbot` or `/token` for existing bot
- **Current bot:** @DossieAssistant_bot
- **Rotation:** Use standard checklist + manual `.env.production.local` edit + restart Claude Code
- **Used by:** `/api/alert-health.js`, all Telegram notification endpoints, Claude Code Telegram channel

### TELEGRAM_MARKETING_BOT_TOKEN
- **Value:** `8751441772:AAEWoq79XkZpsubJeqTB_NStrXITjgPX_go`
- **Where:** Vercel env vars (production, preview, development)
- **Provider:** @BotFather → `/newbot` or `/token`
- **Current bot:** @DossieMarketingBot
- **Rotation:** Use standard checklist
- **Used by:** Social post approval buttons, founding application approval flow

### TELEGRAM_CHAT_ID
- **Value:** `7874782923` (Heath's personal Telegram user ID)
- **Where:** Vercel env vars (production, preview, development)
- **Provider:** Send `/start` to @userinfobot on Telegram
- **Rotation:** Only if Heath's Telegram account changes
- **Used by:** All alert and notification endpoints

### ELEVENLABS_API_KEY
- **Value:** `sk_fd3327c182ed1e66cc90627d4b09381e66e2cb73e70cfb0d`
- **Where:** Vercel env vars (production, preview, development)
- **Provider:** ElevenLabs dashboard → Profile → API Key
- **Rotation:** Use standard checklist
- **Used by:** Voice generation for Morning Brief, lifestyle video voiceovers
- **Voice IDs:** Bill (`pqHfZKP75CvOlQylNhV4`), Luna (`lxYfHSkYm1EzQzGhdbfc`)

### CREATOMATE_API_KEY
- **Value:** (check Vercel dashboard)
- **Where:** Vercel env vars (production, preview, development)
- **Provider:** Creatomate dashboard → API Keys
- **Rotation:** Use standard checklist
- **Used by:** Video rendering pipeline (`/api/cron-publish-approved.js`, `scripts/generate-creatomate-video.py`)
- **Template ID:** `791117d0-665c-4cd0-ba5f-a767f8921f9b`

### CREATOMATE_TEMPLATE_ID
- **Value:** `791117d0-665c-4cd0-ba5f-a767f8921f9b`
- **Where:** Vercel env vars (production, preview, development)
- **Provider:** Creatomate dashboard → Templates
- **Rotation:** Only if template is cloned/replaced
- **Used by:** All video rendering calls

### ANTHROPIC_API_KEY
- **Value:** (check Vercel dashboard)
- **Where:** Vercel env vars (production, preview, development)
- **Provider:** Anthropic Console → API Keys
- **Rotation:** Use standard checklist
- **Used by:** Content generation cron (`/api/cron-generate-posts.js`)

### PEXELS_API_KEY
- **Value:** (check Vercel dashboard)
- **Where:** Vercel env vars (production, preview, development)
- **Provider:** Pexels API dashboard
- **Rotation:** Use standard checklist
- **Used by:** B-roll video selection for lifestyle videos

### ZERNIO_API_KEY
- **Value:** (check Vercel dashboard)
- **Where:** Vercel env vars (production, preview, development)
- **Provider:** Zernio dashboard → API
- **Rotation:** Use standard checklist
- **Used by:** Social media posting automation (`scripts/upload-to-zernio.py`, `/api/cron-publish-approved.js`)

### STRIPE_SECRET_KEY
- **Value:** `sk_live_...` (production) or `sk_test_...` (test mode)
- **Where:** Vercel env vars (production only)
- **Provider:** Stripe Dashboard → Developers → API keys → Secret key
- **Rotation:** Use standard checklist
- **Used by:** Payment processing, subscription management
- **Security:** **NEVER** expose to client. Server-only.

### STRIPE_WEBHOOK_SECRET
- **Value:** `whsec_...`
- **Where:** Vercel env vars (production only)
- **Provider:** Stripe Dashboard → Developers → Webhooks → Endpoint → Signing secret
- **Rotation:** Requires re-creating webhook endpoint in Stripe dashboard → update Vercel → redeploy
- **Used by:** `/api/stripe-webhook.js` to verify webhook authenticity

### STRIPE_FOUNDING_PAYMENT_LINK
- **Value:** (Permanent Stripe Payment Link URL — not yet created as of 2026-05-08)
- **Where:** Vercel env vars (production only)
- **Provider:** Stripe Dashboard → Payment Links → Create
- **Rotation:** Only if payment link is replaced
- **Used by:** Founding member approval flow
- **TODO:** Create this permanent link (current checkout sessions expire 24h)

### RESEND_API_KEY
- **Value:** (check Vercel dashboard)
- **Where:** Vercel env vars (production only)
- **Provider:** Resend dashboard → API Keys
- **Rotation:** Use standard checklist
- **Used by:** Transactional emails (founding approvals, password resets via Supabase SMTP)

### CRON_SECRET
- **Value:** (random hex string)
- **Where:** Vercel env vars (production, preview, development) + `.env.local`
- **Provider:** Self-generated: `openssl rand -hex 32`
- **Rotation:** Use standard checklist
- **Used by:** Manual cron triggers for debugging (Authorization header check)
- **Security:** Treat as a secret even though crons are internal-only

### DEMO_PASSWORD
- **Value:** `DossieDemo-VaIiAt6Bab`
- **Where:** Vercel env vars (production, preview, development)
- **Provider:** Self-defined
- **Rotation:** Change in Vercel → create new Supabase demo user with new password → update seed scripts
- **Used by:** Demo account `demo@meetdossie.com` (Sarah Whitley persona)

### DEMO2_PASSWORD
- **Value:** `DossieDemo2-John2026`
- **Where:** Vercel env vars (production, preview, development)
- **Provider:** Self-defined
- **Rotation:** Change in Vercel → create new Supabase demo user with new password → update seed scripts
- **Used by:** Demo account `demo2@meetdossie.com` (John Smith persona)

---

## EMERGENCY PROCEDURES

### If /api/health reports degraded services:

1. **Check Telegram for alert** — `/api/alert-health` runs every 5 minutes
2. **Visit https://meetdossie.com/api/health directly** — see which service is down
3. **For each broken service:**
   - Supabase → check https://status.supabase.com
   - Telegram → test token with `curl https://api.telegram.org/bot<TOKEN>/getMe`
   - ElevenLabs → check dashboard quota/billing
   - Creatomate → check dashboard quota/billing
4. **If token is invalid:** follow rotation checklist above
5. **If provider is down:** wait for provider status page to resolve, then verify health

### If client-side pages fail to load:

1. **Check browser console** — look for `/api/config` 404 or JSON parse errors
2. **Verify /api/config.js exists** in MeetDossie repo
3. **Verify SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY** are set in Vercel env vars
4. **Redeploy** if config endpoint is missing

### If Telegram bot stops responding:

1. **Verify token:** `curl https://api.telegram.org/bot<TOKEN>/getMe`
2. **If 401 Unauthorized:** token is invalid → rotate TELEGRAM_BOT_TOKEN
3. **Check .env.production.local** in MeetDossie repo matches Vercel
4. **Restart Claude Code** after any token change

### If video rendering fails:

1. **Check /api/health** for Creatomate and ElevenLabs status
2. **Check Creatomate dashboard** → Renders → error logs
3. **Check ElevenLabs quota** — free tier is 10k chars/month
4. **Check Pexels API quota** — 200 requests/hour

### If malware/breach suspected:

1. **Rotate ALL tokens immediately** (use checklist for each)
2. **Check git history** for leaked secrets: `git log --all --source --full-history -- '*.js' '*.py' '*.html'`
3. **Scan with GitGuardian** or `gitleaks`
4. **Revoke compromised tokens** at provider dashboards
5. **Document in INCIDENT-YYYY-MM-DD.md**

---

## HEALTH MONITORING

- **Endpoint:** https://meetdossie.com/api/health
- **Cron:** Every 5 minutes via `/api/alert-health` (Vercel cron)
- **Alert channel:** Telegram (Heath's personal chat ID `7874782923`)
- **Services monitored:** Supabase, Telegram, ElevenLabs, Creatomate
- **Expected response:** `{"status":"ok","services":{"supabase":"ok","telegram":"ok","elevenlabs":"ok","creatomate":"ok"},...}`

---

## LOCAL DEVELOPMENT SECRETS

- **File:** `.env.production.local` (gitignored)
- **How to sync:** `npx vercel env pull .env.production.local`
- **Security:** **NEVER** commit to git. **NEVER** share publicly.

---

## DEPLOYMENT CHECKLIST

Before every production deploy:

1. Test `/api/health` locally if possible
2. Verify no hardcoded secrets in code (`grep -r "sk_live" . --exclude-dir=node_modules`)
3. Commit with descriptive message
4. Tag stable builds: `git tag GOLD-YYYY-MM-DD-vN-description && git push origin --tags`
5. Deploy: `npx vercel --prod`
6. Verify: `curl https://meetdossie.com/api/health`
7. Check Telegram for any alerts

---

## NOTES

- **Never use `--no-verify`** on commits (bypasses pre-commit hooks)
- **Never hardcode secrets** in `.js`, `.py`, `.html`, or any tracked file
- **Always use `process.env.VAR_NAME`** in Node.js
- **Always use `os.environ['VAR_NAME']`** in Python
- **Never mark Vercel env vars as Sensitive** (breaks `vercel env pull`)
- **Always check health after key rotation**

---

Last updated: 2026-05-08 (Resilience Sprint v1)
