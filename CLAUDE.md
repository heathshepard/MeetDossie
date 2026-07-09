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
- `C:\Users\Heath Shepard\Desktop\Dossie` — React source. Build here.
- `C:\Users\Heath Shepard\Desktop\MeetDossie` — Vercel deploy. Push here. Cron functions, API routes, scripts, Media live here.

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
| Solo | $79 (rising to $149 on 2026-07-20 for new signups; existing subs unaffected) | $39 |
| Team | $199 (3 seats; max 8 at $35/seat) — rising to $349 on 2026-07-20 for new signups; existing subs unaffected | $119 |
| Brokerage | custom | custom |
| **Founding Member** | **$29** (25 spots, 12 taken, 13 remaining, LOCKED for LIFE of membership) | — |

Add-on prices + pricing history → `docs/PRICING-HISTORY.md`.

---

## 6. CURRENT CUSTOMERS

**MRR: $349/month** (12 founding @ $29 + Suzanne @ $1 founding friend). Full roster + notes → `docs/CUSTOMERS.md`. Update that file on every onboard/cancel and keep the Section 5 spot count in sync.

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

## 19. KEY ENV VAR NAMES (values in Vercel only)

```
TELEGRAM_BOT_TOKEN
TELEGRAM_MARKETING_BOT_TOKEN
TELEGRAM_CHAT_ID
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
CREATOMATE_TEMPLATE_ID
FAL_KEY
DEMO_PASSWORD
DEMO2_PASSWORD
```

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

## 24. CLAUDE CODE LAUNCH COMMANDS (save as `.bat` files on Desktop)

```bat
:: MeetDossie
cd "C:\Users\Heath Shepard\Desktop\MeetDossie" && claude --continue --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions

:: Dossie
cd "C:\Users\Heath Shepard\Desktop\Dossie" && claude --continue --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions
```

`--continue` resumes most recent session per cwd. **Caveat:** model swap (Opus ↔ Sonnet ↔ Haiku) starts fresh session — "save state to memory" before swap.

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
