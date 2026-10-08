-- ============================================================================
-- OUTCOME MONITOR (Atlas, 2026-09-25)
--
-- WHY THIS EXISTS
-- Eight pipeline failures in one week, and every single one reported success:
--   1. DossieBot Chrome logged out of LinkedIn + Facebook -> 3 channels dead 9 days
--   2. linkedin-engager Telegram summary fired 96x/day saying "liked 0, commented 0"
--   3. The real "LinkedIn login required" alert was suppressed by its own cooldown
--   4. cron-render-videos: last_status='ok', 168ms, matched 0 rows (selector drift)
--   5. checkZernioDeliveryStatus parsed a shape Zernio never sends -> is_live always false
--   6. ElevenLabs Audio Isolation silently fell back for months (gitignored .env.local)
--   7. Creatomate HTTP 402 since 2026-06-30 -- pipeline dead by design, nothing said so
--   8. batch_routine_approvals on: 7 videos pending, telegram_message_id NULL, never sent
--
-- THE PATTERN, which is the only thing worth designing against:
--   the system monitors whether a job RAN, never whether it ACCOMPLISHED anything.
--
-- So: declare what each pipeline must PRODUCE per period, measure it against the
-- system of record (the rows/artifacts themselves, never a status flag), classify
-- the cause of a shortfall, run a mechanical remediation, re-check, and escalate
-- only what remediation could not fix -- escalating LOUDER over time, never quieter.
--
-- Four tables:
--   outcome_expectations - declarative "what must exist"; thresholds are DATA
--   outcome_checks       - append-only history of every evaluation
--   outcome_incidents    - one open row per (expectation, CAUSE); the escalation ladder
--   credential_health    - per-channel auth freshness, written by the local probe
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. outcome_expectations -- the declarative contract
-- ---------------------------------------------------------------------------
-- A row here says: "in the last <window_hours>, table <source_table> filtered by
-- <source_filters> and dated by <time_column> must contain at least <min_count>
-- rows." The checker turns that into a PostgREST HEAD count. Adding a new
-- pipeline to the monitor is an INSERT, not a deploy.
create table if not exists outcome_expectations (
  key                 text primary key,
  pipeline            text not null,
  label               text not null,

  -- system of record (never a status flag on the job -- the artifacts themselves)
  source_table        text not null,
  source_filters      jsonb not null default '{}'::jsonb,  -- {"status":"eq.posted"}
  time_column         text,                                -- null = no time window
  window_mode         text not null default 'recent'
    check (window_mode in ('recent','older_than')),
  window_hours        integer not null default 24,
  min_count           integer not null default 1,

  -- diagnosis + repair
  classifiers         text[] not null default '{}',        -- api/_lib/outcome-causes.js keys
  remediations        text[] not null default '{}',        -- api/_lib/outcome-remediation.js keys
  remediation_mode    text not null default 'safe'
    check (remediation_mode in ('off','safe','full')),

  -- escalation
  severity            text not null default 'warn'
    check (severity in ('info','warn','critical')),
  grace_hours         integer not null default 0,          -- gap may persist this long silently
  human_only          boolean not null default false,      -- no mechanical fix exists
  human_fix           text,                                -- the EXACT fix: path, URL, what to click
  human_fix_minutes   integer,                             -- for the cost line
  cost_unit           text,                                -- "posts unsent", "videos unshipped"

  enabled             boolean not null default true,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on column outcome_expectations.window_mode is
  'recent = "did enough happen lately" (time_column >= now - window_hours). older_than = "is anything still stuck here" (time_column < now - window_hours). Declared, never inferred — two different questions share this shape and guessing between them silently asks the wrong one.';
comment on column outcome_expectations.min_count is
  'min_count > 0: the set must contain at least this many rows. min_count = 0: INVERTED — the set must be EMPTY (a backlog / must-not-exist assertion).';
comment on column outcome_expectations.source_filters is
  'PostgREST filter map, column -> "op.value". Column names are validated against ^[a-z_][a-z0-9_]*$ and operators against an allowlist in api/_lib/outcome-expectations.js before any query is built.';
comment on column outcome_expectations.remediation_mode is
  'off = detect + escalate only. safe = run only remediations whose side effect is internal state (locks, flags, counters) and can never cause a publish. full = also allow remediations that put a row back in a queue that a publisher drains.';

-- ---------------------------------------------------------------------------
-- 2. outcome_checks -- append-only evaluation history
-- ---------------------------------------------------------------------------
create table if not exists outcome_checks (
  id                  bigserial primary key,
  checked_at          timestamptz not null default now(),
  expectation_key     text not null,
  expected            integer not null,
  actual              integer not null,
  status              text not null
    check (status in ('met','gap','error','skipped','remediated')),
  cause               text,
  cause_detail        jsonb,
  remediation         jsonb,
  escalated           boolean not null default false,
  duration_ms         integer
);
create index if not exists idx_outcome_checks_key_time
  on outcome_checks(expectation_key, checked_at desc);

-- ---------------------------------------------------------------------------
-- 3. outcome_incidents -- the escalation ladder with teeth
-- ---------------------------------------------------------------------------
-- THE COOLDOWN INVERSION FIX. The old alert_state pattern is one row per
-- condition key with a flat 20h cooldown, which produced the exact failure #3:
-- the useless "liked 0, commented 0" summary went out 96x/day while the REAL
-- "LinkedIn login required" alert was suppressed by its own cooldown.
--
-- Two structural rules encoded here:
--   a) The open-incident unique index is on (expectation_key, CAUSE). A NEW
--      cause on the same expectation cannot join an existing incident -- it
--      opens a fresh one at level 0 and fires immediately. A cooldown can
--      therefore never suppress a new problem class.
--   b) escalation_level only ever increases while unresolved, and the resend
--      interval SHRINKS with level (24h -> 12h -> 6h -> 3h). An unresolved
--      problem gets louder, never quieter. See api/_lib/outcome-escalation.js.
create table if not exists outcome_incidents (
  id                  bigserial primary key,
  expectation_key     text not null references outcome_expectations(key) on delete cascade,
  cause               text not null default 'unclassified',
  opened_at           timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  resolved_at         timestamptz,
  resolution          text,                                -- 'remediated' | 'recovered' | 'disabled'

  consecutive_failures integer not null default 1,
  escalation_level    integer not null default 0,
  escalation_count    integer not null default 0,
  last_escalated_at   timestamptz,

  remediation_attempts integer not null default 0,
  last_remediation    jsonb,

  backlog_count       integer,                             -- for the cost line
  detail              jsonb
);

-- One OPEN incident per (expectation, cause). A different cause = a different
-- incident = an immediate, uncooled alert.
create unique index if not exists outcome_incidents_open_uniq
  on outcome_incidents(expectation_key, cause) where resolved_at is null;
create index if not exists idx_outcome_incidents_open
  on outcome_incidents(expectation_key) where resolved_at is null;

-- ---------------------------------------------------------------------------
-- 4. credential_health -- per-channel auth freshness
-- ---------------------------------------------------------------------------
-- Failure #1 had no central record at all: scripts/_lib/session-keepalive.js
-- writes scripts/sessions/keepalive-state.json on Heath's PC and nothing else.
-- If the Task Scheduler task simply stops running there is no row to go stale,
-- so the silence is invisible. Centralising it means the monitor can treat a
-- STALE PROBE as a finding in its own right, which is the stronger signal.
create table if not exists credential_health (
  channel             text primary key,                    -- 'facebook_groups','linkedin_personal',...
  profile_dir         text,
  probe_kind          text,                                -- 'cookie_db' | 'live_action' | 'keepalive_state'
  logged_in           boolean,
  required_cookies    text[],
  present_cookies     text[],
  earliest_expiry     timestamptz,
  days_to_expiry      numeric,
  consecutive_failures integer not null default 0,
  last_probe_at       timestamptz,
  last_healthy_at     timestamptz,
  detail              jsonb,
  updated_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS -- service-role only. These are ops tables; no client ever reads them.
-- (Same posture as the 2026-09-24 telegram_send_log / alert_state fix.)
-- ---------------------------------------------------------------------------
alter table outcome_expectations enable row level security;
alter table outcome_checks       enable row level security;
alter table outcome_incidents    enable row level security;
alter table credential_health    enable row level security;

-- ---------------------------------------------------------------------------
-- SEED: the expectation table itself
-- ---------------------------------------------------------------------------
-- Every threshold below was set against numbers verified live on 2026-09-25,
-- not guessed. Where a pipeline is currently BELOW its declared floor that is
-- deliberate -- the monitor is supposed to open an incident on day one.
-- ---------------------------------------------------------------------------
-- SEED: the expectation set
-- ---------------------------------------------------------------------------
-- Every threshold below was set against numbers verified live on 2026-09-25,
-- not guessed. Where a pipeline is currently BELOW its declared floor that is
-- deliberate -- the monitor is supposed to open an incident on day one.
--
-- The seed is a single JSON document inside the dollar-quoted seed
-- block so it has exactly ONE home. scripts/outcome-monitor-verify.js extracts
-- the same bytes out of this file to dry-run the monitor before the migration
-- is applied anywhere, which means a verification run can never be testing a
-- different expectation set than the one the database will hold.
insert into outcome_expectations (
  key, pipeline, label, source_table, source_filters, time_column, window_mode,
  window_hours, min_count, classifiers, remediations, remediation_mode, severity,
  grace_hours, human_only, human_fix, human_fix_minutes, cost_unit, notes
)
select
  key, pipeline, label, source_table, source_filters, time_column,
  coalesce(window_mode, 'recent'), window_hours, min_count, classifiers,
  remediations, remediation_mode, severity, grace_hours, human_only, human_fix,
  human_fix_minutes, cost_unit, notes
from jsonb_to_recordset($seed$
[
  {
    "key": "fb_group_posts_daily",
    "pipeline": "fb_groups",
    "label": "Facebook group posts published",
    "source_table": "group_posts",
    "source_filters": { "status": "eq.posted" },
    "time_column": "posted_at",
    "window_hours": 24,
    "min_count": 1,
    "classifiers": ["credential_missing", "queue_backed_up", "queue_empty", "dead_local_runner", "vendor_error"],
    "remediations": ["clear_stale_post_lock", "request_local_job"],
    "remediation_mode": "safe",
    "severity": "critical",
    "grace_hours": 6,
    "human_only": false,
    "human_fix": "Open Chrome on the DossieBot-Sage profile (C:\\Users\\Heath\\AppData\\Local\\DossieBot-Sage), go to facebook.com, log in as Heath Shepard (facebook.com/heath.shepard.75), then close the window. Nothing else to do -- fb-group-poster.js reuses the profile.",
    "human_fix_minutes": 2,
    "cost_unit": "group posts unsent",
    "notes": "Verified 2026-09-25: last posted_at is 2026-09-17, approved rows are waiting, and the DossieBot-Sage cookie DB holds only datr/sb/wd/ps_l/ps_n -- no c_user, no xs. Logged out."
  },
  {
    "key": "social_posts_daily",
    "pipeline": "social_publish",
    "label": "Social posts published via Zernio",
    "source_table": "social_posts",
    "source_filters": { "status": "eq.posted" },
    "time_column": "posted_at",
    "window_hours": 24,
    "min_count": 3,
    "classifiers": ["stale_publish_lock", "queue_backed_up", "queue_empty", "vendor_error"],
    "remediations": ["clear_stale_publish_lock", "retry_failed_with_backoff"],
    "remediation_mode": "safe",
    "severity": "critical",
    "grace_hours": 4,
    "human_only": false,
    "human_fix": "Check account connections at zernio.com; if one shows disconnected, reconnect it there. No local Chrome involved in this path.",
    "human_fix_minutes": 5,
    "cost_unit": "posts unsent",
    "notes": "Verified 2026-09-25: 6 posted in the last 24h, 45 in the last 7d. The floor of 3/day sits under the current run rate on purpose -- it should only trip on a real stall."
  },
  {
    "key": "social_posts_weekly",
    "pipeline": "social_publish",
    "label": "Social posts published via Zernio (7-day floor)",
    "source_table": "social_posts",
    "source_filters": { "status": "eq.posted" },
    "time_column": "posted_at",
    "window_hours": 168,
    "min_count": 15,
    "classifiers": ["queue_backed_up", "queue_empty", "vendor_error"],
    "remediations": [],
    "remediation_mode": "off",
    "severity": "warn",
    "grace_hours": 24,
    "human_only": false,
    "human_fix": null,
    "human_fix_minutes": null,
    "cost_unit": "posts unsent",
    "notes": "Slow-burn floor. Catches a gradual decay that the daily check keeps skimming past."
  },
  {
    "key": "linkedin_personal_weekly",
    "pipeline": "linkedin_personal",
    "label": "LinkedIn personal-profile posts published",
    "source_table": "social_posts",
    "source_filters": { "status": "eq.posted", "platform": "eq.linkedin_personal" },
    "time_column": "posted_at",
    "window_hours": 168,
    "min_count": 1,
    "classifiers": ["credential_missing", "queue_backed_up", "queue_empty"],
    "remediations": ["request_local_job"],
    "remediation_mode": "safe",
    "severity": "warn",
    "grace_hours": 24,
    "human_only": true,
    "human_fix": "Short term: open Chrome on the DossieBot-Sage profile and log into LinkedIn. Better, and about the same two minutes: in the Zernio dashboard try connecting your personal LinkedIn profile as a destination. Zernio already posts the MeetDossie company page daily on a token nobody has touched in months. If it accepts a personal profile, this channel stops depending on a Chrome cookie at all -- see the Tier 1 note at the top of api/_lib/outcome-expectations.js.",
    "human_fix_minutes": 2,
    "cost_unit": "personal posts unsent",
    "notes": "Verified 2026-09-25: 5 approved linkedin_personal rows sitting unposted; keepalive-state.json shows last_healthy_at=null and an authwall bounce on 2026-09-22."
  },
  {
    "key": "comment_replies_daily",
    "pipeline": "fb_comments",
    "label": "Facebook comment replies posted",
    "source_table": "tc_discovery_responses",
    "source_filters": { "reply_status": "eq.posted" },
    "time_column": "reply_posted_at",
    "window_hours": 24,
    "min_count": 2,
    "classifiers": ["credential_missing", "awaiting_human_approval", "queue_backed_up", "queue_empty", "dead_local_runner"],
    "remediations": ["request_local_job"],
    "remediation_mode": "safe",
    "severity": "warn",
    "grace_hours": 12,
    "human_only": false,
    "human_fix": "Same DossieBot-Sage Chrome profile as the FB groups -- one login fixes both channels.",
    "human_fix_minutes": 2,
    "cost_unit": "replies unsent",
    "notes": null
  },
  {
    "key": "comment_opportunities_posted_daily",
    "pipeline": "fb_comments",
    "label": "Approved comment opportunities actually posted",
    "source_table": "comment_opportunities",
    "source_filters": { "status": "eq.posted" },
    "time_column": "posted_at",
    "window_hours": 24,
    "min_count": 1,
    "classifiers": ["credential_missing", "awaiting_human_approval", "queue_backed_up", "queue_empty"],
    "remediations": [],
    "remediation_mode": "off",
    "severity": "warn",
    "grace_hours": 12,
    "human_only": false,
    "human_fix": "Same DossieBot-Sage Chrome profile as the FB groups.",
    "human_fix_minutes": 2,
    "cost_unit": "approved comments unposted",
    "notes": null
  },
  {
    "key": "video_published_weekly",
    "pipeline": "video",
    "label": "Videos published",
    "source_table": "video_library",
    "source_filters": { "status": "in.(posted,published)" },
    "time_column": "created_at",
    "window_hours": 168,
    "min_count": 3,
    "classifiers": ["awaiting_human_approval", "vendor_billing", "render_selector_mismatch", "queue_empty"],
    "remediations": [],
    "remediation_mode": "off",
    "severity": "critical",
    "grace_hours": 48,
    "human_only": false,
    "human_fix": "Videos are queued but not shipping. Check (a) Creatomate billing -- it has returned HTTP 402 since 2026-06-30, and (b) video_library rows sitting at pending_heath_review, which need your tap in Telegram.",
    "human_fix_minutes": 10,
    "cost_unit": "videos unshipped",
    "notes": "Verified 2026-09-25: ZERO video_library rows created in the last 30 days at status posted/published. This expectation opens an incident on its first run, which is correct."
  },
  {
    "key": "video_render_queue_drains",
    "pipeline": "video",
    "label": "Video render queue drains (nothing waits past 48h)",
    "source_table": "social_posts",
    "source_filters": { "status": "eq.pending_video", "media_url": "is.null" },
    "time_column": "created_at",
    "window_mode": "older_than",
    "window_hours": 48,
    "min_count": 0,
    "classifiers": ["render_selector_mismatch", "vendor_billing", "dead_cron"],
    "remediations": ["fix_render_selector_mismatch"],
    "remediation_mode": "safe",
    "severity": "warn",
    "grace_hours": 12,
    "human_only": false,
    "human_fix": null,
    "human_fix_minutes": null,
    "cost_unit": "renders stuck",
    "notes": "INVERTED expectation: min_count 0 means this set must stay EMPTY. Deliberately does NOT mention video_required -- that column IS the drifted selector. cron-render-videos filters video_required=eq.true while cron-publish-approved parks rows at video_required=false, so it matched 0 rows for weeks at last_status=ok in 168ms. An expectation that reused the same predicate would have been just as blind, so this one asks the selector-independent question: is anything parked awaiting a render and not getting one."
  },
  {
    "key": "cron_outcome_reporting",
    "pipeline": "telemetry",
    "label": "No cron reports success without saying what it accomplished",
    "source_table": "cron_runs",
    "source_filters": { "last_meta->>outcome": "is.null", "last_status": "eq.ok" },
    "time_column": "last_run",
    "window_mode": "recent",
    "window_hours": 24,
    "min_count": 0,
    "classifiers": ["telemetry_blind"],
    "remediations": [],
    "remediation_mode": "off",
    "severity": "info",
    "grace_hours": 24,
    "human_only": false,
    "human_fix": null,
    "human_fix_minutes": null,
    "cost_unit": "blind crons",
    "notes": "THE ROOT-CAUSE EXPECTATION, and the one that would have caught failures 4, 5 and 7 as a class. INVERTED: zero crons may report ok in the last 24h without a last_meta.outcome. A cron with no item count cannot distinguish ran-and-worked from ran-and-did-nothing -- cron-render-videos sat at last_status=ok, 168ms, zero rows matched, for weeks. Expect this to measure in the low hundreds until the cron-telemetry.js outcome stamp has been deployed and every cron has ticked once; it then self-resolves without anyone touching it."
  },
  {
    "key": "credential_probe_fresh",
    "pipeline": "credentials",
    "label": "Credential probe has reported within 48h",
    "source_table": "credential_health",
    "source_filters": {},
    "time_column": "last_probe_at",
    "window_hours": 48,
    "min_count": 1,
    "classifiers": ["dead_local_runner"],
    "remediations": [],
    "remediation_mode": "off",
    "severity": "warn",
    "grace_hours": 12,
    "human_only": true,
    "human_fix": "The local credential probe has not checked in. Confirm the PC is on and that the scheduled task running scripts/credential-health-probe.js still exists.",
    "human_fix_minutes": 5,
    "cost_unit": "hours blind on auth",
    "notes": "A stale probe is itself the finding. The old design kept this state in a local JSON file, so a probe that stopped running left nothing behind to go stale."
  },
  {
    "key": "credential_channels_logged_in",
    "pipeline": "credentials",
    "label": "All 3 browser channels are logged in",
    "source_table": "credential_health",
    "source_filters": { "logged_in": "eq.true" },
    "time_column": null,
    "window_hours": 24,
    "min_count": 3,
    "classifiers": [],
    "remediations": [],
    "remediation_mode": "off",
    "severity": "critical",
    "grace_hours": 6,
    "human_only": true,
    "human_fix": "Open Chrome on the profile named in the credential_health row and sign in by hand, then close the window. LinkedIn + Instagram live in C:\\Users\\Heath\\DossieBot; Facebook lives in C:\\Users\\Heath\\AppData\\Local\\DossieBot-Sage. Nothing automates this on purpose -- an automated Facebook login trips a checkpoint and risks the real account.",
    "human_fix_minutes": 3,
    "cost_unit": "dead channels",
    "notes": "Added 2026-09-25 (Atlas). credential_probe_fresh only proves the PROBE is alive; it counts rows regardless of what they say, so all three channels could be logged out with the expectation fully satisfied -- which is exactly the state on the day it was written. This one measures the ANSWER rather than the reporting. Expected to be a GAP (0/3) until Heath logs in manually; that is the monitor working, not a bug."
  }
]
$seed$::jsonb) as t(
  key text, pipeline text, label text, source_table text, source_filters jsonb,
  time_column text, window_mode text, window_hours integer, min_count integer,
  classifiers text[], remediations text[], remediation_mode text, severity text,
  grace_hours integer, human_only boolean, human_fix text,
  human_fix_minutes integer, cost_unit text, notes text
)
on conflict (key) do nothing;

-- ============================================================================
-- AMENDMENT 2026-09-25 (Atlas) — ESCALATION DELIVERY ACCOUNTING
--
-- The first cut of api/_lib/outcome-monitor.js called markEscalated() the
-- moment the alert TEXT was formatted — before the cron had attempted a send,
-- and with nothing checking telegramGate.wasSuppressed() on the gate's fake
-- HTTP 200. An incident could therefore carry last_escalated_at for a message
-- Heath never received, and the shrinking-resend ladder would then stay silent
-- for 24h because it believed it had already spoken.
--
-- That is the exact failure this monitor exists to catch — recording an action
-- as done without verifying it happened. Same shape as the 2026-08-17
-- cron-video-approval incident: five videos marked pending_approval off a
-- suppressed send, invisible for three weeks.
--
-- Three delivery states are now recorded distinctly, and only 'sent' advances
-- the ladder (api/_lib/outcome-escalation.js, escalationPatch):
--   sent       -> last_escalated_at + escalation_count++   (the only "spoke to Heath")
--   suppressed -> suppressed_escalations++, last_escalated_at UNTOUCHED, so the
--                 incident stays due and fires the moment the gate opens
--   failed     -> failed_escalations++, same "still due" treatment
--
-- Idempotent, like everything else in this file.
-- ============================================================================
alter table outcome_incidents
  add column if not exists last_delivery_state   text,
  add column if not exists last_delivery_at      timestamptz,
  add column if not exists last_delivery_detail  text,
  add column if not exists suppressed_escalations integer not null default 0,
  add column if not exists failed_escalations     integer not null default 0;

do $$ begin
  alter table outcome_incidents add constraint outcome_incidents_delivery_state_chk
    check (last_delivery_state is null or last_delivery_state in ('sent','suppressed','failed'));
exception when duplicate_object then null; end $$;

comment on column outcome_incidents.last_delivery_state is
  'What ACTUALLY happened to the last escalation message: sent | suppressed (telegram-gate ate it) | failed. Only ''sent'' sets last_escalated_at. Distinguishing these is the difference between "quiet because healthy" and "quiet because muted".';
comment on column outcome_incidents.last_escalated_at is
  'Timestamp of the last CONFIRMED delivery to Heath — never set for a suppressed or failed send. The resend ladder measures from here, so a swallowed alert leaves the incident due rather than cooling it off for 24h.';

-- The credential probe has never once run: scripts/register-session-keepalive-tasks.ps1
-- has not been executed on Heath's PC (verified 2026-09-25 — none of its five
-- tasks exist in Windows Task Scheduler), so credential_health has zero rows
-- and this expectation cannot be met until it is. Point the fix text at the
-- one command that actually resolves it rather than at a task to "confirm".
update outcome_expectations
   set human_fix = 'The local credential probe has NEVER reported — its scheduled task was never created. From an elevated PowerShell in C:\Users\Heath\Projects\MeetDossie run: powershell -ExecutionPolicy Bypass -File scripts\register-session-keepalive-tasks.ps1 (registers 5 tasks incl. "Dossie Credential Health Probe", daily 03:10). Then: Start-ScheduledTask -TaskName ''Dossie Credential Health Probe''.',
       human_fix_minutes = 3,
       notes = 'A stale probe is itself the finding. Verified 2026-09-25: credential_health has 0 rows and none of the register-session-keepalive-tasks.ps1 tasks exist in Task Scheduler, so this measures 0 by design until Heath runs that script once.',
       updated_at = now()
 where key = 'credential_probe_fresh';
