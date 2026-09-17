-- Wire 'rust' as a third first-class zernio_accounts/video_library/
-- social_posts owner, alongside 'dossie' and 'heath-realtor'
-- (20260817_zernio_accounts_owner.sql, 20260910_video_library_target_owner.sql,
-- 20260817_social_posts_target_owner.sql).
--
-- CONTEXT: Rust (rustfitness.app) has live, verified Zernio connections
-- (Instagram @ruststrength, X @Ruststrength, confirmed active via
-- GET /api/v1/accounts under the separate "Rust" Zernio profile) but every
-- owner CHECK constraint in this schema only ever allowed 'dossie' and
-- 'heath-realtor' — a third brand could not even be inserted, let alone
-- publish. This migration widens the three CHECK constraints and seeds the
-- two connected Rust accounts, so from here a fourth brand is a data change
-- (INSERT + CHECK widen), not a code change — cron-post-videos.js and
-- cron-publish-approved.js already resolve owner -> zernio_accounts row
-- generically (see resolveZernioAccountId()/lookupZernioAccountId()).
--
-- Applied by Heath directly (Supabase MCP), per his own instruction — Carter
-- does not apply prod DDL in this pipeline. See PR/commit for the full
-- rationale.

-- 1. Widen zernio_accounts.owner
ALTER TABLE public.zernio_accounts
  DROP CONSTRAINT IF EXISTS zernio_accounts_owner_check;

ALTER TABLE public.zernio_accounts
  ADD CONSTRAINT zernio_accounts_owner_check
  CHECK (owner IN ('dossie', 'heath-realtor', 'rust'));

-- 2. Widen video_library.target_owner
ALTER TABLE public.video_library
  DROP CONSTRAINT IF EXISTS video_library_target_owner_check;

ALTER TABLE public.video_library
  ADD CONSTRAINT video_library_target_owner_check
  CHECK (target_owner IN ('dossie', 'heath-realtor', 'rust'));

-- 3. Widen social_posts.target_owner (Rust doesn't route through
--    cron-generate-posts.js today, but the column/constraint should not be
--    the reason it can't later — same reasoning as #1/#2).
ALTER TABLE public.social_posts
  DROP CONSTRAINT IF EXISTS social_posts_target_owner_check;

ALTER TABLE public.social_posts
  ADD CONSTRAINT social_posts_target_owner_check
  CHECK (target_owner IN ('dossie', 'heath-realtor', 'rust'));

-- 4. posting_schedule has never been owner-scoped — every platform's slots/
--    cap are shared across ALL owners posting to it (cron-post-videos.js's
--    own comment: "shared across owners on the same platform, only the
--    COUNT against that cap is per-owner"). That was fine while every owner
--    wanted the same platforms live/dark. It breaks the moment two owners
--    disagree: Twitter/X is deliberately INACTIVE for Dossie (all 7
--    day_of_week rows, is_active=false) but Rust's @Ruststrength connection
--    needs it active. Flipping the shared row on would turn Twitter back on
--    for Dossie too — an unrelated, unintended behavior change.
--
--    Adds a nullable `owner` column: NULL = shared row (applies to every
--    owner that has no row of its own for that platform+day — zero
--    behavior change for every existing row, all of which stay NULL).
--    A non-null owner value is an override that ONLY that owner sees for
--    that exact platform+day; cron-post-videos.js's loadTodaySchedule() and
--    cron-publish-approved.js's loadSchedules() prefer the owner-specific
--    row and fall back to the shared (owner IS NULL) row.
ALTER TABLE public.posting_schedule
  ADD COLUMN IF NOT EXISTS owner text;

COMMENT ON COLUMN public.posting_schedule.owner IS
  'NULL = shared row, applies to every owner with no override for this platform+day (zero behavior change for pre-existing rows). A non-null value (e.g. rust) overrides the shared row for that owner ONLY, e.g. turning Twitter/X on for Rust without touching Dossie''s own (deliberately inactive) Twitter schedule. See loadTodaySchedule()/gatePlatform() in cron-post-videos.js and loadSchedules()/isDueForPublish() in cron-publish-approved.js.';

-- The table's original schema (pre-dates this migrations directory) carries
-- a plain UNIQUE(platform, day_of_week) constraint, auto-named
-- posting_schedule_platform_day_of_week_key. That constraint has no `owner`
-- in it, so the very INSERTs below (step 6, a second row per platform+day
-- for 'rust') would violate it before the new per-owner index below ever
-- gets a chance to matter — confirmed by hand against prod 2026-09-16. Drop
-- it; the new unique index two lines down replaces it and is strictly
-- stronger (still unique for the shared/NULL-owner case, and now also
-- unique per owner override).
ALTER TABLE public.posting_schedule
  DROP CONSTRAINT IF EXISTS posting_schedule_platform_day_of_week_key;

-- One row per (platform, day_of_week, owner) — COALESCE to a sentinel so the
-- uniqueness check also dedupes the NULL/"shared" group (Postgres unique
-- indexes normally treat every NULL as distinct).
DROP INDEX IF EXISTS idx_posting_schedule_platform_day_owner;
CREATE UNIQUE INDEX idx_posting_schedule_platform_day_owner
  ON public.posting_schedule (platform, day_of_week, COALESCE(owner, '__shared__'));

-- 5. Seed Rust's two connected Zernio accounts (verified live via
--    GET /api/v1/accounts, 2026-09-16):
--      Instagram @ruststrength -> 6aa4719d726ebfe037dc6686
--      X (Twitter) @Ruststrength -> 6aa46f53726ebfe037dc5d92
--    Both live under a separate "Rust" Zernio profile (6aa46ec7...) from
--    Dossie's/Heath's-realtor's profile — that's a Zernio-side account
--    grouping only, irrelevant to zernio_accounts.zernio_account_id, which
--    Zernio's API accepts regardless of which of Heath's profiles owns it.
INSERT INTO public.zernio_accounts (platform, account_handle, zernio_account_id, owner, is_active)
SELECT 'instagram', '@ruststrength', '6aa4719d726ebfe037dc6686', 'rust', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.zernio_accounts WHERE platform = 'instagram' AND owner = 'rust'
);

INSERT INTO public.zernio_accounts (platform, account_handle, zernio_account_id, owner, is_active)
SELECT 'twitter', '@Ruststrength', '6aa46f53726ebfe037dc5d92', 'rust', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.zernio_accounts WHERE platform = 'twitter' AND owner = 'rust'
);

-- 6. Rust needs Twitter/X active. Instagram needs NO override — the shared
--    instagram schedule (all 7 days, 08:00/18:00, max_per_day=2, is_active)
--    already covers Rust fine, same as it does Dossie today. Twitter's
--    shared schedule is is_active=false on all 7 rows (Dossie's own
--    decision), so Rust gets its own override: one slot/day, cap 1/day,
--    matches a single connected account posting at a modest cadence.
INSERT INTO public.posting_schedule (platform, day_of_week, time_slots, timezone, is_active, max_per_day, max_per_slot, owner)
SELECT 'twitter', d, ARRAY['08:00:00']::time without time zone[], 'America/Chicago', true, 1, 1, 'rust'
FROM generate_series(0, 6) AS d
WHERE NOT EXISTS (
  SELECT 1 FROM public.posting_schedule WHERE platform = 'twitter' AND owner = 'rust' AND day_of_week = d
);
