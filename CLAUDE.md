# MeetDossie — Claude Code Operating Manual

This file is read at the start of every Claude Code session. It completely replaces re-briefing — assume nothing, look here first.

---

## 1. WHAT DOSSIE IS

**Tagline:** Your deals. Her job.
**Audience:** Texas REALTORS (San Antonio launch, statewide expansion).
**Name origin:** "dossier — a complete file on everything."

**Two-door positioning:**
- Door A — agents who want to **replace a transaction coordinator** ($400/file → $29-49/mo).
- Door B — TCs who want to **scale their book** without hiring (manage 3x the files solo).

**Architecture:** vertical-agnostic AI core + Texas-TREC config layer. The same engine maps to other states by swapping the config (escrow rules, deadline math, form citations). That's the acquisition story: 3-10× ARR multiple from Zillow/Lone Wolf/CoStar once the Texas product is proven.

**Dossie is always "she/her."** Warm, capable, never corporate.

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
| Social posting | Zernio | $12/mo, 4 accounts, unlimited posts |
| Card renderer | htmlcsstoimage.com (HCTI) | Replaced canvas entirely. `HCTI_USER_ID` + `HCTI_API_KEY` in Vercel env vars. Free plan: 50 renders/month. Upgrade to $14/mo at 1,000 renders when volume requires. |
| Voice TTS | ElevenLabs | Bill (`pqHfZKP75CvOlQylNhV4`) + Luna (`lxYfHSkYm1EzQzGhdbfc`) |
| Stock video | Pexels API | portrait for vertical, landscape for square |
| Video assembly | Creatomate | Template ID `791117d0-665c-4cd0-ba5f-a767f8921f9b`. Fields: `Image-K8V` (screen recording URL), `Persona-Name`, `Caption`, `Voiceover` (ElevenLabs Bill voice pre-configured). |
| Telegram | Two bots | **Claudy** (`TELEGRAM_BOT_TOKEN`) for personal + DONE handler. **DossieMarketingBot** (`TELEGRAM_MARKETING_BOT_TOKEN`) for social-post approve/reject callbacks. |

**Repo layout — TWO repos:**
- `C:\Users\Heath Shepard\Desktop\Dossie` — React source. Build here.
- `C:\Users\Heath Shepard\Desktop\MeetDossie` — Vercel deploy. Push here. Cron functions, API routes, scripts, Media live here.

---

## 3. DEPLOY WORKFLOW — STAGING FIRST, THEN PRODUCTION

**CRITICAL:** All development happens on `staging` branch first. Only merge to `main` after testing confirms it works.

**Staging URL:** https://meet-dossie-nc8tcpjt5-heathshepard-6590s-projects.vercel.app
**Production URL:** https://meetdossie.com

### Standard workflow (staging → production):

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

**Fonts:**
- Cormorant Garamond — headings, brand moments, social card hooks
- System sans-serif — body copy, UI

**Voice:** warm, feminine, capable, never corporate.
**Logo:** Dossie "D" in a blush circle. Files at `Media/dossie-logo-d.{png,svg}` and `Media/dossie-logo-horizontal.png`.

---

## 5. PRICING — LOCKED. AUTHORITATIVE. NEVER CHANGE WITHOUT EXPLICIT INSTRUCTION FROM HEATH.

| Tier | Monthly | Annual |
|---|---|---|
| Solo | $49 | $39 |
| Team | $149 (3 seats; max 8 at $25/seat) | $119 |
| Brokerage | custom | custom |
| **Founding Member** | **$29** (50 spots, 2 taken) | — |

**Add-ons:**
- Reply Monitoring — $10/mo
- AI Autopilot — $15/mo
- Compliance Vault — $10/mo
- White Label — $200-500/mo
- Scans — 5 free, then $1.50 each
- E-sig — 10 free, then $0.50 each
- Onboarding — $99 one-time

**PRICING ROADMAP (do not implement until 25 founding members):**
- Solo price increases from $49/mo to $69/mo after founding spots fill
- Founding members locked at $29/mo forever — non-negotiable
- Team stays at $149/mo
- Rationale: market research shows DealDock ($79), ListedKit ($49+), Done Deal (unpublished) all charge more for less Texas-specific value. Dossie is underpriced at $49 for solo.

---

## 6. CURRENT CUSTOMERS

| # | Name | Email | Plan | Notes |
|---|---|---|---|---|
| 1 | Suzanne Page | k.suzanne.page@gmail.com | $1/mo founding friend (`FOUNDING_FRIEND` coupon) | — |
| 2 | Brittney YBarbo | brittney@setxrealty.com | $29/mo founding member | Broker, 80 tx/yr, Southeast Texas. Found via Facebook search "transaction coordinating in Texas". Control-freak who can't trust delegation — generated the Week-5 `control_freak_agent` content angle. Potential Team-tier upsell at 60-90d. **Ask for one-sentence testimonial at 30-day mark.** |

---

## 7. WHAT'S BUILT AND WORKING

**App:**
- Full React app at `meetdossie.com/app` and `meetdossie.com/workspace`
- Supabase auth, profiles, transactions, documents, action_items, email_queue tables
- Morning Brief — daily audio + text deal summary via ElevenLabs Luna voice
- Talk to Dossie — voice/text contract filling and deal updates
- TREC deadline auto-calculation (cited to paragraph)
- Pipeline dashboard with deal cards and deadline badges
- Closing milestone cards (shareable, privacy-safe, stored in `dossier_milestones`)
- Milestones section in dossier detail view (trophy badge on pipeline cards)
- Share Dossie button — sidebar (desktop) + mobile bottom nav, tracks in `share_events`
- Anchor nav in dossier detail view
- Natural language deadlines throughout ("Option period expires in 2 days")
- Settings data flow fixed (`profiles` table is source of truth)

**Conversion + leads:**
- Founding application flow (7-field form including `heard_from` → Telegram approval buttons → Stripe checkout → Resend approval email)
- Stripe checkout for founding members (`price_1TPxxNL920SKTEEiN7Gphq8T`)
- Scarcity banner — live founding count from `subscriptions` table

**Distribution:**
- Zernio social posting pipeline: Facebook ✅ Twitter ✅ Instagram ✅ LinkedIn ✅
- Twitter thread-split (max 6 chunks, paragraph-first; see `splitForTwitter` in `api/cron-publish-approved.js`)
- Instagram + Facebook image card renderer (Python Pillow, `scripts/render-card.py` generates cards locally, uploads to Storage)
- Daily content briefs via Claudy at 9AM CST weekdays
- Content calendar (25 entries, 5 weeks, 3 personas: brenda/patricia/victor)
- Lifestyle video pipeline (Pexels + ElevenLabs + ffmpeg + Zernio upload)
- TREC deadline calculator at `meetdossie.com/calculator` (email capture → Supabase `calculator_signups`)
- 10 SEO guide pages at `meetdossie.com/guides/`
- 5 AEO answer pages at `meetdossie.com/answers/`
- MCP server published to npm (`@dossie/mcp-server`) + HTTP endpoint at `meetdossie.com/api/mcp`

---

## 8. NOT DONE / ACTIVE BLOCKERS

- Brokerage compliance document sending (specced, not built — high value)
- Stripe Payment Links (permanent, non-expiring) — current checkout sessions expire 24h
- MCP server registry submissions: MCPT / OpenTools (Smithery ✅ live)
- TikTok automation (manual only until ~May 20, 2026)
- Zernio analytics feedback loop (`post_analytics` table specced, not built)
- Brevo email nurture sequence (segmented agent vs TC)
- Lifestyle video Zernio video-post creation (upload works `put_status=200`; post creation `--auto-post` opt-in only)

---

## 9. NEXT PRIORITIES (in order)

1. MCP server registry submissions (Smithery ✅ live; MCPT + OpenTools pending)
2. Brevo email nurture (agent vs TC segmented)
3. Zernio analytics feedback loop
4. Lifestyle video Zernio post creation (upload works; post creation pending)
5. TikTok automation gate flip (~May 20, 2026)

(Completed 2026-05-07: Stripe Payment Links live, brokerage compliance send live, LinkedIn page connected to Zernio, first-time onboarding checklist live, MCP server published to npm + HTTP endpoint deployed.)

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
<topic-slug>-mobile-<YYYY-MM-DD>.mp4   → portrait → instagram, tiktok
<topic-slug>-desktop-<YYYY-MM-DD>.mp4  → landscape → facebook, twitter, linkedin
```

The form-factor segment (`mobile` / `desktop`) is the single source of truth for platform routing. `derive_aspect_and_platforms_from_filename()` in `scripts/generate-lifestyle-video.py` reads it.

- Add ONE row to `Media/screen-recordings/LIBRARY.md` per recording.
- Never overwrite an existing recording — append date or counter if the filename collides.
- Always read `LIBRARY.md` before touching screen-recording selection.

---

## 13. VIDEO PIPELINE RULES (summary)

Full rules + reasoning live in the `RENDER_RULES` block at the top of `scripts/generate-lifestyle-video.py` and in `RENDER_FEEDBACK_LOG.md`. Always read both before touching the renderer.

Highlights:
- Never resize aspect ratios. Portrait sources for vertical output, landscape for square/horizontal.
- Never letterbox b-roll, never add black bars. Use scale-to-fill + top-anchor crop.
- `morning_brief` topic uses a 3-layer audio structure: narrator → Dossie sample brief → closing line.
- All other topics: continuous narrator throughout.
- Fixed ~44s timing target for `morning_brief`.
- Min 30s, max 60s for all videos (validation aborts the render outside this range).
- Voice follows `LIBRARY.md` Voice column — never hardcode Bill or Luna.
- Pexels keyword blocklist: sad, stressed, worried, sleeping, down, hunched.
- Pexels min width 1080.
- Screen-recording trim takes `max(freeze_end, silence_end)` (catches both video freezes AND audio silence at start).

---

## 14. DISTRIBUTION STRATEGY (summary)

Full strategy in `DISTRIBUTION-STRATEGY.md`. Always read before building anything marketing-related.

Highlights:
- 4 value pillars: **Cost, Control, Visibility, Speed.**
- **Control** is the strongest pillar for high-volume agents (Brittney insight).
- URL strategy: `meetdossie.com/founding` until 45 of 50 spots filled, then transition to `meetdossie.com`. At 50 spots, `/founding` redirects to `/agents`.
- Platforms: Facebook ✅ Twitter ✅ Instagram ✅ LinkedIn ✅ (Victor's voice routes here on Fridays via cron-generate-posts.js POST_PLAN day-of-week swap) TikTok (manual until ~May 20).
- Content engine: Brenda / Patricia / Victor personas, algorithm-optimized per platform.

---

## 15. SECURITY RULES — NON-NEGOTIABLE

1. **NEVER hardcode auth tokens, API keys, or secrets in source code.**
2. **NEVER use the "one-shot bypass token" pattern** — git history is permanent and public.
3. All secrets live in Vercel env vars only.
4. If a cron needs manual triggering, use `CRON_SECRET` from `.env.local` via curl locally.
5. If `CRON_SECRET` isn't available locally, **ask Heath to run the curl** — never embed a bypass.
6. GitGuardian monitors the repo. Violations are detected immediately.

**Why these are non-negotiable:**
`heathshepard/MeetDossie` is a **public** GitHub repo. A bearer-token bypass committed on 2026-05-06 (commit `f3700b2`) was reverted ~79 seconds later but lived in public history until scrubbed via `git filter-repo`. The pattern was repeated 3+ times in one day before this rule was written down. Even when reverted, hardcoded secrets remain visible in `git show <commit>` forever unless history is rewritten — and every rewrite is a destructive force-push that risks losing collaborator work.

**Approved patterns when manual trigger is needed:**
- Run locally with the real secret: `curl -H "Authorization: Bearer $CRON_SECRET" https://meetdossie.com/api/cron-publish-approved` (value comes from `.env.local`).
- Ask Heath to fire it: paste a one-liner in Telegram, Heath runs it.
- Add a debug param Heath passes manually (e.g. `?force=1`) gated behind the existing `Bearer $CRON_SECRET`.

**Forbidden patterns:**
- `const ONE_SHOT_TOKEN = 'Bearer <hex>';` paired with a fallback `if (auth !== ONE_SHOT_TOKEN)`.
- Any literal API key, JWT, or bearer string in `.js`, `.py`, `.json`, `.html`, or any tracked file.
- "I'll commit this and revert it next commit" — reverts do not undo public exposure.

**Current status:**
- `CRON_SECRET` is now set in Vercel env vars and required for all cron endpoints.
- `SUPABASE_SERVICE_ROLE_KEY` rotated on 2026-05-10.
- Never paste secrets in any chat — Telegram or Claude.ai.

---

## 15.5. INCIDENT REPORTS

**Reference:** `INCIDENT-2026-05-08.md` (night)

**What happened:**
- Brittney upload bugs during onboarding
- Opus model ID wrong (causing API errors)
- Media/ folder with binary files accidentally committed to repo

**Prevention:**
- Never commit binary files (images, videos, audio) to git — use Supabase Storage or external CDN
- Always verify model strings against current Anthropic API docs before deployment
- Always test with real file sizes before customer onboarding (don't assume small test files = production)

---

## 15.6. PIPELINE

**Social media posting pipeline:**

1. **cron-generate-posts** (runs daily 11AM UTC / 6AM CST)
   - Generates 6 social posts via Claude Sonnet 4.6
   - Upsert with `on_conflict=post_id` — prevents duplicate key errors
   - Resets `telegram_sent_at` to null on upsert — allows re-queuing if regenerated
   - Renders cards via HCTI API (Instagram + Facebook only)
   - Stores `card_body` (max 50 words, for card) + `caption` (full post text) separately

2. **cron-send-for-approval** (runs 11:30 UTC / 6:30AM CST)
   - Queries drafts where `status='draft'` AND `telegram_sent_at IS NULL`
   - Sends TWO messages per post to DossieMarketingBot:
     - Message 1: Card image (photo) with short caption (hook + stat), NO buttons
     - Message 2: Full caption text + hashtags + algorithm rules WITH Approve/Reject/Edit buttons
   - Buttons on second message (full content), not first — makes it clear what you're approving

3. **cron-publish-approved** (runs every 30 min)
   - Queries posts where `status='approved'`
   - Posts to Zernio for all active platforms (Facebook, Twitter, Instagram, LinkedIn, TikTok)
   - Twitter threads: splits long posts into max 6 chunks, paragraph-first
   - Sets `status='posted'` on success, `status='failed'` on error

---

## 15.7. CONTENT RULES — NON-NEGOTIABLE

**Persona voice:**
- All persona content written in **third person** — never first person "I"
- Personas are fictional Texas agents illustrating real pain points
- Brenda = she/her, Patricia = she/her, Victor = he/him
- Examples:
  - WRONG: "I closed 6 deals this month."
  - RIGHT: "She closed 6 deals this month."

**Field constraints:**
- `card_body`: max 50 words, punchy, for image card only
- `caption`: full post text for social media publishing
- `stat`: max 10 characters (e.g., "$8,000", "80+", "6 files")
- `stat_label`: max 50 characters (e.g., "per year for a solo TC")
- `hook`: max 8 words, pattern-interrupting (e.g., "$8,000 a year. For email follow-ups.")

**Text encoding:**
- No em-dashes (—), en-dashes (–), curly quotes (" " ' '), or special Unicode
- Plain hyphens (-) and straight quotes (' ") only
- HCTI renderer and Telegram both require ASCII-compatible text

---

## 15.8. KNOWN ISSUES / WATCH LIST

- TikTok posts sit as `pending_video` — video pipeline separate from image posts (inactive until ~May 20, 2026)
- Facebook hashtags not generating consistently — check AI prompt if posts have no hashtags
- Founding spot count pulls from `subscriptions` table where `status='active'` AND `plan='founding'` only
- HCTI free plan: 50 renders/month — monitor usage, upgrade to $14/mo at 1,000 renders when volume requires

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

---

## 17. HOW TO WORK WITH THIS CODEBASE

- **Two repos:** always build in `Dossie`, always deploy from `MeetDossie`.
- Prefer **clean rebuilds** over iterative patches when a component is fundamentally broken. Flag immediately when a clean rebuild is warranted.
- Always read `DISTRIBUTION-STRATEGY.md` before any marketing build.
- Always read `Media/screen-recordings/LIBRARY.md` before touching screen-recording selection.
- Always read `RENDER_FEEDBACK_LOG.md` before rendering any video.
- **Video pipeline:** Creatomate template `791117d0-665c-4cd0-ba5f-a767f8921f9b` handles all video assembly. Script: `generate-creatomate-video.py`.
- Git tag every stable milestone: `GOLD-[YYYY-MM-DD]-v[N]-[description]`.
- Never commit secrets to GitHub.
- Test in production (Vercel) — local env vars are mostly empty by design.
- Two-chat workflow: Heath uses Claude.ai Sonnet for strategy, Claude Code Opus for execution.
- Keep Claude Code sessions short and focused — restart daily using this CLAUDE.md for context.
- **Never present a partial build as complete** — always verify with a live URL or actual output.
- **Never guess at API response shapes** — always probe first and show actual responses.

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
| `social_posts` | Content engine posts (status: draft / approved / publishing / posted / failed / pending_video / rejected) |
| `content_calendar` | 25 entries, 5 weeks, 3 personas, all tagged with `persona` column |
| `posting_schedule` | Per-platform time slots and daily caps |
| `founding_applications` | Founding member applications with `heard_from` field |
| `subscriptions` | Active paying customers |
| `waitlist` | Email captures from homepage |
| `calculator_signups` | TREC calculator email captures (source='calculator') |
| `dossier_milestones` | Closing cards. **TECH DEBT: stores `canvas_data_url` in DB; migrate to Storage before 50 customers.** |
| `share_events` | Share button tracking (method: copy / facebook / sms) |
| `post_analytics` | Planned Zernio engagement data (not built yet) |

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

- 25 rows (weeks 1-5, days 1-5)
- Week 1 — feature demo angle
- Week 2 — pain-point angle
- Week 3 — founder-leaning angle
- Week 4 — founder story angle
- Week 5 — control-freak agent angle (newest, from Brittney insight)
- Personas: brenda (9 rows), patricia (6 rows), victor (10 rows)
- All voiceover scripts 408–565 chars
- **Timeframe rule:** never say "a few months ago" — use "recently" or "over the last few weeks".
- **Social proof rule:** no unverified stats; all numbers framed as hypotheticals.
- **Hashtag rule:** Instagram: 8-10 hashtags per post, Facebook: none, Twitter: 2-3 hashtags, LinkedIn: 3-5 professional hashtags. Applied to every post.

---

## 23.5. VIDEO CONTENT RULES

When creating voiceover scripts for lifestyle videos:

- **Opening:** Must start with a specific pain point, not a generic statement. Wrong: "Managing transactions is hard." Right: "Your TC calls you at 8AM asking which title company to use."
- **Tone:** Conversational, not corporate. Speak like a real agent, not a press release.
- **Rhythm:** Every script must have rhythm — short punchy sentences at the end build momentum and authority.
- **Persona voice:**
  - **Victor** = authoritative volume agent (confident, direct, no-nonsense)
  - **Brenda** = emotional relatable agent (warm, empathetic, "I've been there")
  - **Patricia** = practical part-time agent (efficient, time-focused, pragmatic)
- **Inflection:** No rising inflection endings. Use period-heavy short sentences to close definitively.
- **Duration:** Scripts should be 35-45 seconds when spoken at natural pace.
- **Closing:** Always end with "This is Dossie." before the CTA ("Texas agents — meetdossie.com slash founding").

**Example closing structure (Victor):**
"The pipeline view is the file. The file is the work. The work is the deal. Every file. Every deadline. Every follow-up. Handled. This is Dossie. Texas agents — meetdossie.com slash founding."

---

## 24. POSTING SCHEDULE (caps enforced in `cron-publish-approved.js`)

| Platform | Slots (CST) | Cap |
|---|---|---|
| Facebook | 9AM, 12PM, 6PM | 1/day |
| Twitter | 8AM, 12PM, 4PM | 2/day |
| Instagram | 8AM, 6PM | 1/day |
| TikTok | 7AM, 7PM | 1/day (inactive) |

---

## 25. FOUNDING APPLICATION FLOW

1. Agent applies at `meetdossie.com/founding` (7-field form including `heard_from`).
2. Heath gets a Telegram notification via DossieMarketingBot with Approve / Reject buttons.
3. Tap **Approve** → Stripe checkout session generated → approval email sent via Resend from `heath@meetdossie.com`.
4. Applicant pays → Stripe webhook fires → `subscriptions` + `profiles` rows created.
5. Scarcity banner on homepage updates automatically from `subscriptions` count.

---

## 26. HEATH'S BACKGROUND

- Licensed Texas REALTOR at Keller Williams City View / KW Boerne, San Antonio.
- `heath.shepard@kw.com` / `heath@meetdossie.com`.
- Building toward location-independent income (Hawaii long-term goal).
- Also runs Plane & Ember (cigar woodwork business in San Antonio).
- Prefers speed-to-market over perfection.
- Voice transcription user — prompts may have transcription errors. Interpret charitably.
- Direct communication style. Low tolerance for hedging or unnecessary explanation.

---

## 27. CLAUDE CODE LAUNCH COMMANDS (save as `.bat` files on Desktop)

```bat
:: MeetDossie
cd "C:\Users\Heath Shepard\Desktop\MeetDossie" && claude --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions

:: Dossie
cd "C:\Users\Heath Shepard\Desktop\Dossie" && claude --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions
```

---

## 28. WORKFLOW — HOW HEATH AND CLAUDE CODE WORK TOGETHER

- Heath uses **Claude.ai (Sonnet)** for strategy, decisions, and writing prompts.
- **Claude Code (Opus)** executes builds — receives prompts via terminal or Telegram.
- Heath pastes large complete prompts — minimize back-and-forth to control costs.
- Claude Code reports back via Telegram to Heath's phone.
- Restart Claude Code daily — this CLAUDE.md provides instant full context.
- Long sessions = expensive — keep sessions short and focused.

---

## 29. CONTENT ENGINE DAILY WORKFLOW

1. **9AM CST weekdays:** Claudy sends the daily content brief to Heath's Telegram. Brief includes platform, hook, voiceover script, demo account to use, filename to save as.
2. Heath records his screen (~10 min) and saves to `Media\screen-recordings\` with the exact filename specified.
3. Heath replies **DONE** to Claudy in Telegram.
4. Claude Code auto-runs `generate-creatomate-video.py`:
   - Uploads screen recording to Supabase Storage
   - Calls Creatomate API (template `791117d0-665c-4cd0-ba5f-a767f8921f9b`) with voiceover text, screen recording URL, persona name, and caption
   - Polls for render completion
   - Returns video URL for approval flow
5. Video sent to DossieMarketingBot for approval, then posted to social platforms.

Separately: DossieMarketingBot sends draft social posts throughout the day for Approve / Reject.

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

- Founding price ID: `price_1TPxxNL920SKTEEiN7Gphq8T` ($29/mo).
- `FOUNDING` coupon: **does not exist in Stripe** — needs creating; causes errors if referenced. Default approval flow uses `noCoupon` mode.
- Current flow generates a checkout session on approval (**expires 24h — known bug**).
- **Fix needed:** create permanent Stripe Payment Link, store as `STRIPE_FOUNDING_PAYMENT_LINK` in Vercel.

---

## 32. IMPROVMX EMAIL SETUP

- `heath@meetdossie.com` → forwards to `heath.shepard@kw.com`.
- `heathshepard@meetdossie.com` → forwards to `heath.shepard@kw.com`.
- Free plan. KW Exchange spam filter sometimes blocks transactional codes (TikTok issue).

---

## 33. KNOWN TECH DEBT (address before 50 customers)

1. `dossier_milestones` storing `canvas_data_url` in DB → migrate to Supabase Storage.
2. Stripe checkout sessions expire 24h → create permanent Payment Links.
3. Zernio `zernio_post_id` not captured (response shape mismatch).
4. Lifestyle video Zernio post creation not fully wired (upload works, post creation pending).
5. MCP server not published to npm or registries.

---

## 34. CODEBASE RULES

- Read `DISTRIBUTION-STRATEGY.md` before any marketing build.
- Read `RENDER_RULES` in `generate-lifestyle-video.py` before any video build.
- Read `Media/screen-recordings/LIBRARY.md` before any screen-recording selection.
- Read `RENDER_FEEDBACK_LOG.md` before any video render.
- Clean rebuild over patch when a component is fundamentally broken.
- Flag immediately when a clean rebuild is warranted rather than patching.
- Never guess at API response shapes — always probe first and show actual responses.
- Never present a partial build as complete — always verify with a live URL or actual output.

---

## 35. BRITTNEY CONTEXT (customer #2 — most important early customer)

- Found via Facebook search "transaction coordinating in Texas".
- Broker, 80 transactions/year, Southeast Texas, both buyer and seller sides.
- Pain point: control freak who can't trust delegation — this became the **Control** marketing pillar.
- Direct quote: *"the lack of systems I have in place isn't sustainable."*
- Potential Team-tier upsell at 60-90 days ($149/mo for her agents).
- Ask for one-sentence testimonial at 30-day mark.
- Her insight generated the Week-5 `control_freak_agent` content calendar entries.
