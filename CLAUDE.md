# MeetDossie — Claude Code Operating Manual

Read this front page first every session. Topic depth lives in `docs/` — Read those on-demand (see Reference Docs index at bottom).

---

## 0. COLE'S HARD RULES — READ BEFORE ANYTHING ELSE

Non-negotiable. Every rule exists because of a repeated mistake.

**RULE 1 — SCAN BEFORE BUILD**
Run `dir scripts/` first; if a script for that task exists, USE IT — never rebuild. DossieBot Chrome profile system (`fb-group-poster.js`, `fb-group-commenter.js`, `fb-lead-scraper.js`, `instagram-engager.js`, `linkedin-engager.js`) = foundation for all local browser automation. Read `scripts/PLAYWRIGHT-SETUP.md` before any FB/IG/LinkedIn automation.

**RULE 2 — "I DID IT ALREADY" MEANS IT WORKED**
When Heath says he completed a setup, assume success. No silent-failure assumptions without concrete evidence (actual error or confirmed missing file). "UNRESOLVED" in auto-summaries = the blocker, not the infrastructure (which may be fully built).

**RULE 3 — SUMMARIES LIE ABOUT WHAT'S BUILT**
Auto-summaries optimize for blockers, not inventory. Verify files on disk before concluding something isn't built. `dir scripts/` takes 2s.

**RULE 4 — FOUNDING FILES AUTO-POSTING FLOW**
The Founding Files FB group (facebook.com/share/g/1P2QL9T42t/) posts autonomously via `fb-group-poster.js`. DossieBot Chrome profile already has FB logged in. To post: insert row in `group_posts` (group_name, group_url, post_body, status='approved', template_id='direct'), run `node scripts/fb-group-poster.js --post-id [uuid]`. Close DossieBot Chrome window first.

**RULE 5 — MEMORY FOR SETUP STEPS**
Every one-time setup Heath completes (Chrome profile, session capture, API key, account connect) → write a memory entry naming the EXACT file/profile/system created. "Setup complete" not enough — name what was built.

**RULE 6 — VERIFY BEFORE RECOMMENDING**
Before recommending any tool/library/service install, check: (1) CLAUDE.md Section 2 Tech Stack, (2) `scripts/` imports, (3) `.claude/projects/*/memory/reference_existing_tools.md`. Never say "install X" when we already use X. If we use X via scripts but not as a direct MCP tool, say exactly that.

---

## 1. WHAT DOSSIE IS

- **Tagline:** Your deals. Her job. **Audience:** Texas REALTORS (SA launch → statewide). **Name:** dossier.
- **Two-door:** (A) agents replacing a TC ($400/file → $29-49/mo); (B) TCs scaling solo (3x files).
- **Architecture:** vertical-agnostic AI core + Texas-TREC config layer. Swap config to map other states. Acquisition story: 3-10× ARR multiple from Zillow/Lone Wolf/CoStar.
- **Dossie is always "she/her."** Warm, capable, never corporate.

---

## 2. TECH STACK

| Layer | Choice | Notes |
|---|---|---|
| Frontend | React (Vite) | Source in `Dossie` repo, deployed via `MeetDossie` repo |
| Hosting | Vercel | Auto-deploys on push to `MeetDossie/main`. **Never run `vercel --prod` manually.** |
| Database | Supabase | Project ID `pgwoitbdiyubjugwufhk` |
| Auth | Supabase Auth | `auth.users` + `auth.identities` + `public.profiles` |
| Email | Resend | From `heath@meetdossie.com` (ImprovMX → `heath.shepard@kw.com`) |
| Payments | Stripe | Founding price `price_1TPxxNL920SKTEEiN7Gphq8T` ($29/mo) |
| Social posting | Zernio | $18/mo, 4 accounts, unlimited posts |
| Card renderer | HCTI | `HCTI_USER_ID`+`HCTI_API_KEY`. Free 50/mo; $14/mo at 1k. |
| Voice TTS | ElevenLabs | Bill `pqHfZKP75CvOlQylNhV4`, Luna `lxYfHSkYm1EzQzGhdbfc`. Creator $18.33/mo, 30k credits. |
| Stock video | Pexels API | portrait→vertical, landscape→square |
| Video assembly | Creatomate | Template `791117d0-665c-4cd0-ba5f-a767f8921f9b`. Fields: Image-K8V, Persona-Name, Caption, Voiceover (Bill). |
| Selfie video | Submagic | $12/mo Starter. Manual upload (API needs $60/mo Business). Doc: `scripts/SELFIE-VIDEO-WORKFLOW.md`. |
| AI b-roll | fal.ai + Kling 2.5 | `FAL_KEY`. ~$0.84/5s clip. `POST /api/generate-broll`. |
| Telegram | Two bots | **Claudy** (`TELEGRAM_BOT_TOKEN`) personal+DONE. **DossieMarketingBot** (`TELEGRAM_MARKETING_BOT_TOKEN`) post approve/reject. |

**Repo layout — TWO repos:**
- `C:\Users\Heath\Projects\Dossie` — React source. Build here. *(not cloned on this machine as of 2026-07-28)*
- `C:\Users\Heath\Projects\MeetDossie` — Vercel deploy. Push here. Cron functions, API routes, scripts, Media live here.

Paths corrected 2026-07-28 — the Windows profile is `Heath`, not `Heath Shepard`, and the repos live under `Projects\`, not `Desktop\`. Under WSL these are `/mnt/c/Users/Heath/Projects/...`.

**Monthly fixed costs:** $81.65 (Zernio $18 + ElevenLabs $18.33 + Submagic $12 + Hiscox E&O $33.32; Vercel/Supabase/Creatomate/HCTI/Resend/Pexels/Stripe = $0). Variable: Stripe 2.9%+30¢/charge, HCTI $14/mo at 1k renders.

---

## 3. DEPLOY WORKFLOW — STAGING FIRST, THEN PRODUCTION

**CRITICAL:** All development on `staging` first. Merge to `main` only after tests pass.

**Staging URL:** `npx vercel ls` in MeetDossie for latest Preview URL (changes per push). Never hardcode.
**Production URL:** https://meetdossie.com

### Standard workflow

1. `git checkout staging`
2. Build in Dossie repo: `cd ../Dossie && npm run build`
3. Copy bundle: `cp dist/assets/workspace-*.js ../MeetDossie/assets/`
4. Update hash references in `app.html` and `workspace.html`; remove old bundle via `git rm assets/workspace-[OLD-HASH].js`
5. Commit + push to staging (Vercel auto-deploys preview)
6. Test on staging preview URL
7. After Heath approves: `git checkout main && git merge staging && git push`
8. Tag: `git tag GOLD-[YYYY-MM-DD]-v[N]-[desc] && git push origin [tag]`

**Never run `vercel --prod` manually** — Vercel auto-deploys from GitHub.
**Never push directly to main** — always go through staging first.

### Pre-merge QA gate (mandatory)

After EVERY Carter staging push, Cole auto-spawns Quinn (no prompt needed). Quinn runs full test suite, loops with Carter up to 3 times to fix ALL failures (including "non-blocking"). Then: "QUINN: All clear on staging. Ready to merge when you are."

**Heath says "merge it"** before Cole touches main. No exceptions, no quick fixes, no urgent patches. Cole never auto-merges. Heath is always the final gate.

---

## 4. BRAND RULES

| Token | Hex | Use |
|---|---|---|
| Blush | `#F5E6E0` | Primary accent, screen-recording letterbox, founding card backgrounds |
| Blush deep | `#D4A0A0` | Secondary accent, icon fills |
| Sage | `#8BA888` | Success, "active" badges |
| Gold | `#C9A96E` | Founding badge, premium signals |
| Navy | `#1A1A2E` | Outro CTA cards, dark headlines |
| Coral | `#E8836B` | Salmon CTA, social card top stripe (`#E8927C` per app.html favicon) |

**Fonts:** Cormorant Garamond (headings/brand/social hooks), system sans-serif (body/UI).
**Voice:** warm, feminine, capable, never corporate.

---

## 5. PRICING — LOCKED. AUTHORITATIVE. NEVER CHANGE WITHOUT EXPLICIT INSTRUCTION FROM HEATH.

| Tier | Monthly | Annual |
|---|---|---|
| Solo | $79 (rising to $149 on 2026-07-31 for new signups; existing subs unaffected) | $39 |
| Team | $199 (3 seats; max 8 at $35/seat) — rising to $349 on 2026-07-31 for new signups; existing subs unaffected | $119 |
| Brokerage | custom | custom |
| **Founding Member** | **CLOSED 2026-08-04** — no new signups. 10 existing members remain LOCKED for LIFE at $29/mo per Terms of Service §4 | — |

Add-on prices + pricing history → `docs/PRICING-HISTORY.md`.

---

## 6. CURRENT CUSTOMERS

**MRR: $291/month** (10 founding @ $29 + Suzanne @ $1 founding friend). Corrected 2026-08-04 — the prior $320/11-founder figure double-counted Suzanne as a full $29 founder on top of her own $1 line; live DB has 11 active `plan='founding'` rows total, one of which is her. Also on record: 2 cancelled, 1 pending_onboarding (approved, not yet paying — doesn't count toward taken). Full roster + notes → `docs/CUSTOMERS.md`. Update that file on every onboard/cancel and keep the Section 5 spot count in sync.

---

## 14. DISTRIBUTION STRATEGY (summary)

Source of truth: `DISTRIBUTION-STRATEGY.md`. 4 pillars: **Cost, Control, Visibility, Speed** (Control = strongest for high-volume agents). URL strategy: `/founding` until 22/25 filled, then `meetdossie.com`. Platforms FB/Twitter/IG/LinkedIn live; LinkedIn gets Victor's Friday slot via `cron-generate-posts.js`. Personas Brenda/Patricia/Victor, algorithm-optimized per platform.

---

## 15. SECURITY RULES — NON-NEGOTIABLE

1. **NEVER hardcode auth tokens, API keys, or secrets in source code.**
2. **NEVER use the "one-shot bypass token" pattern** — git history is permanent and public.
3. All secrets live in Vercel env vars only.
4. If a cron needs manual triggering, use `CRON_SECRET` from `.env.local` via curl locally.
5. If `CRON_SECRET` isn't available locally, **ask Heath to run the curl** — never embed a bypass.
6. GitGuardian monitors the repo. Violations are detected immediately.

**Why non-negotiable:** `heathshepard/MeetDossie` is a PUBLIC GitHub repo. 2026-05-06 bypass commit `f3700b2` was reverted in 79s but lived in public history until scrubbed via `git filter-repo`. Reverts do not undo public exposure. History rewrites are destructive force-pushes.

**Approved manual-trigger patterns:**
- Local curl: `curl -H "Authorization: Bearer $CRON_SECRET" https://meetdossie.com/api/cron-publish-approved` (value in `.env.local`).
- Ask Heath to fire one-liner via Telegram.
- Debug param `?force=1` gated behind existing `Bearer $CRON_SECRET`.

**Forbidden:** literal API keys / JWTs / bearer strings in any tracked file; `const ONE_SHOT_TOKEN` with fallback bypass; "I'll commit then revert."

**Current status:** `CRON_SECRET` in Vercel + required on all crons. `SUPABASE_SERVICE_ROLE_KEY` rotated 2026-05-10. Never paste secrets in Telegram or Claude.ai.

Incident history → `docs/INCIDENT-LOG.md`.

---

## 17. HOW TO WORK WITH THIS CODEBASE

### RESPONSE LENGTH + SPEED — APPLIES TO EVERY AGENT

Heath's words, 2026-07-28: responses are "extremely too lengthy" and take
"extremely too long." Reading a wall of tables costs him more time than the work
saved.

1. **Default is 3-6 lines.** What happened, the number that matters, the one open
   question. Expand only when Heath asks, or when something broke.
2. **Answer in ONE place.** If it goes to Telegram, the terminal gets a single
   line — and vice versa. Writing the same answer twice doubles latency and
   doubles what Heath has to read.
3. **Don't narrate verification.** "Verified, 0 broken" — not the table of every
   check run. Keep the rigor, drop the play-by-play.
4. **No preambles.** Don't restate his request, don't announce what you're about
   to do, don't recap at the end.
5. **Speed:** batch independent tool calls into one block. Skip dry-runs once a
   pattern is proven. Never poll Vercel in 15s loops — each `npx vercel ls`
   through `cmd.exe` costs seconds; retry the real call instead.

Long-form is for exactly two things: a decision only Heath can make, or a report
he asked for.

### VERIFY IN A REAL BROWSER BEFORE HANDOFF — NON-NEGOTIABLE

Heath's words, 2026-08-04, after a Jarvis voice fix broke on first real use:
"I don't want to have to troubleshoot that's why we have agents for... you
just have someone or you troubleshoot it yourself before you tell me it works
using playwright or Chromium so it's from the user perspective not just
looking at the code in the back end."

**Never tell Heath a UI or voice change works based on reading the code or a
backend-only test.** Calling a handler directly, curling an API, checking that
a function returns 200 — none of that exercises sign-in, the real click, or
what actually renders/speaks back. It cannot catch wrong-account auth,
service-worker cache staleness, or a button wired to the wrong handler — all
real bugs that have shipped this way.

**Before saying "try this" for anything UI or voice, any agent (not just
Cole) must:**
1. Playwright: navigate to the real URL, sign in for real, click/type exactly
   what Heath would.
2. Confirm the RESULT rendered on screen or spoken aloud — not just that a
   network call returned 200.
3. If it's broken, fix it and re-verify the same way before handing it back.
4. Only then does Heath get the link.

Backend-level testing is still fine for isolating a bug once something's
already broken. It is never sufficient on its own to call something done.

### COLE'S ROLE — NON-NEGOTIABLE

Cole is Chief of Staff. Cole NEVER writes code, edits files, runs git, or executes state-changing shell commands. No exceptions, not even "quick fixes."

**Cole only:** reads files/code, writes memory in `.claude/projects/`, spawns subagents (Carter/Atlas/Hadley/Pierce/Sage/Quinn), communicates with Heath.

**Everything else → agent:** file edits, git, DB migrations, state-changing API calls, shell → Carter or Atlas. If Cole reaches for Edit/Write/Bash/PowerShell to change state — STOP, spawn Carter/Atlas. Size of task irrelevant.

### COLE'S MEMORY RULES — NON-NEGOTIABLE

Session auto-summaries are lossy. Memory is the only reliable persistent layer.

1. Every person Heath names → memory file immediately (leads, customers, referrals, partners). Same turn.
2. Every task, call, meeting, decision → memory file immediately.
3. End of every session → SESSION-DIARY.md entry (people, decisions, open threads, pending Heath action items) at `MeetDossie/SESSION-DIARY.md`.
4. Never rely on auto-summaries for people/tasks — they catch milestones not context.

Skipping a memory because "not important enough" = failure. Write it anyway. **Why:** Amber Higgs (Lisa Nilsson referral) was mentioned 2026-05-28 and dropped from auto-summary. Heath had to point it out next day.

### Discovery rules — when to Read which doc

- Customer-specific tasks (any named customer, MRR math, onboarding history) → Read `docs/CUSTOMERS.md` first.
- Video/social work (recording, voiceover, posting schedule, persona rules, pipeline crons) → Read `docs/VIDEO-RULES.md` + `docs/PIPELINE.md`.
- Env vars / external service config (Stripe, ImprovMX, Zernio IDs, secrets) → Read `docs/ENV.md`.
- Recovering from broken state → check `docs/GOLD-HISTORY.md` for recovery tags.
- Picking what to ship next → check `docs/TECH-DEBT.md`.
- Demo account questions (passwords, persona mapping, seeding) → Read `docs/DEMO-ACCOUNTS.md`.
- Pricing-change discussion → Read `docs/PRICING-HISTORY.md` (current pricing stays in CLAUDE.md Section 5).

### Codebase rules
- **Two repos:** build in `Dossie`, deploy from `MeetDossie`.
- Clean rebuild > iterative patch when component is fundamentally broken. Flag immediately.
- Read `DISTRIBUTION-STRATEGY.md` before marketing build; `Media/screen-recordings/LIBRARY.md` before screen-rec selection; `RENDER_FEEDBACK_LOG.md` + `RENDER_RULES` in `generate-lifestyle-video.py` before video build/render.
- Video assembly: Creatomate template `791117d0-665c-4cd0-ba5f-a767f8921f9b`, script `generate-creatomate-video.py`.
- Tag stable milestones: `GOLD-[YYYY-MM-DD]-v[N]-[desc]`.
- Never commit secrets. Test in production (Vercel) — local env mostly empty by design.
- Two-chat workflow: Heath uses Claude.ai Sonnet (strategy), Claude Code Opus (execution). Restart daily; this file = full context.
- Never present partial as complete — verify with live URL or actual output.
- Never guess API response shapes — probe first.

---

## 19. ENV VARS — 68 LIVE IN VERCEL (audited 2026-07-27)

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

---

## 20. LIVE URLS

| Page | URL |
|---|---|
| App | `meetdossie.com/app` |
| Workspace | `meetdossie.com/workspace` |
| Founding | `meetdossie.com/founding` |
| Agents | `meetdossie.com/agents` |
| Coordinators | `meetdossie.com/coordinators` |
| Calculator | `meetdossie.com/calculator` |
| Guides hub | `meetdossie.com/guides/` |
| Answers hub | `meetdossie.com/answers/` |
| Sitemap | `meetdossie.com/sitemap.xml` |

---

## 21. SUPABASE KEY TABLES

| Table | Purpose |
|---|---|
| `profiles` | Agent user data (source of truth for Settings) |
| `transactions` | Deal / dossier records |
| `documents` | Uploaded files |
| `action_items` | Checklist tasks |
| `email_queue` | Drafted emails |
| `social_posts` | Content engine (status: draft/approved/publishing/posted/failed/pending_video/rejected) |
| `content_calendar` | 25 entries, 5 weeks, `persona` column |
| `posting_schedule` | Per-platform slots + daily caps |
| `founding_applications` | Apps w/ `heard_from` |
| `subscriptions` | Active paying customers |
| `waitlist` | Homepage email captures |
| `calculator_signups` | TREC calc captures (source='calculator') |
| `dossier_milestones` | Closing cards. **TECH DEBT: `canvas_data_url` in DB; migrate to Storage <50 cust.** |
| `share_events` | Share button (copy/facebook/sms) |
| `post_analytics` | Planned Zernio engagement (not built) |

Storage buckets: `documents` (private), `social-cards` (public, 5MB, image/png+jpeg).

---

## 22. FOUNDING APPLICATION FLOW

1. Apply at `/founding` (7-field form w/ `heard_from`).
2. DossieMarketingBot → Heath's Telegram (Approve/Reject buttons).
3. Approve → Stripe checkout + Resend approval email from `heath@meetdossie.com`.
4. Pay → Stripe webhook → `subscriptions`+`profiles` rows.
5. Scarcity banner auto-updates from `subscriptions`.

---

## 23. HEATH'S BACKGROUND

- TX REALTOR at KW City View / KW Boerne, San Antonio. `heath.shepard@kw.com` / `heath@meetdossie.com`.
- Goal: location-independent (Hawaii long-term). Also runs Plane & Ember (cigar woodwork, SA).
- Speed > perfection. Voice-transcription user (interpret prompts charitably). Direct style; low hedge tolerance.

---

## 24. CLAUDE CODE LAUNCH COMMANDS

**Use the Desktop launchers — don't type `claude` by hand.**
`C:\Users\Heath\Desktop\MeetDossie.bat` and `C:\Users\Heath\Desktop\Dossie.bat`
(written 2026-07-28). Double-click either one.

**Never launch bare `claude`.** Without `--channels`, Claude Code never polls
Telegram and **Cole silently stops responding** — the bot looks perfectly
healthy from Telegram's side while nothing is listening. This caused an outage
on 2026-07-27.

Claude Code runs from the **WSL** install (`/home/heath/.local/bin/claude`), not
the Windows `claude.exe`. Both exist and both have the telegram plugin, but they
keep **separate session history**, so `--continue` under Windows will not find
WSL conversations. The `.bat` files launch WSL deliberately:

```bat
wsl.exe -d Ubuntu -- bash -lc "cd /mnt/c/Users/Heath/Projects/MeetDossie && exec claude --continue --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions"
```

**Repo paths (corrected 2026-07-28).** The old entry pointed at
`C:\Users\Heath Shepard\Desktop\...`, which does not exist — the Windows profile
is `Heath`, not `Heath Shepard`.

| Repo | Windows path | WSL path | Present? |
|---|---|---|---|
| MeetDossie | `C:\Users\Heath\Projects\MeetDossie` | `/mnt/c/Users/Heath/Projects/MeetDossie` | yes |
| Dossie | `C:\Users\Heath\Projects\Dossie` | `/mnt/c/Users/Heath/Projects/Dossie` | **not cloned yet** |

`Dossie.bat` exits with a message rather than opening the wrong directory until
that repo is cloned.

`--continue` resumes most recent session per cwd. **Caveat:** model swap (Opus ↔ Sonnet ↔ Haiku) starts fresh session — "save state to memory" before swap.

**If Cole goes quiet, check in this order:** (1) is a `claude` process running
with `--channels` — `tr '\0' ' ' < /proc/<pid>/cmdline`; (2) `getWebhookInfo` —
a registered webhook blocks `getUpdates` with 409 and silently eats messages,
clear it via `/api/delete-claudy-webhook`; (3) queued updates via `getUpdates` —
messages sitting unconsumed mean nothing is polling.

Claude.ai Sonnet = strategy/prompts. Claude Code Opus = execution. Heath pastes large complete prompts. Reports back via Telegram. Keep sessions short/focused.

---

## 25. REFERENCE DOCS (Read on-demand)

Topic depth lives here. Read before working in that area — don't carry the whole repo in your head.

| File | Use when |
|---|---|
| `docs/CUSTOMERS.md` | Working with any named customer, MRR math, onboarding history, Brittney context. Update on every onboard/cancel. |
| `docs/VIDEO-RULES.md` | Screen recording naming, video pipeline rules, content calendar, voiceover rules, posting schedule, media folder layout. |
| `docs/PIPELINE.md` | Social posting crons, content rules (third-person, ASCII, field caps), social accounts + Zernio account IDs. |
| `docs/GOLD-HISTORY.md` | Recovering from broken state — find a known-good GOLD tag to check out. |
| `docs/TECH-DEBT.md` | Picking what to ship next, active blockers, deferred items, urgent personal action items (LLC, ToS). |
| `docs/PRICING-HISTORY.md` | Pricing history + rationale + add-on prices. Current pricing stays in Section 5 of this file. |
| `docs/ENV.md` | Env var values, Zernio account IDs, Stripe + ImprovMX details. |
| `docs/INCIDENT-LOG.md` | Past incidents and their prevention rules — Brittney 2026-05-08, Stripe webhook gap. |
| `docs/DEMO-ACCOUNTS.md` | Demo passwords, persona mapping, analytics exclusion rule. |
| `docs/CONTENT-PIPELINE.md` | Nightly guide/feature/answer page generation — topic selection, agent research contract, Telegram approve/reject flow, promotion to `marketing/*-data/`. |
