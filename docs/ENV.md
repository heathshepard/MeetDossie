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
DEMO_PASSWORD = <DEMO_PASSWORD in Vercel env>
DEMO2_PASSWORD = <DEMO2_PASSWORD in Vercel env>
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

---

## FULL VERCEL ENV VAR INVENTORY (moved from CLAUDE.md §19, audited 2026-07-27)

Complete inventory of every variable currently set on the `meet-dossie` Vercel project
(`heathshepard-6590s-projects/meet-dossie`), grouped by service.

**Columns.** *Envs* = which Vercel environments carry it. *Vault backup* = whether the value is
recoverable from Bitwarden. "placeholder only" means a vault note exists that names the var but
does **not** hold its value.

**`(write-only)`** = Vercel's *Sensitive* variable type. `vercel env pull` returns the literal
`[SENSITIVE]`; the value can be overwritten but never read back. **A var that is write-only *and*
has no vault backup exists in exactly one place you cannot read** — losing the Vercel project
loses the secret permanently.

**Supabase / Postgres**

| Var | Envs | Vault backup |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Prod+Preview | **NONE** |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Prod+Preview | **NONE** |
| `NEXT_PUBLIC_SUPABASE_URL` | Prod+Preview | **NONE** |
| `POSTGRES_DATABASE` | Prod+Preview | **NONE** |
| `POSTGRES_HOST` | Prod+Preview | **NONE** |
| `POSTGRES_PASSWORD` *(write-only)* | Prod+Preview | **NONE** |
| `POSTGRES_PRISMA_URL` *(write-only)* | Prod+Preview | **NONE** |
| `POSTGRES_URL` *(write-only)* | Prod+Preview | **NONE** |
| `POSTGRES_URL_NON_POOLING` *(write-only)* | Prod+Preview | **NONE** |
| `POSTGRES_USER` | Prod+Preview | **NONE** |
| `SUPABASE_ANON_KEY` | Prod+Preview | yes |
| `SUPABASE_JWT_SECRET` *(write-only)* | Prod+Preview | **NONE** |
| `SUPABASE_PUBLISHABLE_KEY` | Prod+Preview | yes |
| `SUPABASE_SECRET_KEY` *(write-only)* | Prod+Preview | **NONE** |
| `SUPABASE_SERVICE_ROLE_KEY` *(write-only)* | Prod+Preview | yes |
| `SUPABASE_URL` *(write-only)* | Prod+Preview | yes |

**Stripe**

| Var | Envs | Vault backup |
|---|---|---|
| `STRIPE_FOUNDING_PAYMENT_LINK` *(write-only)* | Prod+Preview | **NONE** |
| `STRIPE_SECRET_KEY` *(write-only)* | Prod+Preview | **placeholder only** |
| `STRIPE_WEBHOOK_SECRET` *(write-only)* | Prod+Preview | **placeholder only** |

**Telegram**

| Var | Envs | Vault backup |
|---|---|---|
| `SAGE_TRIGGER_SECRET` | Prod | **NONE** |
| `TELEGRAM_BOT_TOKEN` *(write-only)* | Prod+Preview | yes |
| `TELEGRAM_CHAT_ID` *(write-only)* | Prod+Preview | **NONE** |
| `TELEGRAM_MARKETING_BOT_TOKEN` | Prod+Preview | yes |
| `TELEGRAM_SAGE_BOT_TOKEN` | Prod+Preview+Dev | yes |
| `TELEGRAM_WEBHOOK_SECRET` | Prod | **NONE** |

**AI models**

| Var | Envs | Vault backup |
|---|---|---|
| `ANTHROPIC_API_KEY` *(write-only)* | Prod+Preview | yes |
| `FAL_KEY` | Prod+Preview+Dev | yes |
| `OPENAI_API_KEY` | Prod+Preview+Dev | yes |

**Media / rendering**

| Var | Envs | Vault backup |
|---|---|---|
| `CREATOMATE_API_KEY` *(write-only)* | Prod+Preview | yes |
| `CREATOMATE_TEMPLATE_ID` | Prod+Preview | **NONE** |
| `ELEVENLABS_API_KEY` | Prod+Preview+Dev | yes |
| `HCTI_API_KEY` *(write-only)* | Prod+Preview | **placeholder only** |
| `HCTI_USER_ID` *(write-only)* | Prod+Preview | **placeholder only** |
| `PEXELS_API_KEY` *(write-only)* | Prod+Preview | yes |
| `SHOTSTACK_API_KEY` | Prod+Preview+Dev | yes |

**DocuSeal**

| Var | Envs | Vault backup |
|---|---|---|
| `DOCUSEAL_API_KEY` | Prod+Preview+Dev | yes |
| `DOCUSEAL_TEMPLATE_AMENDMENT` | Prod | **NONE** |
| `DOCUSEAL_TEMPLATE_OPTION_EXT` | Prod | **NONE** |
| `DOCUSEAL_TEMPLATE_PRICE_CHANGE` | Prod | **NONE** |
| `DOCUSEAL_TEMPLATE_RESALE_ID` | Prod | **NONE** |
| `DOCUSEAL_WEBHOOK_SECRET` | Prod+Preview+Dev | yes |

**Email (Resend)**

| Var | Envs | Vault backup |
|---|---|---|
| `EMAIL_WATCHER_SECRET` | Prod+Preview | **NONE** |
| `RESEND_API_KEY` *(write-only)* | Prod+Preview | yes |
| `RESEND_WEBHOOK_SECRET` *(write-only)* | Prod+Preview | **NONE** |

**Analytics (PostHog)**

| Var | Envs | Vault backup |
|---|---|---|
| `NEXT_PUBLIC_POSTHOG_HOST` | Prod+Preview+Dev | **NONE** |
| `NEXT_PUBLIC_POSTHOG_KEY` | Prod+Preview+Dev | **NONE** |
| `POSTHOG_HOST` | Prod+Preview+Dev | **NONE** |
| `POSTHOG_KEY` | Prod+Preview+Dev | **NONE** |
| `POSTHOG_PERSONAL_API_KEY` | Prod+Preview+Dev | **NONE** |
| `POSTHOG_PROJECT_ID` | Prod+Preview+Dev | **NONE** |
| `VITE_POSTHOG_HOST` | Prod+Preview+Dev | **NONE** |
| `VITE_POSTHOG_KEY` | Prod+Preview+Dev | **NONE** |

**Google OAuth**

| Var | Envs | Vault backup |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Prod+Preview+Dev | **NONE** |
| `GOOGLE_CLIENT_SECRET` *(write-only)* | Prod+Preview+Dev | **NONE** |
| `GOOGLE_OAUTH_REDIRECT_URI` | Prod+Preview+Dev | **NONE** |

**Social posting**

| Var | Envs | Vault backup |
|---|---|---|
| `ZERNIO_API_KEY` *(write-only)* | Prod+Preview | yes |

**Automation / infra**

| Var | Envs | Vault backup |
|---|---|---|
| `CRON_SECRET` | Prod+Preview | yes |
| `GITHUB_TOKEN` | Prod | **NONE** |
| `N8N_API_KEY` | Prod | **NONE** |
| `N8N_MCP_TOKEN` | Prod | **NONE** |
| `N8N_MCP_URL` | Prod | **NONE** |
| `PC_HEARTBEAT_SECRET` | Prod+Preview | **NONE** |
| `VERCEL_ANALYZE_BUILD_OUTPUT` | Prod+Preview | **NONE** |
| `VOICE_INGEST_SECRET` | Prod | **NONE** |
| `ZENROWS_API_KEY` *(write-only)* | Prod+Preview | **NONE** |

**Demo / access**

| Var | Envs | Vault backup |
|---|---|---|
| `DEMO2_PASSWORD` | Prod+Preview | **placeholder only** |
| `DEMO_PASSWORD` | Prod+Preview | **placeholder only** |

**Other**

| Var | Envs | Vault backup |
|---|---|---|
| `TTS_PROVIDER` | Prod | **NONE** |

**Totals:** 68 vars · 19 with vault backup · 49 without · 23 write-only in Vercel.

### Unrecoverable today (15)

Write-only in Vercel **and** no usable vault copy — these cannot be read from anywhere:

- `SUPABASE_JWT_SECRET`
- `SUPABASE_SECRET_KEY`
- `STRIPE_FOUNDING_PAYMENT_LINK`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `TELEGRAM_CHAT_ID`
- `HCTI_API_KEY`
- `HCTI_USER_ID`
- `RESEND_WEBHOOK_SECRET`
- `GOOGLE_CLIENT_SECRET`
- `ZENROWS_API_KEY`

Plus 4 write-only `POSTGRES_*` vars (`POSTGRES_PASSWORD`, `POSTGRES_PRISMA_URL`, `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`), which are
auto-provisioned by the Supabase integration and regenerable — lower priority.

**Stripe values must be re-read from the Stripe dashboard**, not from Vercel. `STRIPE_SECRET_KEY`
is viewable only once at creation; roll it if lost. `STRIPE_WEBHOOK_SECRET` is re-readable under
Developers → Webhooks.

*Note:* the `NEXT_PUBLIC_SUPABASE_*` and `VITE_POSTHOG_*` vars mirror their unprefixed
counterparts and are publishable-by-design; the "NONE" backup flag on them is not a risk.

### Refresh this table

```bash
npx vercel env ls                                    # names + environments, never values
cmd.exe /c "bw list items --session $BW_SESSION"     # vault inventory
```

Under WSL, `bw` must be called through `cmd.exe`, and item names containing spaces fail to quote
across the boundary — use the item **ID** (`bw get password <uuid>`) instead.

Values, Zernio IDs, Stripe details, ImprovMX → `docs/ENV.md`.

