-- ============================================================================
-- VIDEO SCHEDULING + ORPHAN ALARM (Atlas, 2026-09-25)
--
-- THE DEFECT THIS CLOSES
-- Heath: "fix our video posting pipeline. We need videos to also be
-- scheduled when they are made." Three finished mp4s existed on disk with no
-- video_library row at all as of 2026-09-25 (dossie_trec_p8_disclosure.mp4,
-- dossie_trec_p22_district_notice.mp4, dossie_12b_v2.mp4 in Downloads) —
-- registration is a step a human/script has to remember to run, and nothing
-- ever alarmed on the ones that got missed. Separately, video_library has no
-- notion of "not yet" — a registered-but-approved video is either invisible
-- to cron-post-videos.js (status='approved', waiting on Heath's Telegram tap)
-- or, once heath_approved, gets posted on whatever cron run picks up the
-- oldest row. There is no way to say "hold this one until Thursday."
--
-- 1. video_library.scheduled_for — a real "don't post before this time" gate.
--    NULL means "no preference", which is the value every pre-existing row
--    gets by default and which keeps api/cron-post-videos.js's current
--    oldest-first behavior EXACTLY as it is today for the whole existing
--    queue (see that file's Step 2 query change in the same PR — it filters
--    scheduled_for IS NULL OR <= now(), so a NULL row is always eligible).
--
-- 2. local_video_orphans — the durable ledger the filesystem-side alarm
--    writes to. outcome_expectations can only count POSTGRES rows, not files
--    on Heath's PC, so scripts/scan-orphan-videos.js (run locally, where the
--    mp4s actually live) is the sensor and this table is what it reports
--    into. A row's first_seen_at is set ONCE, on first sighting, and never
--    touched again by the upsert (see that script) — the outcome monitor's
--    age math depends on that. The row is deleted the moment the file's stem
--    shows up in video_library, which is the self-heal: the very next
--    cron-outcome-monitor pass (every 6h) sees the set shrink and the
--    incident auto-closes. No code path here ever marks a row "resolved" by
--    hand.
--
-- 3. Two outcome_expectations rows — wiring the two alarms above into the
--    EXISTING escalation ladder (api/_lib/outcome-monitor.js,
--    api/cron-outcome-monitor.js, already running every 6h). Per that
--    system's own design, adding a pipeline is an INSERT, not a deploy.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. video_library.scheduled_for
-- ---------------------------------------------------------------------------
alter table public.video_library
  add column if not exists scheduled_for timestamptz;

comment on column public.video_library.scheduled_for is
  'Earliest time api/cron-post-videos.js may post this row. NULL = no preference (posts on the normal oldest-first pass, matching every pre-2026-09-25 row). Set at registration time by the next open posting_schedule slot unless the registering caller passed an explicit time — see api/_lib/video-schedule.js (Node) and assign_next_slot() in scripts/queue-finished-videos.py (Python), the two implementations of the same slot-picking algorithm.';

create index if not exists idx_video_library_scheduled_for
  on public.video_library (scheduled_for)
  where scheduled_for is not null;

-- ---------------------------------------------------------------------------
-- 2. local_video_orphans — filesystem-side sensor ledger
-- ---------------------------------------------------------------------------
create table if not exists public.local_video_orphans (
  id             text primary key,       -- the file's stem, same id video_library would use
  path           text not null,          -- absolute local path, for the human_fix line
  target_owner   text not null default 'dossie',
  first_seen_at  timestamptz not null default now(),
  last_checked_at timestamptz not null default now()
);

comment on table public.local_video_orphans is
  'Written by scripts/scan-orphan-videos.js, run locally (it needs filesystem access Vercel does not have). A row means an .mp4 sat in a watch folder with no matching video_library.id the last time the scanner ran. Deleted by the same scanner the moment the stem is registered — that deletion is the self-heal outcome_expectations.video_orphan_files_stale relies on.';

-- ---------------------------------------------------------------------------
-- 3. Wire both alarms into the existing outcome monitor
-- ---------------------------------------------------------------------------
insert into outcome_expectations (
  key, pipeline, label,
  source_table, source_filters, time_column, window_mode, window_hours, min_count,
  classifiers, remediations, remediation_mode,
  severity, grace_hours, human_only, human_fix, human_fix_minutes, cost_unit,
  enabled, notes
) values (
  'video_scheduled_not_posted',
  'video-posting',
  'Videos whose scheduled_for has passed but which have not posted',
  'video_library',
  '{"status": "not.in.(posted,rejected,retracted,quality_hold)"}'::jsonb,
  'scheduled_for',
  'older_than',
  0,
  0,
  '{}', '{}', 'off',
  'warn', 6, true,
  'Check api/cron-post-videos.js logs and the Zernio dashboard for the row''s id — likely a posting_schedule cap/inactive-day gate or a missing zernio_accounts entry for that platform+owner.',
  10,
  'videos late',
  true,
  'window_hours=0 on an older_than check means "scheduled_for < now" — any non-terminal row whose time has passed at all. grace_hours=6 absorbs the normal daily-cron latency (cron-post-videos.js runs once/day) before this actually escalates.'
)
on conflict (key) do nothing;

insert into outcome_expectations (
  key, pipeline, label,
  source_table, source_filters, time_column, window_mode, window_hours, min_count,
  classifiers, remediations, remediation_mode,
  severity, grace_hours, human_only, human_fix, human_fix_minutes, cost_unit,
  enabled, notes
) values (
  'video_orphan_files_stale',
  'video-posting',
  'Finished .mp4 files sitting in a watch folder with no video_library row',
  'local_video_orphans',
  '{}'::jsonb,
  'first_seen_at',
  'older_than',
  4,
  0,
  '{}', '{}', 'off',
  'warn', 0, true,
  'Run: node scripts/register-local-video.js --video <path from local_video_orphans.path> --topic "..." --caption "..." --platforms tiktok,instagram,facebook. Or find out why scripts/scan-orphan-videos.js / scripts/queue-finished-videos.py did not pick it up automatically.',
  5,
  'videos unregistered',
  true,
  'Requires scripts/scan-orphan-videos.js to actually run periodically on Heath''s PC (Vercel cannot see local disk) — see that script''s header for the Task Scheduler wiring this depends on.'
)
on conflict (key) do nothing;
