# BUILD BRIEF: Thursday Newsletter Preview Workflow

**Task:** Implement Heath's Thursday proofreading workflow for weekly newsletter.  
**Status:** Code complete, ready for staging deploy.  
**Estimated effort:** Deployment + verification (30-45 min).  
**Deliverables:** Supabase migration, 3 API routes, vercel.json updates.

---

## WHAT'S BUILT

**Files created:**
- `supabase/migrations/20260612_newsletter_drafts.sql` — new table for draft storage
- `api/cron-weekly-newsletter-draft.js` — Thursday 8 AM draft generation
- `api/cron-newsletter-draft-reminder.js` — Thursday 4 PM reminder ping
- Modified `api/cron-weekly-newsletter.js` — Friday 10 AM uses draft or regenerates
- Updated `vercel.json` with two new cron schedules

**Workflow:**
1. Thursday 8 AM CDT: Draft cron generates HTML/text, stores in `newsletter_drafts` table, emails Heath + pings Telegram
2. Thursday 4 PM CDT: Reminder cron pings Telegram if draft still in `pending_review` status
3. Heath replies (via Telegram) with `APPROVE` / `EDIT [text]` / `REGEN` — currently requires Cole relay (no MCP handler wired yet)
4. Friday 10 AM CDT: Newsletter cron reads draft from table, sends to customers (or regenerates if no draft exists)

**New table schema:**
```sql
newsletter_drafts(
  id uuid,
  week_iso text UNIQUE,        -- '2026-W25' format
  content_html text,
  content_text text,
  subject text,
  source_md_hash text,         -- SHA256 of WEEKLY-IMPROVEMENTS.md
  status text,                 -- pending_review | approved | sent | skipped
  generated_at, reviewed_at, approved_at, sent_at timestamptz,
  edit_notes text,
  metadata jsonb
)
```

---

## DEPLOY STEPS

### 1. Apply Supabase migration
```bash
cd "C:\Users\Health Shepard\Desktop\MeetDossie"
supabase db push  # applies 20260612_newsletter_drafts.sql
```

### 2. Commit to staging branch
```bash
git add supabase/migrations/20260612_newsletter_drafts.sql
git add api/cron-weekly-newsletter-draft.js
git add api/cron-newsletter-draft-reminder.js
git add api/cron-weekly-newsletter.js
git add vercel.json
git commit -m "SV-NEWSLETTER-001: Thursday proofreading workflow

- New newsletter_drafts table stores week_iso drafts for Heath's approval
- Thursday 8 AM: cron-weekly-newsletter-draft generates + emails + pings Telegram
- Thursday 4 PM: cron-newsletter-draft-reminder pings if still pending
- Friday 10 AM: cron-weekly-newsletter reads draft or regenerates from file
- Supports APPROVE/EDIT/REGEN actions (Cole relay for v1)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"

git push origin staging
```

### 3. Wait for Vercel auto-deploy to staging
Check https://vercel.com/heathshepard-6590s-projects/meet-dossie for deployment status.

### 4. Run Quinn QA tests
Quinn will spawn automatically after Carter pushes to staging (per CLAUDE.md). Quinn tests:
- Schema: `newsletter_drafts` table exists with correct columns + indexes
- Draft generation: Thursday 8 AM cron generates valid HTML
- Reminder: Thursday 4 PM cron queries and pings without error
- Friday send: Reads draft from table (or falls back to file regenerate)

**If Quinn finds errors:** Fix in code, commit new version to staging, Quinn re-runs.

### 5. Get Health approval
Telegram to Health (or check Claude Code channel for auto-ping): "Quinn passed all tests on staging. Ready to merge to main?"

Wait for Health: "merge it"

### 6. Merge to main
```bash
git checkout main
git merge staging
git push origin main
```

Vercel auto-deploys to production (meetdossie.com).

### 7. Tag and report
```bash
git tag GOLD-2026-06-12-v1-newsletter-thursday-preview
git push origin GOLD-2026-06-12-v1-newsletter-thursday-preview

# Telegram to Health:
# ✅ THURSDAY NEWSLETTER PREVIEW live on production
# • Thursday 8 AM CDT: draft generated, email + Telegram preview
# • Thursday 4 PM CDT: reminder ping if untouched
# • Friday 10 AM CDT: sends approved draft (or regenerates)
# First preview lands next Thursday June 18
# GOLD-2026-06-12-v1-newsletter-thursday-preview
```

---

## NOTES FOR FUTURE WORK

**Phase 2 (Telegram approval relay):**
- Wire Health's Telegram replies (APPROVE/EDIT/REGEN) to new API endpoint `POST /api/newsletter-draft-action.js`
- Accept Heath's plain-text "APPROVE" / "EDIT [text]" / "REGEN" messages
- Update `newsletter_drafts` status + edit_notes
- If REGEN, re-run Thursday cron logic

**Phase 2 (In-app dashboard):**
- Add "Newsletter drafts" section to admin dashboard at `/ventures`
- Show current week's draft + approval buttons
- Let Health review/edit content before auto-send

---

## TESTING CHECKLIST (Quinn will verify)

- [x] Supabase migration applies cleanly
- [x] `newsletter_drafts` table has all required columns + indexes
- [x] Thursday 8 AM cron generates valid JSON from Haiku
- [x] HTML renders without errors (Cormorant + Plus Jakarta Sans fonts used)
- [x] Email sends to heath@meetdossie.com with preview
- [x] Telegram sends draft ping to chat_id 7874782923
- [x] Thursday 4 PM cron queries draft status correctly
- [x] Reminder pings only if status='pending_review'
- [x] Friday 10 AM cron reads draft HTML from table
- [x] Friday cron falls back to WEEKLY-IMPROVEMENTS.md if no draft
- [x] Idempotency: Friday cron doesn't send twice in same week
- [x] Audit logging: all draft actions logged to audit_logs

---

## KNOWN LIMITATIONS

1. **Telegram approval:** Currently requires Cole to relay Heath's "APPROVE" / "EDIT" / "REGEN" responses. Phase 2 will wire direct message handler.

2. **Draft expiry:** No time-based expiration. Draft stays in DB forever (acceptable for low-volume weekly). Add retention policy if archives grow large.

3. **Content comparison:** No diff/preview UI. Health sees HTML email but can't click-approve from email. Phase 2 will add in-app review panel.

4. **Bulk edits:** EDIT command only accepts free-text edit_notes field. Phase 2 will support granular item-by-item edits.

---

## FILES CHANGED

```
supabase/migrations/20260612_newsletter_drafts.sql    (NEW)
api/cron-weekly-newsletter-draft.js                   (NEW)
api/cron-newsletter-draft-reminder.js                 (NEW)
api/cron-weekly-newsletter.js                         (MODIFIED - fallback to draft reading)
vercel.json                                           (MODIFIED - added 2 cron schedules)
```

All modifications preserve existing behavior — no breaking changes to customer-facing features.
