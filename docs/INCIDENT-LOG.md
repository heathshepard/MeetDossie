# Incident Log

## 2026-05-08 — Brittney onboarding

Ref: `INCIDENT-2026-05-08.md` (root of repo).

**What happened:**
- Brittney upload bugs during onboarding
- Opus model ID wrong (causing API errors)
- Media/ folder with binary files accidentally committed to repo

**Prevention:**
- Never commit binary files (images, videos, audio) to git — use Supabase Storage or external CDN
- Always verify model strings against current Anthropic API docs before deployment
- Always test with real file sizes before customer onboarding (don't assume small test files = production)

---

## Stripe webhook gap (recurring — 3 incidents)

Ref: `project_stripe_webhook_gap.md` in `.claude/projects/`.

**Pattern:** `api/stripe-webhook.js` only handles `checkout.session.completed`. Direct invoice / Payment Link payments leave customers entirely unprovisioned.

**Incidents:**
1. Terry Katz (2026-05-20) — direct Stripe invoice. Manual recovery.
2. Jennifer Beltrán (2026-05-22) — webhook never fired. Manual recovery 2026-05-24 after she messaged Heath.
3. Lisa Nilsson (2026-05-28) — same root cause. Manual recovery.

**Fix status:** Webhook handler expanded 2026-05-28 to cover invoice.paid + payment_link events. Root cause documented. Monitor next 5 signups for recurrence.
