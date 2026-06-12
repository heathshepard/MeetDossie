# Activation Infrastructure Build — 2026-06-12

**Status:** STAGING READY (Quinn QA required before merge)
**Staging URL:** https://meet-dossie-pkszjpy10-heathshepard-6590s-projects.vercel.app
**Bundle Hash:** workspace-D5Zips9F

## What shipped

### Database (Supabase)
- activation_events table: 12 milestone types (signup, dossier create, doc upload, etc.)
- help_feedback table: KB article ratings
- whats_new_announcements + whats_new_dismissals tables: banner system
- activation_triage_log table: audit trail for cron actions
- All RLS policies + indexes configured

### Backend APIs
- /api/activation-event.js — POST to log milestones
- /api/activation-status.js — GET user's activation funnel state
- /api/whats-new.js — GET active announcements + POST dismiss
- /api/cron-activation-triage.js — Daily 5 AM CDT triage

### Frontend Components
- EmptyStateHint.jsx — Reusable empty-state education component
- HelpView.jsx — Knowledge base with sidebar nav + article reader
- helpArticles.js — 3 starter articles

## BLOCKERS for merge

1. Activation event wiring: persistTransaction + document upload not emitting yet
2. Pierce specs: welcome-email-v2, help-knowledge-base files not ready
3. Empty-state hints not wired into 7 routes
4. What's New banner not mounted in Dashboard
5. HelpView routing not in app nav
6. Button tooltips (12+) not wired

## Next session

Carter should:
1. Wire activation events into persistTransaction + upload endpoints
2. Consume Pierce specs when ready
3. Mount EmptyStateHint in 7 routes
4. Add What's New banner to Dashboard
5. Wire HelpView into /help route
6. Add button tooltips

All database + API work complete and tested on staging.
