-- ============================================================================
-- OUTBOUND ACCOUNT COMMENTING (Atlas, 2026-09-28)
--
-- Heath, 2026-09-28: "be a problem solver, be proactive, figure out how to
-- work within the system to get it done." One of the four autonomy pieces
-- he asked for: comment 3x/day on larger Texas real-estate accounts/pages
-- Heath has no standing relationship with (as opposed to the 5 FB groups
-- he's already a member of -- scripts/comment-hunt-groups.json /
-- fb-comment-hunt-daily.js -- a separate, existing pipeline this does not
-- touch or reuse).
--
-- Two tables:
--   1. comment_target_accounts -- the curated list. A DB table, not a JSON
--      config file (Heath's explicit instruction: "store it in a table,
--      don't hardcode"), so it can be edited without a deploy.
--   2. outbound_account_comments -- one row per drafted/posted comment,
--      the dedupe ledger (never twice on one post, never twice on one
--      account same day) and the report-mode record Heath reviews before
--      any of this goes live.
--
-- SAME RESOLVABILITY GATE AS scripts/_lib/group-resolvability-check.js
-- (Carter, 2026-09-16): an account is not scanned or commented on just
-- because its name/URL look plausible. existence_verified stays false
-- until a real browser session has actually loaded the page and confirmed
-- it. This migration seeds 8-12 well-known, real Texas real-estate
-- brokerages/associations from general knowledge, ALL with
-- existence_verified=false -- this session had no live browser or search
-- access to independently confirm handles/URLs against the real platforms
-- (see the build report). The scanner refuses to touch an unverified row,
-- exactly like the existing group gate refuses an unverified group.
--
-- Ships OFF. See ops_flags seed at the bottom:
--   outbound_account_comments_live  default false -- report-mode (drafts
--     only, nothing posts) is the permanent behavior until Heath flips it.
-- ============================================================================

create table if not exists comment_target_accounts (
  id                  uuid primary key default gen_random_uuid(),

  platform            text not null check (platform in ('facebook', 'instagram')),
  account_name        text not null,
  handle              text,
  page_url            text not null,

  -- Why this account is on the list (size/reach/audience fit) -- a one-line
  -- human-readable justification, never blank.
  notes               text not null,

  active              boolean not null default true,

  -- The resolvability gate (see header). Nothing scans or comments on a row
  -- with existence_verified=false, no matter what `active` says.
  existence_verified  boolean not null default false,
  verified_at         timestamptz,
  verified_by         text,
  verification_note   text,

  -- Result of the most recent scan attempt, whether or not it produced a
  -- comment -- so a page that silently stopped resolving (deleted, renamed,
  -- rate-limited) is visible rather than just quietly skipped forever.
  last_scanned_at     timestamptz,
  last_scan_ok        boolean,
  last_scan_error     text,

  added_by            text not null default 'atlas',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists comment_target_accounts_url_uniq
  on comment_target_accounts (lower(page_url));

create index if not exists comment_target_accounts_active_idx
  on comment_target_accounts (active, existence_verified);

comment on table comment_target_accounts is
  'Curated larger Texas real-estate accounts/pages eligible for scripts/outbound-account-commenter.js. A row is only ever scanned/commented on when existence_verified=true (same resolvability-gate pattern as scripts/_lib/group-resolvability-check.js) -- seeding a plausible-looking name here does not make it eligible.';


create table if not exists outbound_account_comments (
  id                  uuid primary key default gen_random_uuid(),

  target_account_id   uuid not null references comment_target_accounts(id) on delete cascade,
  platform            text not null,

  post_url            text not null,
  post_external_id    text,
  post_excerpt        text,
  post_author_name    text,

  draft_text          text,
  gate_failures       jsonb,

  -- pending: drafted, not yet eligible/decided. drafted: cleared gates,
  -- held for report-mode review. posted: actually went out. held: failed a
  -- gate or the risk classifier, never auto-posted. skipped: dedupe/cap hit.
  status              text not null default 'pending'
    check (status in ('pending', 'drafted', 'posted', 'held', 'skipped', 'post_failed')),

  posted_at           timestamptz,
  posted_comment_id   text,
  error_message       text,

  created_at          timestamptz not null default now()
);

-- Dedupe rule 1: never comment twice on the same post.
create unique index if not exists outbound_account_comments_post_uniq
  on outbound_account_comments (target_account_id, post_url);

-- Dedupe rule 2 (never twice on one ACCOUNT in a day) is enforced in the
-- scanner via a query against posted_at::date, not a DB constraint --
-- "twice on one account" spans multiple posts, which a unique index on
-- (account_id, day) cannot express without a generated column. Documented
-- here so the rule has one obvious home: scripts/outbound-account-
-- commenter.js, function alreadyCommentedAccountToday().
create index if not exists outbound_account_comments_account_day_idx
  on outbound_account_comments (target_account_id, posted_at);

comment on table outbound_account_comments is
  'One row per drafted/posted comment from scripts/outbound-account-commenter.js. Report-mode default: rows land at status=drafted and nothing is posted until ops_flags.outbound_account_comments_live is on AND the daily cap/dedupe checks pass.';

-- ---------------------------------------------------------------------------
-- Kill switch -- default OFF. Same two-state shape as every other publish-
-- class capability in this codebase (ops_flags, api/_lib/ops-policy.js).
-- OFF = report-mode: the scanner drafts and writes rows, nothing posts.
-- ---------------------------------------------------------------------------
insert into ops_flags (key, enabled, reason, updated_by) values
  ('outbound_account_comments_live',
   false,
   'Posting drafted comments to larger Texas RE accounts/pages via scripts/outbound-account-commenter.js. OFF = report-mode (drafts only, nothing posts). Hard cap 3/day regardless (scripts/_lib/comment-caps.js, outbound_account_comment budget) once turned on.',
   'atlas')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Seed: 8 real, well-known Texas real-estate brokerages/associations from
-- general knowledge. existence_verified=false on every row -- see header.
-- notes explains why each is a plausible fit (size/reach), not a claim that
-- the handle/URL below is confirmed correct.
-- ---------------------------------------------------------------------------
insert into comment_target_accounts (platform, account_name, handle, page_url, notes) values
  ('facebook', 'Texas REALTORS (state trade association)', 'texasrealtors', 'https://www.facebook.com/texasrealtors', 'Statewide REALTOR trade association -- largest single audience of working TX agents of anything on this list.'),
  ('facebook', 'HAR.com / Houston Association of REALTORS', 'HARdotcom', 'https://www.facebook.com/HARdotcom', 'Houston MLS/association -- one of the largest metro REALTOR bodies in the state.'),
  ('facebook', 'Ebby Halliday Realtors', 'EbbyHalliday', 'https://www.facebook.com/EbbyHalliday', 'Large, long-established DFW-area brokerage with a big agent roster and active page.'),
  ('facebook', 'Allie Beth Allman & Associates', 'alliebethallman', 'https://www.facebook.com/alliebethallman', 'Prominent Dallas luxury brokerage, high-visibility page.'),
  ('facebook', 'Kuper Sotheby''s International Realty', 'KuperSIR', 'https://www.facebook.com/KuperSIR', 'Large San Antonio-area luxury brokerage -- same metro Heath works in.'),
  ('facebook', 'Phyllis Browning Company', 'PhyllisBrowningCompany', 'https://www.facebook.com/PhyllisBrowningCompany', 'Large independent San Antonio brokerage, well-known locally.'),
  ('facebook', 'JPAR Real Estate', 'JPARRealEstate', 'https://www.facebook.com/JPARRealEstate', 'Texas-founded (Southlake) national franchise brokerage with heavy TX agent density.'),
  ('facebook', 'Coldwell Banker Apex, REALTORS', 'CBApexRealtors', 'https://www.facebook.com/CBApexRealtors', 'Large DFW-area Coldwell Banker affiliate, active agent-facing page.')
on conflict (lower(page_url)) do nothing;
