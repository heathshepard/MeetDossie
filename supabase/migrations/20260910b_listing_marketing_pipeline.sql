-- Ongoing daily marketing pipeline for Heath's own active real estate listings
-- (Fawndale / Nopalito / Senisa, per Heath's instruction 2026-09-10: "the
-- marketing of our listings isn't just a one and done ... every day").
--
-- Deliberately a SIBLING set of tables, not an extension of content_calendar/
-- posting_schedule (those are Dossie-content-specific: persona Brenda/
-- Patricia/Victor, algorithm-fuel blocks, AI claims-verifier tuned to Dossie
-- marketing copy). Listings are Heath's own real estate practice and must
-- stay administratively separable from Dossie content per CLAUDE.md's "never
-- cross-post a listing to Dossie channels or vice versa."
--
-- What DOES get reused (deliberately, not rebuilt):
--   - social_posts (target_owner='heath-realtor') for Tier-1 owned channels
--     (facebook.com/HeathShepardRealtor + @heathshepardrealtor) -- rides the
--     EXISTING cron-send-for-approval -> Telegram approve/reject ->
--     cron-publish-approved -> Zernio pipeline untouched. No new approval
--     code needed for this tier.
--   - group_posts (pipeline='listing-groups') for Tier-2 FB Groups -- rides
--     the EXISTING fb-group-poster.js Playwright poster untouched; only the
--     generator + a new Telegram callback prefix (lst_) are new.
--
-- What's new here: the status/rotation bookkeeping neither of those tables
-- has any concept of -- which of Heath's listings are currently postable,
-- and where each one is in its angle/venue rotation.

-- ─── listing_marketing_status ──────────────────────────────────────────────
-- One row per MLS#. Single source of truth gate the generator checks before
-- creating ANY content. Synced from live connectMLS (never trusted stale) by
-- scripts/listing-marketing-status-sync.js. is_active=false or is_paused=true
-- both hard-stop the rotation for that listing -- "auto-stop when a listing
-- goes under contract or sells" per Heath's instruction.
CREATE TABLE IF NOT EXISTS public.listing_marketing_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mls_number text NOT NULL UNIQUE,
  address text NOT NULL,
  city text,
  zip text,
  list_price numeric,
  mls_status text NOT NULL,              -- raw connectMLS status code (ACT, NEW, AO, PCH, ...)
  is_active boolean NOT NULL DEFAULT true, -- derived: mls_status in the Active family AND not under option/contract
  is_agent_owned boolean NOT NULL DEFAULT false, -- Heath is seller -- forces the TREC owner/agent disclosure line on every post
  is_paused boolean NOT NULL DEFAULT false, -- manual kill switch, independent of MLS status (e.g. "hold off, repairs pending")
  pause_reason text,
  photos_ready boolean NOT NULL DEFAULT false, -- real (non-MLS-screenshot) photos exist in listing-media storage
  copy_ready boolean NOT NULL DEFAULT false,   -- vetted base copy/facts exist for the generator to draw from
  last_verified_at timestamptz,          -- last time mls_status was actually re-checked live in connectMLS
  last_verified_by text,                 -- 'listing-marketing-status-sync.js' or an agent name for a manual check
  last_notified_price numeric,           -- price the generator last USED in a post -- compared against list_price to detect a genuine price-change milestone, never fabricated
  last_photos_notified_at timestamptz,   -- last time a 'new photo set' milestone was used -- prevents reusing the same milestone claim repeatedly
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.listing_marketing_status IS
  'Gate table for the daily listing-marketing rotation. The generator MUST check is_active AND NOT is_paused before drafting any post for a listing. Synced from live connectMLS, never hand-edited status except is_paused/pause_reason.';

-- ─── listing_marketing_rotation ────────────────────────────────────────────
-- Tracks rotation state per listing so the generator never repeats the same
-- angle back-to-back and spreads listings/venues across days instead of
-- hammering one house into one group daily.
CREATE TABLE IF NOT EXISTS public.listing_marketing_rotation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mls_number text NOT NULL REFERENCES public.listing_marketing_status(mls_number) ON DELETE CASCADE,
  tier text NOT NULL CHECK (tier IN ('owned', 'group')), -- owned = Tier-1 FB Page/IG, group = Tier-2 FB Groups
  last_angle text,          -- last angle used (room/value/lifestyle/buyer-fit/agent-to-agent/showing/milestone)
  last_venue text,          -- last group_key posted to (tier='group' only)
  last_posted_at timestamptz,
  angle_history text[] NOT NULL DEFAULT '{}', -- last N angles, oldest first, for no-repeat-until-cycled logic
  venue_history text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mls_number, tier)
);

COMMENT ON TABLE public.listing_marketing_rotation IS
  'Per-listing, per-tier rotation cursor so the daily generator picks the next angle/venue instead of repeating. Read+written only by scripts/listing-marketing-generator.js.';

CREATE INDEX IF NOT EXISTS idx_listing_marketing_status_active
  ON public.listing_marketing_status (is_active, is_paused);

-- Extend group_posts with the new pipeline value (column already exists,
-- nullable, multi-pipeline by design -- see 20260909_group_post5_daily.sql).
-- No ALTER needed; 'listing-groups' is just a new string value. Documented
-- here so the valid pipeline values are discoverable in one place.
COMMENT ON COLUMN public.group_posts.pipeline IS
  'Which generator/queue owns this row: NULL (legacy one-offs), ''daily5'' (TC-discovery 5-group pipeline, api/cron-daily-group5-posts.js), or ''listing-groups'' (Heath''s own active-listing rotation into real-estate-oriented FB groups, scripts/listing-marketing-generator.js + scripts/fb-listing-group-post-queue.js). Different generators, different Telegram callback prefixes (gp5_ vs lst_), SEPARATE facebook_group_post* budget keys in comment-caps.js -- but the SAME underlying Facebook profile/poster (fb-group-poster.js), so combined daily volume across both pipelines still matters for shadowban risk.';
