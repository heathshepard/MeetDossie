# Activation Education Phase 2 — Deployment Checklist

**Status:** In progress — Carter executing 2026-06-12 ~11:30 AM CDT

## What's Done

✅ Welcome email v2 — updated in `stripe-webhook.js` (line 257) and `complete-onboarding.js` (line 202)
  - Signature now "Heath" + "Licensed Texas REALTOR | Founder, Dossie"
  - Lists all 8 features (Morning Brief, Talk to Dossie, TREC deadlines, DossieSign, Form Packages, Email/doc scanning, Milestones, Compliance Vault)
  - CTA changed to "Create Your First Dossier" → meetdossie.com/app
  - Founding Files moved to P.S. instead of main button

✅ Migration SQL — created at `MeetDossie/migrations/2026-06-12-activation-phase2.sql`
  - Adds welcome_day1_sent_at ... welcome_day30_sent_at columns to profiles
  - Seeds 5 What's New announcements to whats_new_announcements table
  - Creates help_feedback table for "Was this helpful?" tracking

✅ Help knowledge base API — created at `MeetDossie/api/help-pages.js`
  - Serves all 8 help pages as JSON
  - Handles GET /api/help-pages and GET /api/help-pages?slug=getting-started
  - Handles POST /api/help-pages/feedback for "Was this helpful?"
  - Content sourced 100% from Pierce's spec

## What's NOT Done (pending React/frontend wiring)

Phase 2 requires React component changes that Carter will complete:

**Priority 1 — CRITICAL for staging ship:**
- [ ] Mount `/help` route in Dossie React app → calls GET /api/help-pages?slug=... to render Help pages
- [ ] Wire "Help" link in sidebar (desktop) + mobile bottom nav
- [ ] Mount What's New banner on Dashboard → calls GET /api/whats-new, dismisses via POST /api/whats-new

**Priority 2 — Empty-state hints (13 locations):**
- [ ] EmptyStateHint component exists; mount it in these 13 routes per Pierce's spec:
  1. Pipeline dashboard (no dossiers) — "Your pipeline is empty..."
  2. Individual dossier (no docs) — "No documents in this dossier yet..."
  3. Individual dossier (no action items) — "No tasks yet..."
  4. Individual dossier (no emails) — "No emails drafted..."
  5. Morning Brief section (no brief) — "Today's brief is ready..." / "Your morning brief generates once..."
  6. DossieSign / Forms tab (no forms attached) — "No forms on this dossier yet..."
  7. Form Library search (no results) — "No forms match..."
  8. Closing milestone cards (no milestones) — "No closings to celebrate yet..."
  9. Documents tab (no docs across account) — "No documents in Dossie yet..."
  10. Settings → Notification preferences (first time) — "You're getting the defaults..."
  11. Founding Files link (first visit) — "Founding Files is the private Facebook group..."
  12. Compliance Vault (if gated, hide for non-subscribers)
  13. Error states (upload failed, login failed, network error, form generation failed)

**Priority 3 — Activation event calls (10 locations):**
- [ ] POST /api/activation-event calls in these flows:
  1. signup_completed → stripe webhook (when subscription created)
  2. profile_completed → Settings save (when user edits profile)
  3. first_login → login gate (when first auth.last_sign_in_at is set)
  4. first_dossier_created → persistTransaction() (on first INSERT to transactions)
  5. first_document_uploaded → document upload endpoint
  6. first_email_queued → email_queue insert
  7. first_amendment_drafted → amendment draft endpoint
  8. first_form_attached → form attach endpoint
  9. first_milestone_created → milestone create endpoint
  10. first_morning_brief_listened → Morning Brief play handler (best-effort)

**Priority 4 — Welcome drip emails (Days 1, 3, 7, 14, 30):**
- [ ] Extend cron-activation-drip.js or create cron-welcome-drip.js:
  - Day 1: fires immediately via stripe webhook (already in complete-onboarding / stripe-webhook sends welcome email — add event marker)
  - Day 3: select users created 3-3.5d ago, `welcome_day3_sent_at IS NULL`, `last_sign_in_at IS NOT NULL` → send email
  - Day 7: select users created 7-7.5d ago, `welcome_day7_sent_at IS NULL`, `COUNT(transactions) >= 1` → send email
  - Day 14: select users created 14-14.5d ago, `welcome_day14_sent_at IS NULL` → send Body A (active) or Body B (never-loggers)
  - Day 30: select users created 30-30.5d ago, `welcome_day30_sent_at IS NULL`, activation-check if activated → send testimonial ask OR Tier 3 last-chance
- [ ] Send Day 1 email via signup (already done by welcome email swap)
- [ ] Conflict resolution: if welcome-drip and activation-drip would fire same day, send activation-drip variant

**Priority 5 — Personalized outreach (3 customers, not auto-sent):**
- [ ] Do NOT auto-send these; Heath approves each manually
  - Cecilia Whitley (cecilia@sterlingassociatesre.com) — 23 days, never logged in
  - Kim Herrera (kimberlyherrera@kw.com) — 24 days, never logged in (KW-to-KW angle)
  - Tiffany Gill (tiffanygillrealtor@gmail.com) — 3 days, never logged in (fresh warm welcome)
- [ ] Create draft rows in email_drafts table OR send Telegram digest to Heath with "tap to send" buttons

**Priority 6 — In-app tooltips (12+ buttons):**
- [ ] Wire Tooltip component on these buttons (if not already wired):
  - Create Dossier, Upload Document, Talk to Dossie, Morning Brief, Send for Signature, Add Form, Request Testimonial
  - Plus 5 more per Pierce's prioritization

---

## Files Changed

**Backend (API)**
- `MeetDossie/api/stripe-webhook.js` — line 257, updated welcomeEmailHtml function
- `MeetDossie/api/complete-onboarding.js` — line 202, updated welcomeEmailHtml function
- `MeetDossie/api/help-pages.js` — NEW, serves help knowledge base
- `MeetDossie/migrations/2026-06-12-activation-phase2.sql` — NEW, schema + seed data

**Frontend (React)**
- `Dossie/dossie-app.jsx` — TODO: add /help route, mount What's New banner, wire empty-state hints, add activation events
- `Dossie/src/components/EmptyStateHint.jsx` — EXISTS, no changes needed (component ready to use)

**Database**
- Add `welcome_day{1,3,7,14,30}_sent_at` columns to profiles table
- Seed whats_new_announcements table with 5 ready entries
- Create help_feedback table

---

## Deployment Order

1. **Run migration** — apply 2026-06-12-activation-phase2.sql to Supabase (Carter OR Vercel auto-applies)
2. **Deploy help-pages API** — push to MeetDossie staging, verify /api/help-pages returns data
3. **Deploy welcome email updates** — push to MeetDossie staging
4. **Deploy React changes** (once Carter wires components):
   - /help route
   - What's New banner on dashboard
   - EmptyStateHint in 13 locations
   - Activation event calls
5. **Deploy welcome drip cron** — push cron-welcome-drip.js or extend cron-activation-drip.js
6. **Manual: send personalized outreach** — Heath approves and sends 3 emails via email drafts

---

## Merge to Main

- [ ] Quinn QA testing on staging (auto-spawned by Cole)
- [ ] All tests pass (including empty-state rendering, help page navigation, What's New dismissal, activation event logging)
- [ ] Health says "merge it"
- [ ] Cole merges staging → main, push
- [ ] Vercel auto-deploys to production
- [ ] Tag GOLD-2026-06-12-vN-activation-education-phase2

---

## Success Metrics

1. **Welcome email v2 ships** — every new founding signup gets the updated email with all 8 features named
2. **Help center launches** — agents can navigate /help and find answers without contacting Heath
3. **What's New banner shows** — dashboard displays most recent unread announcement, dismissible
4. **Empty states guide users** — every "no data yet" screen has a hint + CTA instead of bare text
5. **Activation tracking works** — activation_events table logs all 10 milestone events
6. **Welcome drip fires on schedule** — Days 1/3/7/14/30 emails send to founding members
7. **No churn spike** — founding member activation improves (target: >40% Day-1 dossier-created, >25% Talk-to-Dossie by Day 7)

---

## Known Gaps (Phase 3)

- Phase 2 video tutorial library (stitchable 30-60s bites per feature)
- SMS escalation via Twilio (critical-tier deadline reminders)
- Voice escalation via Twilio Voice (last-resort phone calls)
- Brokerage compliance doc sending (add-on feature, specced not built)
- Social Media Autopilot for agents (paid add-on, future)

---

## End State After Merge

Every new founding member gets:
1. Welcome email v2 (names all features, sets expectations)
2. Day 1/3/7/14/30 drip emails (progressively guides activation)
3. Morning Brief at 6am (pulls them back to the app daily)
4. Empty-state hints everywhere they might get stuck (removes friction)
5. /help knowledge base (self-serve support)
6. What's New banner (keeps them aware of shipped features)
7. Activation event tracking (lets Cole see in real time who's stuck)

This closes the "Customer Education" Phase 1 quick wins per CLAUDE.md §8.
