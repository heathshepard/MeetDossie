# Carter Build: Merge Queue System

## Overview
Build a visible merge queue panel in Jarvis HUD so Heath can see which staging commits are production-ready (all 5 sign-offs pass) vs. which need work. Removes "trust Carter's word" pattern and makes sign-off progress transparent.

## Checklist

### Phase 1: Schema + APIs ✅
- [x] Create `merge_queue` table (supabase/migrations/20260622_merge_queue.sql)
  - commit_sha (unique), title, description
  - 5 sign-off slots: atlas_apv, quinn_qa, ridge, hadley, sage_demo (each: not_run/pass/fail)
  - all_green computed boolean (all 5 = pass)
  - merged_to_main tracking + merged_at + merged_by_user_id
  - Realtime publication + RLS (service_role only)

- [x] Create /api/merge-queue-add.js
  - POST endpoint called by cron-staging-watcher when new commit detected
  - Idempotent (UNIQUE on commit_sha)
  - Returns: ok, created, id, sha, title, all_green, created_at

- [x] Create /api/merge-queue-update-signoff.js
  - POST endpoint called by sign-off agents (Atlas, Quinn, Ridge, Hadley, Sage)
  - Body: merge_queue_id, signoff_type, status, evidence_url, notes
  - Updates one slot + returns all_green computed value

- [x] Create /api/merge-queue-list.js
  - GET endpoint called by Jarvis HUD to populate panel
  - ?filter=pending (default, merged_to_main=false) | recent (last 10 merged) | all
  - Returns: items array with full signoff status + evidence URLs

- [x] Update /api/merge-to-main.js
  - After fast-forward succeeds, mark merge_queue row as merged_to_main=true, merged_at, merged_by_user_id

- [x] Update /api/cron-staging-watcher.js
  - Add addToMergeQueue() call when new commit detected
  - Call merge-queue-add endpoint before Quinn dispatch
  - Track merge_queue_ok in outcome

### Phase 2: HUD Panel + UI ✅
- [x] Add HTML panel markup (after PENDING APPROVALS)
  - Panel ID: merge-queue-panel
  - Title: "MERGE QUEUE"
  - Badge: count of pending merges
  - List container: merge-queue-list

- [x] Add CSS styles
  - .merge-queue-item, .merge-queue-item.all-green
  - .merge-queue-title, .merge-queue-sha
  - .signoff-badge (not-run / pass / fail states)
  - .merge-btn, .merge-btn.fix-issues (enabled only if all_green)
  - Glassmorphic design consistent with Jarvis V5

- [x] Add JavaScript functions
  - loadMergeQueue() — fetch /api/merge-queue-list?filter=pending
  - renderMergeQueue(items) — render items as cards with sign-off badges
  - mergeStagingToMain(item) — call /api/merge-to-main with confirmation
  - showMergeQueueEvidence(item, type) — tap badge to see evidence
  - showMergeQueueDetails(item) — tap details for full commit info
  - escapeHtml() — XSS safety

- [x] Wire into bootstrap + refresh cadence
  - Load on app init
  - Refresh every 30s (same priority as pending approvals)
  - Realtime subscription (TBD — optional Phase 3)

### Phase 3: Backfill + Automation (Deferred)
- [ ] Script to create merge_queue rows for existing staging commits not on main
- [ ] Auto-spawn sign-off agents (Atlas, Quinn, Ridge, Hadley, Sage) per new commit
- [ ] Realtime subscription to merge_queue table (Supabase Realtime)
- [ ] Modal to view full commit diff / evidence per sign-off

### Testing (APV Manual)
- [ ] Sign in to staging Jarvis PWA
- [ ] Verify MERGE QUEUE panel appears after PENDING APPROVALS
- [ ] Verify count badge updates as commits land
- [ ] Tap a commit card → see all 5 sign-off badges
- [ ] Tap a badge → see evidence / notes
- [ ] For all_green commit, verify MERGE TO MAIN button enabled
- [ ] For partial-green commit, verify MERGE TO MAIN button disabled + shows "FIX FAILURES"
- [ ] Tap MERGE TO MAIN → confirmation modal
- [ ] Confirm merge → calls /api/merge-to-main → row marked merged
- [ ] Verify merged commits drop from pending list

## Files Modified

### New Files
- supabase/migrations/20260622_merge_queue.sql
- api/merge-queue-add.js
- api/merge-queue-update-signoff.js
- api/merge-queue-list.js

### Modified Files
- api/merge-to-main.js (added merge_queue update on successful merge)
- api/cron-staging-watcher.js (added addToMergeQueue call + function)
- jarvis-pwa.html (added panel markup + CSS + JS functions + bootstrap wiring)

## Known Unknowns / Deferred

1. **Realtime subscription:** merge_queue Realtime not yet wired. Currently polling every 30s. Can add subscription listener later if desired.

2. **Sign-off agent spawning:** Currently assumes sign-off agents (Atlas, Quinn, etc.) are spawned manually or via other existing flows. Could auto-spawn in this cron, but deferring to keep scope tight.

3. **Evidence modal:** Badges now show toast on click. Could build a full modal with screenshot/video embeds later.

4. **Backfill of existing staging commits:** 6 commits currently waiting on staging. Could run a one-time script to populate merge_queue for them, but they'd have no sign-off status until agents run.

## Deployment

1. Apply migration: `supabase migration up --db-url <production-url>`
2. Deploy API endpoints (merge-queue-add, merge-queue-update-signoff, merge-queue-list)
3. Deploy updated merge-to-main.js
4. Deploy updated cron-staging-watcher.js
5. Deploy jarvis-pwa.html
6. Test on staging URL before merging to main

## Ready for
- Jarvis to review + test on staging
- Atlas to verify with Playwright signed-in APV
- Quinn to QA the panel rendering + merge flow
- Heath to enable in Jarvis HUD after merge
