# MeetDossie — Claude Code Operating Manual

This file is read at the start of every Claude Code session. It completely replaces re-briefing — assume nothing, look here first.

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

---

## 2.5. MONTHLY OPERATING COSTS

| Service | Plan | Monthly Cost | Notes |
|---|---|---|---|
| Vercel | Hobby (Free) | $0 | Auto-deploys, serverless functions |
| Supabase | Free | $0 | 500MB database, 1GB storage |
| Zernio | Pro | $18.00 | 4 social accounts, unlimited posts |
| ElevenLabs | Creator | $18.33 | 30k credits/month, upgraded 2026-05-19 |
| Creatomate | Free | $0 | Video rendering |
| HCTI | Free | $0 | 50 renders/month (upgrade at $14/mo when needed) |
| Resend | Free | $0 | Email sending |
| Pexels | Free | $0 | Stock video API |
| Stripe | Pay-as-you-go | $0 | 2.9% + 30¢ per transaction |
| Submagic | Starter | $12.00 | Selfie-video editing. |
| Hiscox | E&O | $33.32 | $1M/$1M, $500 ded. Quote #S111.020.194. Paid personally — reimburse from Mercury. |

**Total monthly fixed costs: $81.65**

**Variable costs:**
- Stripe transaction fees (2.9% + 30¢ per charge)
- HCTI upgrade at 1,000 renders/month ($14/mo)

---

## 3. DEPLOY WORKFLOW — STAGING FIRST, THEN PRODUCTION

**CRITICAL:** All development on `staging` first. Merge to `main` only after tests pass.

**Staging URL:** `npx vercel ls` in MeetDossie for latest Preview URL (changes per push). Never hardcode.
**Production URL:** https://meetdossie.com

### Standard workflow:

```bash
# 1. Switch to staging branch
git checkout staging

# 2. Build the React bundle (Dossie repo)
cd "C:\Users\Heath Shepard\Desktop\Dossie" && npm run build

# 3. Copy bundle into MeetDossie
cp dist/assets/workspace-*.js ../MeetDossie/assets/

# 4. Update hash references in app.html and workspace.html (replace old workspace-*.js with new)
# 5. Remove the previous bundle file
git rm assets/workspace-[OLD-HASH].js

# 6. Commit + push to staging (Vercel auto-deploys to staging URL)
git add . && git commit -m "Deploy workspace-[NEW-HASH]" && git push

# 7. Test at staging URL

# 8. When confirmed working, merge to main and push to production
git checkout main && git merge staging && git push

# 9. Tag stable milestones
git tag GOLD-[YYYY-MM-DD]-v[N]-[description] && git push origin [tag]
```

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
**Logo:** Dossie "D" in blush circle. `Media/dossie-logo-d.{png,svg}`, `Media/dossie-logo-horizontal.png`.

---

## 5. PRICING — LOCKED. AUTHORITATIVE. NEVER CHANGE WITHOUT EXPLICIT INSTRUCTION FROM HEATH.

| Tier | Monthly | Annual |
|---|---|---|
| Solo | $79 | $39 |
| Team | $199 (3 seats; max 8 at $35/seat) | $119 |
| Brokerage | custom | custom |
| **Founding Member** | **$29** (50 spots, 12 taken, 38 remaining) | — |

**Add-ons:**
- Reply Monitoring — $10/mo
- AI Autopilot — $15/mo
- Compliance Vault — $10/mo
- White Label — $200-500/mo
- Scans — 5 free, then $1.50 each
- E-sig — 10 free, then $0.50 each
- Onboarding — $99 one-time

**PRICING HISTORY:** 2026-05-15 raised Solo $49→$79, Team $149→$199, seats $25→$35 (DealDock $79 / ListedKit $49+ benchmark). Founding $29/mo locked forever — non-negotiable.

---

## 6. CURRENT CUSTOMERS

**MRR: $349/month** (12 founding @ $29 + 1 friend @ $1)

| # | Name | Email | Plan | Notes |
|---|---|---|---|---|
| 1 | Kimberly Herrera | — | $29/mo founding member | — |
| 2 | Tiffany Gill | — | $29/mo founding member | — |
| 3 | Brittney YBarbo | brittney@setxrealty.com | $29/mo founding | Broker, 80 tx/yr, SE TX. Via FB search "transaction coordinating in Texas". Control-freak → Week-5 `control_freak_agent` content. Team-tier upsell 60-90d. **Ask testimonial at 30d.** |
| 4 | Suzanne Page | k.suzanne.page@gmail.com | $1/mo founding friend (`FOUNDING_FRIEND`) | — |
| 5 | Miki Mccarthy | mikirgvrealtor@gmail.com | $29/mo founding | RGV/McAllen. 2026-05-20. My Real Estate Company. First RGV. Phone+heard_from TBD. |
| 6 | Cecilia Whitley | cecilia@sterlingassociatesre.com | $29/mo founding | Austin. 2026-05-20. Sterling and Associates. First Austin. Phone+heard_from TBD. |
| 7 | Terry Katz | michellesellshouston@gmail.com | $29/mo founding | Houston/Spring. 2026-05-20 via DIRECT STRIPE INVOICE — manual recovery (see project_stripe_webhook_gap.md). Brokerage/phone/heard_from TBD. |
| 8 | Amanda Nuckles | amanda@amandanuckles.com | $29/mo founding | Central TX. 2026-05-20. All City Real Estate. 5127340036. First to use new onboarding form. Heard: Facebook group (specific TBD). |
| 9 | Zelda Cain | zelda@a2zrealestateconsultants.com | $29/mo founding | Houston. 2026-05-21. A2Z Real Estate Consultants LLC. (281) 813-6887. Heard: friend/colleague (possibly Terry, 2nd Houston). First word-of-mouth. |
| 10 | Natalie Megerson | natalie@localchoicegroup.com | $29/mo founding | SA+Austin+San Marcos multi-market. 2026-05-22 04:10 UTC. REAL Broker. 5125575549. Heard: Facebook. **HOT TEAM-tier LEAD** — DM'd same morning re "large team in San Marcos". First multi-seat opportunity. Push founding signups per team member. |
| 11 | Jennifer Beltrán | jenn.casamiateam@gmail.com | $29/mo founding | Casa Mia Real Estate LLC. 9568671723. Paid 2026-05-22 14:27 CDT, webhook never provisioned — manual 2026-05-24 after she messaged. **2ND webhook-gap** (after Terry). Password recovery sent 2026-05-24. |
| 12 | Lisa Nilsson | lisanilssontx@gmail.com | $29/mo founding | Boerne/Hill Country SA. 2026-05-28. Premier Hill Country Properties. 210-288-4476. Heard: friend/colleague. Manually provisioned (3rd webhook-gap: Terry, Jennifer, Lisa). |

---

## 7. WHAT'S BUILT AND WORKING

**App:**
- React app at `/app` and `/workspace`. Supabase auth + profiles/transactions/documents/action_items/email_queue.
- Morning Brief (daily audio+text summary, ElevenLabs Luna).
- Talk to Dossie (voice/text contract fill + deal updates).
- TREC deadline auto-calc (cited to paragraph). Pipeline dashboard w/ deal cards + deadline badges.
- Closing milestone cards (shareable, privacy-safe, `dossier_milestones`). Milestones section + trophy badge on pipeline cards.
- Share Dossie button — sidebar (desktop) + mobile bottom nav, tracks `share_events`. Anchor nav in dossier detail.
- NL deadlines ("Option period expires in 2 days"). Settings data flow fixed (`profiles` = source of truth).
- Desktop document buttons inline (horizontal desktop, stacked mobile — 2026-05-28).
- Agent voice in Ventures dashboard (`api/ventures/voice-chat.js` + ventures.html — 2026-05-28).
- Ventures auth isolation (`ventures.auth.token` storage key, independent from Dossie session — 2026-05-28).

**Documents + E-sign:**
- DocuSeal e-sign (all 3 phases, 2026-05-28): Phase 1 PDF upload → signed URL → emailed (`api/esign-create.js`); Phase 2 per-signer field coords; Phase 3 template-based w/ transaction prefill. Endpoints: `esign-webhook.js` (HMAC-SHA256), `esign-download.js`, `esign-status.js`, `esign-templates.js`. UI: `EsignModal.jsx`.
- Form Library (2026-05-28): `public.form_templates` (12 TREC forms). `api/form-templates.js` GET (by category) + POST {action:'attach'}. `FormLibraryModal.jsx` search by name/TREC #.
- Form Packages (2026-05-28): `public.form_packages` + `public.form_package_items`. System defaults Buyer + Seller (locked). `api/form-packages.js` GET/POST {action:'apply'|'create'}/PATCH/DELETE. Packages tab in FormLibraryModal (sage=buyer, coral=seller, gold=custom). Bulk attach, dedupe.
- Fill-and-sign Phase 1 (2026-05-28): `api/fill-form.js` loads base64 PDF, fills AcroForm via pdf-lib, uploads to Storage, creates docs row. `api/extract-form-fields.js` Claude Haiku NLP from agent voice. Base64 PDFs at `api/_assets/trec-{resale,financing,termination}-base64.js`. Types: `resale-contract`, `financing-addendum`, `termination-notice`, `amendment`. Field maps from `scripts/document_field_maps.py` (257 AcroForm fields on resale). Talk-to-Dossie integration live.
- Amendment drafting: `api/draft-amendment.js` fills TREC 39-10 (`closing_date`/`option_extension`/`price_change`). NL entry via Talk to Dossie wired through fill-form.js.

**Conversion + leads:**
- Founding application flow (7-field form including `heard_from` → Telegram approval buttons → Stripe checkout → Resend approval email)
- Stripe checkout for founding members (`price_1TPxxNL920SKTEEiN7Gphq8T`)
- Scarcity banner — live founding count from `subscriptions` table

**Distribution:**
- Zernio pipeline: FB/Twitter/IG/LinkedIn live. Twitter thread-split max 6 chunks (`splitForTwitter` in `api/cron-publish-approved.js`).
- IG+FB image card renderer (Python Pillow, `scripts/render-card.py`, uploads to Storage).
- Daily content briefs via Claudy 9AM CST weekdays. Calendar: 25 entries, 5 weeks, personas brenda/patricia/victor.
- Lifestyle video pipeline (Pexels + ElevenLabs + ffmpeg + Zernio).
- TREC calculator at `/calculator` (email → `calculator_signups`). 10 SEO guides `/guides/`. 5 AEO answers `/answers/`.
- MCP server published to npm `@dossie/mcp-server` + HTTP `meetdossie.com/api/mcp`.

---

## 8. NOT DONE / ACTIVE BLOCKERS

- Brokerage compliance document sending (specced, not built — high value)
- Stripe Payment Links (permanent, non-expiring) — current checkout sessions expire 24h
- MCP server registry submissions: MCPT / OpenTools (Smithery ✅ live)
- TikTok automation (manual only until ~May 20, 2026)
- Zernio analytics feedback loop (`post_analytics` table specced, not built)
- Brevo email nurture sequence (segmented agent vs TC)
- Lifestyle video Zernio video-post creation (upload works `put_status=200`; post creation `--auto-post` opt-in only)
- **Amendment drafting** — LIVE incl. NL entry. `api/draft-amendment.js` handles TREC 39-10 (closing_date/option_extension/price_change). NL: Talk to Dossie → `extract-form-fields.js` → `fill-form.js`. Wired 2026-05-28.
- **Fill-and-sign Phase 2** — interactive drag-drop sig/date/initials placement UI on PDF canvas before DocuSeal. Phase 1 auto-places; Phase 2 = visual control. Not built.
- **Fill-and-sign remaining generators** — HOA Addendum (TREC 36-11), Lead-Based Paint (OP-L), Seller's Disclosure (OP-H). PDFs in `Dossie Forms/TREC Base/`, no JS generators.
- **TREC 49-1** (Right to Terminate, Lender's Appraisal — new Jan 2025, split from 40-11). Not in library/generators.
- **Dossier transaction type expansion** — add `transaction_type` field to transactions + auto-load correct package (types: buyer_purchase, seller_listing, new_home_purchase, land_purchase, residential_lease_landlord, residential_lease_tenant). Currently all use same package.
- **More Form Packages** — land, new home, rental landlord, rental tenant. Only Buyer + Seller exist as defaults.
- **Social Media Autopilot** — extend in-house pipeline (cron-generate-posts → DossieMarketingBot → cron-publish-approved → Zernio) to customer-facing add-on. Agents connect FB/IG/LI/TT via Zernio, Dossie drafts daily from listings/market/sphere, Telegram one-tap approval. Cost: ~180 posts/mo @ Haiku = ~$0.30/mo Claude; Zernio flat $18/mo paid. Price: $20/mo ($10 founding). Strategy doc: `SOCIAL-MEDIA-AUTOPILOT-STRATEGY.md`. Flagged 2026-05-21.
- **SMS escalation (Twilio)** — critical deadline + draft-aging alerts. ~$0.0075/msg, ~50¢/agent/mo. Needs phone capture (done) + opt-in toggle. Phase 2 deferred.
- **Voice escalation (Twilio Voice)** — last-resort call when other channels fail. ~$0.013/call. Phase 3 after SMS. Deferred.
- **Customer Education & Onboarding** — Phase 1 welcome email covers all systems, empty-state hints, "What's New" banner. Phase 2 7-day drip, product tour, feature modals. Phase 3 knowledge base `meetdossie.com/help`, tutorials, tooltips. Activation/churn risk. Flagged 2026-05-21.
- **Ginger Unger partnership** — Miki (#5) + likely Amanda found Dossie via her TX RE FB group. Highest-leverage distribution lead. Actions: (a) DM thanks + offer founding spot for review, (b) affiliate % of MRR, (c) paid endorsement / trainings guest. Engage FIRST before posting in group. Heath DM'd 2026-05-21.
- **🚨 URGENT: Form TX LLC + insurance + business bank** — Heath operating as sole prop → unlimited personal liability (house/savings/KW commissions exposed). Steps: (1) TX LLC $300 sos.state.tx.us/SOS Direct, (2) EIN IRS free, (3) business bank, (4) move Stripe/Vercel/Supabase billing to LLC, (5) update WHOIS, (6) Cyber+E&O $50-200/mo (Embroker/Hiscox). #1 PERSONAL ACTION. Do BEFORE next paying customer.
- **Privacy Policy + ToS** — none exist on meetdossie.com → legal exposure. PP must disclose subprocessors (Supabase/Anthropic/Resend/Stripe/ElevenLabs). ToS limits liability. Drafts 2026-05-21; attorney review before live or accept indie-SaaS risk.

---

## 9. NEXT PRIORITIES (in order)

1. MCP server registry submissions (Smithery ✅ live; MCPT + OpenTools pending)
2. Brevo email nurture (agent vs TC segmented)
3. Zernio analytics feedback loop
4. Lifestyle video Zernio post creation (upload works; post creation pending)
5. TikTok automation gate flip (~May 20, 2026)

(Done 2026-05-07: Stripe Payment Links, brokerage compliance send, LinkedIn Zernio, first-time onboarding checklist, MCP server npm+HTTP.)

---

## 10. DEMO ACCOUNTS — LOCKED. DO NOT CHANGE.

| Email | Password (env var) | Profile Name | Personas | Voice |
|---|---|---|---|---|
| `demo@meetdossie.com` | `DEMO_PASSWORD` = `DossieDemo-VaIiAt6Bab` | Sarah Whitley | brenda, patricia | Luna |
| `demo2@meetdossie.com` | `DEMO2_PASSWORD` = `DossieDemo2-John2026` | John Smith | victor | Bill |

Both seeded with 6 transactions, 25 documents, 20 action items.

---

## 11. PERSONA → DEMO ACCOUNT MAPPING — LOCKED

| Persona | Demo account | Voice |
|---|---|---|
| brenda | Sarah Whitley / `demo@meetdossie.com` | Luna |
| patricia | Sarah Whitley / `demo@meetdossie.com` | Luna |
| victor | John Smith / `demo2@meetdossie.com` | Bill |

---

## 12. SCREEN RECORDING NAMING CONVENTION

```
<topic-slug>-mobile-<YYYY-MM-DD>.mp4   → portrait → IG, TikTok
<topic-slug>-desktop-<YYYY-MM-DD>.mp4  → landscape → FB, Twitter, LinkedIn
```

`mobile`/`desktop` segment = single source of truth for platform routing (`derive_aspect_and_platforms_from_filename()` in `generate-lifestyle-video.py`). One row per recording in `Media/screen-recordings/LIBRARY.md`. Never overwrite — append date/counter on collision. Read LIBRARY.md before selecting.

---

## 13. VIDEO PIPELINE RULES (summary)

Source of truth: `RENDER_RULES` block in `scripts/generate-lifestyle-video.py` + `RENDER_FEEDBACK_LOG.md`. Read both before touching the renderer.

- Never resize aspect ratios; portrait→vertical, landscape→square.
- Never letterbox/black-bar; scale-to-fill + top-anchor crop.
- `morning_brief`: 3-layer audio (narrator→sample brief→close), ~44s. All others: continuous narrator.
- Duration 30-60s (validator aborts outside).
- Voice from `LIBRARY.md`; never hardcode Bill/Luna.
- Pexels: blocklist sad/stressed/worried/sleeping/down/hunched, min width 1080.
- Screen-rec trim: `max(freeze_end, silence_end)`.

---

## 14. DISTRIBUTION STRATEGY (summary)

Source of truth: `DISTRIBUTION-STRATEGY.md`. Read before any marketing build.

- 4 pillars: **Cost, Control, Visibility, Speed.** Control = strongest for high-volume agents (Brittney).
- URL strategy: `/founding` until 45/50 filled, then `meetdossie.com`. At 50, `/founding` redirects to `/agents`.
- Platforms: FB/Twitter/IG/LinkedIn live; LinkedIn gets Victor's Friday slot via `cron-generate-posts.js` POST_PLAN day-of-week swap. TikTok manual until ~May 20.
- Personas: Brenda/Patricia/Victor, algorithm-optimized per platform.

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

---

## 15.5. INCIDENT REPORTS

Ref: `INCIDENT-2026-05-08.md`. What: Brittney upload bugs, wrong Opus model ID, Media/ binaries committed.

**Prevention:** never commit binaries (use Supabase Storage/CDN). Verify model strings vs current Anthropic docs. Test with real file sizes before customer onboarding.

---

## 15.6. PIPELINE

**Social posting (code = source of truth):**
1. `cron-generate-posts` 11AM UTC — 6 posts via Sonnet 4.6, upsert `on_conflict=post_id`, resets `telegram_sent_at`, renders cards via HCTI (IG+FB), stores `card_body` (50w max) + `caption` separately.
2. `cron-send-for-approval` 11:30 UTC — drafts where `status='draft'` AND `telegram_sent_at IS NULL`. Sends 2 messages to DossieMarketingBot: (1) card image, no buttons; (2) full caption+hashtags with Approve/Reject/Edit.
3. `cron-publish-approved` every 30min — `status='approved'` → Zernio (FB/Twitter/IG/LinkedIn/TikTok). Twitter splits to max 6 chunks paragraph-first. Sets `posted` or `failed`.

---

## 15.7. CONTENT RULES — NON-NEGOTIABLE

**Persona voice:** all content in **third person** — never first-person "I". Brenda=she/her, Patricia=she/her, Victor=he/him. WRONG "I closed 6 deals." RIGHT "She closed 6 deals."

**Field constraints:** `card_body` max 50w (card only); `caption` full text; `stat` max 10 chars ("$8,000","80+"); `stat_label` max 50 chars; `hook` max 8 words, pattern-interrupting.

**Text encoding:** ASCII only — no em-dashes (—), en-dashes (–), curly quotes, special Unicode. Plain hyphens + straight quotes. HCTI + Telegram require this.

---

## 15.8. KNOWN ISSUES / WATCH LIST

- TikTok posts sit as `pending_video` — video pipeline separate (inactive until ~May 20).
- FB hashtags inconsistent — check AI prompt if missing.
- Founding spot count = `subscriptions` where `status='active'` AND `plan='founding'`.
- HCTI free 50/mo — monitor; upgrade $14/mo at 1k.

---

## 16. GOLD TAG HISTORY (recover from these if something breaks)

- `GOLD-2026-05-04-v1-conversion-and-leads`
- `GOLD-2026-05-04-v2-full-pipeline-live`
- `GOLD-2026-05-04-v3-overnight`
- `GOLD-2026-05-05-v1-distribution-checklist-complete`
- `GOLD-2026-05-05-v2-distribution-complete`
- `GOLD-2026-05-05-v3-closing-cards-live`
- `GOLD-2026-05-06-v1-customer-2-brittney-live`
- `GOLD-2026-05-06-v2-pipeline-stable`
- `GOLD-2026-05-06-v3-share-button-live`
- `GOLD-2026-05-06-v4-demo-accounts-locked`
- `GOLD-2026-05-06-v5-all-platforms-live`
- `GOLD-2026-05-06-v5-pipeline-complete`
- `GOLD-2026-05-07-v5-card-redesign`
- `GOLD-2026-05-07-v6-routing-fixed`
- `GOLD-2026-05-07-v7-mcp-published`
- `GOLD-2026-05-07-v8-mcp-http-live`
- `GOLD-2026-05-07-v8-smithery-live`
- `GOLD-2026-05-08-v9-deployment-fixed`
- `GOLD-2026-05-08-v10-creatomate-live`
- `GOLD-2026-05-09-v3-canvas-renderer-postable`
- `GOLD-2026-05-10-v4-card-renderer-postable`
- `GOLD-2026-05-10-v6-hcti-renderer-live`
- `GOLD-2026-05-10-v7-pipeline-complete`
- `GOLD-2026-05-11-v2-first-autonomous-posts`
- `GOLD-2026-05-11-v3-pipeline-live-social-posting`
- `GOLD-2026-05-28-v1-lisa-nilsson-stripe-webhook-whisper`
- `GOLD-2026-05-28-v2-dashboard-insurance-crons`
- `GOLD-2026-05-28-v3-dashboard-improvements`
- `GOLD-2026-05-28-v4-dashboard-30-improvements`
- `GOLD-2026-05-28-v5-agent-voice-chat`
- `GOLD-2026-05-28-v7-esign-live`
- `GOLD-2026-05-28-v8-form-library-live`
- `GOLD-2026-05-28-v9-desktop-document-buttons-inline`
- `GOLD-2026-05-28-v10-form-packages-live`
- `GOLD-2026-05-28-v12-fill-and-sign-phase1`

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

## 18. SOCIAL MEDIA ACCOUNTS

| Platform | Handle | Zernio status |
|---|---|---|
| Facebook Page | MeetDossie | ✅ connected |
| Instagram | @meetdossie | ✅ connected |
| Twitter / X | @meetdossie | ✅ connected |
| TikTok | @meetdossietc | ✅ connected ✅ active (live since 2026-05-08) |
| Threads | @meetdossie | not automated |
| LinkedIn | linkedin.com/company/meetdossie | ✅ connected ✅ active (live since 2026-05-07) |

---

## 19. KEY ENV VAR NAMES (values in Vercel only — never paste values here)

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

## 22. ZERNIO ACCOUNT IDs

| Platform | Account ID | Active |
|---|---|---|
| facebook | `69f253c3985e734bf3d8f9bc` | ✅ |
| instagram | `69f25431985e734bf3d8fcbe` | ✅ |
| twitter | `69f255c6985e734bf3d90ba1` | ✅ |
| linkedin | `69fccd7392b3d8e85f8f12be` | ✅ (URN `urn:li:organization:115997183`) |
| tiktok | `69f15791985e734bf3d13b89` | ✅ |

---

## 23. CONTENT CALENDAR STRUCTURE

- 25 rows (5 weeks × 5 days). Wk1 feature-demo, Wk2 pain-point, Wk3 founder-leaning, Wk4 founder-story, Wk5 control-freak agent (Brittney).
- Personas: brenda (9), patricia (6), victor (10). Voiceover scripts 408–565 chars.
- **Timeframe:** never "a few months ago" — use "recently" / "over the last few weeks".
- **Social proof:** no unverified stats; numbers framed as hypotheticals.
- **Hashtags:** IG 8-10, FB 0, Twitter 2-3, LinkedIn 3-5.

---

## 23.5. VIDEO CONTENT RULES (voiceover scripts)

- **Opening:** specific pain point, not generic. WRONG "Managing transactions is hard." RIGHT "Your TC calls you at 8AM asking which title company to use."
- **Tone:** conversational, not corporate. **Rhythm:** short punchy sentences at end build momentum.
- **Persona voice:** Victor = authoritative volume (confident/direct). Brenda = emotional relatable (warm/empathetic). Patricia = practical part-time (efficient/time-focused).
- **Inflection:** no rising endings. Period-heavy short closes.
- **Duration:** 35-45s at natural pace.
- **Closing:** end with "This is Dossie." then CTA "Texas agents — meetdossie.com slash founding."

---

## 24. POSTING SCHEDULE (caps enforced in `posting_schedule` DB table; TikTok posts park as `pending_video` until DONE pipeline attaches a video)

| Platform | Slots (CST) | Cap |
|---|---|---|
| Facebook | 9AM, 6PM | 2/day |
| Twitter | 8AM, 12PM, 4PM | 3/day |
| Instagram | 8AM, 6PM | 1/day |
| LinkedIn | 7AM, 12PM | 1/day |
| TikTok | 7AM, 7PM | 1/day (ACTIVE - video required via DONE pipeline) |

**Daily generation target: 8 posts** (2 Facebook, 3 Twitter, 1 Instagram, 1 LinkedIn, 1 TikTok)

---

## 25. FOUNDING APPLICATION FLOW

1. Apply at `/founding` (7-field form w/ `heard_from`).
2. DossieMarketingBot → Heath's Telegram (Approve/Reject buttons).
3. Approve → Stripe checkout + Resend approval email from `heath@meetdossie.com`.
4. Pay → Stripe webhook → `subscriptions`+`profiles` rows.
5. Scarcity banner auto-updates from `subscriptions`.

---

## 26. HEATH'S BACKGROUND

- TX REALTOR at KW City View / KW Boerne, San Antonio. `heath.shepard@kw.com` / `heath@meetdossie.com`.
- Goal: location-independent (Hawaii long-term). Also runs Plane & Ember (cigar woodwork, SA).
- Speed > perfection. Voice-transcription user (interpret prompts charitably). Direct style; low hedge tolerance.

---

## 27. CLAUDE CODE LAUNCH COMMANDS (save as `.bat` files on Desktop)

```bat
:: MeetDossie
cd "C:\Users\Heath Shepard\Desktop\MeetDossie" && claude --continue --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions

:: Dossie
cd "C:\Users\Heath Shepard\Desktop\Dossie" && claude --continue --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions
```

`--continue` resumes most recent session per cwd. **Caveat:** model swap (Opus ↔ Sonnet ↔ Haiku) starts fresh session — "save state to memory" before swap.

---

## 28. WORKFLOW — HEATH ↔ CLAUDE CODE

Claude.ai Sonnet = strategy/prompts. Claude Code Opus = execution. Heath pastes large complete prompts (minimize back-and-forth). Reports back via Telegram. Restart daily — CLAUDE.md = full context. Keep sessions short/focused.

---

## 29. CONTENT ENGINE DAILY WORKFLOW

1. 9AM CST weekdays: Claudy sends daily brief (platform/hook/script/demo account/filename) to Telegram.
2. Heath records ~10min, saves to `Media\screen-recordings\` with exact filename.
3. Heath replies **DONE** to Claudy.
4. Claude Code runs `generate-creatomate-video.py`: upload to Supabase Storage → Creatomate template `791117d0-665c-4cd0-ba5f-a767f8921f9b` (voiceover/URL/persona/caption) → poll → URL.
5. Video → DossieMarketingBot for approval → social posts.

Separately: DossieMarketingBot sends draft social posts all day for Approve/Reject.

---

## 30. MEDIA FOLDER STRUCTURE

```
MeetDossie\Media\
├── screen-recordings\   (+ LIBRARY.md — always read before touching recordings)
├── finished-videos\
├── voiceovers\
├── b-roll\[topic]\
├── instagram-cards\
├── music\
└── screen-shots\
```

---

## 31. STRIPE DETAILS

- Founding price: `price_1TPxxNL920SKTEEiN7Gphq8T` ($29/mo).
- `FOUNDING` coupon does NOT exist in Stripe — causes errors if referenced. Approval flow uses `noCoupon`.
- Checkout sessions expire 24h (known bug). **Fix:** permanent Stripe Payment Link → `STRIPE_FOUNDING_PAYMENT_LINK` env var.

---

## 32. IMPROVMX EMAIL SETUP

- `heath@`, `heathshepard@`, `info@meetdossie.com` → all forward to `heath.shepard@gmail.com` (not KW). Free plan.
- API key in Windows Credential Manager as `ImprovMX_API_Key` (rotate — went through Telegram 2026-05-24).

---

## 33. KNOWN TECH DEBT (address before 50 customers)

1. `dossier_milestones` storing `canvas_data_url` in DB → migrate to Supabase Storage.
2. Stripe checkout sessions expire 24h → create permanent Payment Links.
3. Zernio `zernio_post_id` not captured (response shape mismatch).
4. Lifestyle video Zernio post creation not fully wired (upload works, post creation pending).
5. MCP server not published to npm or registries.

---

## 34. CODEBASE RULES

See Section 17 (merged).

---

## 35. BRITTNEY CONTEXT (customer #2 — most important early customer)

- Found via FB search "transaction coordinating in Texas". Broker, 80 tx/yr, Southeast Texas, buyer+seller sides.
- Pain: control freak who can't trust delegation → became the **Control** marketing pillar.
- Quote: *"the lack of systems I have in place isn't sustainable."*
- Team-tier upsell at 60-90d ($149/mo for her agents). Ask for 1-sentence testimonial at 30d.
- Her insight = Week-5 `control_freak_agent` content calendar entries.
