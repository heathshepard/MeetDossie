# Env Vars + External Services

Values live in Vercel only — never paste actual secrets in this file.

---

## KEY ENV VAR NAMES

```
TELEGRAM_BOT_TOKEN
TELEGRAM_MARKETING_BOT_TOKEN
TELEGRAM_CHAT_ID = 7874782923
CRON_SECRET
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
RESEND_API_KEY
ANTHROPIC_API_KEY
ELEVENLABS_API_KEY
PEXELS_API_KEY
ZERNIO_API_KEY
CREATOMATE_API_KEY
CREATOMATE_TEMPLATE_ID = 791117d0-665c-4cd0-ba5f-a767f8921f9b
FAL_KEY
DEMO_PASSWORD = DossieDemo-VaIiAt6Bab
DEMO2_PASSWORD = DossieDemo2-John2026
```

17 distinct env var names. `TELEGRAM_CHAT_ID`, `CREATOMATE_TEMPLATE_ID`, `DEMO_PASSWORD`, `DEMO2_PASSWORD` are non-secret config values shown here for reference.

---

## ZERNIO ACCOUNT IDs

| Platform | Account ID | Active |
|---|---|---|
| facebook | `69f253c3985e734bf3d8f9bc` | ✅ |
| instagram | `69f25431985e734bf3d8fcbe` | ✅ |
| twitter | `69f255c6985e734bf3d90ba1` | ✅ |
| linkedin | `69fccd7392b3d8e85f8f12be` | ✅ (URN `urn:li:organization:115997183`) |
| tiktok | `69f15791985e734bf3d13b89` | ✅ |

---

## STRIPE DETAILS

- Founding price: `price_1TPxxNL920SKTEEiN7Gphq8T` ($29/mo).
- `FOUNDING` coupon does NOT exist in Stripe — causes errors if referenced. Approval flow uses `noCoupon`.
- Checkout sessions expire 24h (known bug). **Fix:** permanent Stripe Payment Link → `STRIPE_FOUNDING_PAYMENT_LINK` env var.

---

## IMPROVMX EMAIL SETUP

- `heath@`, `heathshepard@`, `info@meetdossie.com` → all forward to `heath.shepard@kw.com`. Free plan. (Corrected 2026-07-14 — was previously documented as gmail.com; KW is authoritative per CLAUDE.md line 48 and confirmed by Heath's inbox receipts.)
- API key in Windows Credential Manager as `ImprovMX_API_Key` (rotate — went through Telegram 2026-05-24).

---

## SUPABASE STORAGE BUCKETS

- `documents` — private
- `social-cards` — public, 5MB, image/png + image/jpeg only
