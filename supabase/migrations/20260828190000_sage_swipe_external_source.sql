-- Extend the (already-scaffolded, previously uncoded) sage_swipe_* tables
-- with an external-trend-research pass.
--
-- Author: Sage, 2026-08-28
--
-- CONTEXT: sage_swipe_watchlist / sage_swipe_items / sage_swipe_rules /
-- sage_hook_bank already existed in the live DB with zero rows and zero code
-- references anywhere in the repo (confirmed via /rest/v1/?select=* schema
-- dump + repo-wide grep, 2026-08-28) -- scaffolded by an earlier session,
-- never wired up, no migration file ever committed for the base CREATE
-- TABLEs. This migration only ADDs columns (idempotent, safe against an
-- unknown base state) -- it does not attempt to recreate the base tables.
--
-- PURPOSE: distinguish Dossie's own logged post performance (implicitly
-- "internal" -- lives in post_analytics, already wired into
-- cron-generate-posts.js via buildTopPerformerBlock()) from patterns pulled
-- from external high-engagement examples in Dossie's niche (real estate
-- TC-pain / agent productivity content), and store PATTERN-LEVEL data only
-- -- never verbatim script/caption/footage text. See
-- docs/PIPELINE.md "CONTENT FUEL" section for the existing internal-fuel
-- pattern this extends.
--
-- SAFETY: post_text on sage_swipe_items already existed pre-migration and is
-- NOT touched here. For any source='external' row, post_text MUST stay NULL
-- -- the new pattern_notes / hook_type / etc columns below are the only
-- fields external rows should ever populate. This is enforced by the CHECK
-- constraint at the bottom, not just convention.

-- ═══ sage_swipe_items: pattern-level columns + source tag ══════════════════

ALTER TABLE public.sage_swipe_items
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'external';

ALTER TABLE public.sage_swipe_items
  DROP CONSTRAINT IF EXISTS sage_swipe_items_source_check;
ALTER TABLE public.sage_swipe_items
  ADD CONSTRAINT sage_swipe_items_source_check CHECK (source IN ('external', 'internal'));

-- hook type: question / stat / before-after / testimonial / bold-claim /
-- story-open / curiosity-gap / contrast / etc -- matches the vocabulary
-- already used by HOOK_FORMULAS in api/cron-generate-posts.js where possible.
ALTER TABLE public.sage_swipe_items ADD COLUMN IF NOT EXISTS hook_type TEXT;

ALTER TABLE public.sage_swipe_items ADD COLUMN IF NOT EXISTS video_length_seconds INT;

-- Pacing: cuts-per-X-seconds if inferable, plain-language otherwise.
ALTER TABLE public.sage_swipe_items ADD COLUMN IF NOT EXISTS pacing_notes TEXT;

-- Caption STRUCTURE only: length bucket, line-break usage, emoji use,
-- CTA placement. Never the caption text itself.
ALTER TABLE public.sage_swipe_items ADD COLUMN IF NOT EXISTS caption_structure_notes TEXT;

ALTER TABLE public.sage_swipe_items ADD COLUMN IF NOT EXISTS posting_time_notes TEXT;

-- Freeform pattern summary -- the one field most likely to accidentally
-- drift toward verbatim content if a future contributor isn't careful.
-- Convention: pattern_notes describes STRUCTURE ("opens with a direct
-- question to camera, cuts to text-overlay stat at ~4s..."), never quotes.
ALTER TABLE public.sage_swipe_items ADD COLUMN IF NOT EXISTS pattern_notes TEXT;

-- Secondary/reporting source this pattern was actually observed through
-- (a journalism writeup, an aggregate engagement-rate study, a creator's
-- own public post) -- kept separate from post_url so both can be recorded
-- when the pattern came from an ABOUT-the-post article rather than the post
-- itself being directly scraped.
ALTER TABLE public.sage_swipe_items ADD COLUMN IF NOT EXISTS observed_via_url TEXT;

-- Hard guardrail: an external-source row is never allowed to carry verbatim
-- post text. (Internal rows -- Dossie's own posts -- are exempt; we already
-- own that copy outright and post_analytics/social_posts already store it.)
ALTER TABLE public.sage_swipe_items
  DROP CONSTRAINT IF EXISTS sage_swipe_items_external_no_verbatim;
ALTER TABLE public.sage_swipe_items
  ADD CONSTRAINT sage_swipe_items_external_no_verbatim
  CHECK (source <> 'external' OR post_text IS NULL);

CREATE INDEX IF NOT EXISTS idx_sage_swipe_items_source
  ON public.sage_swipe_items (source);

-- ═══ sage_swipe_rules: source tag ═══════════════════════════════════════════
-- A rule distilled purely from Dossie's own post_analytics history is
-- 'internal'; a rule distilled from external swipe_items is 'external'.
-- A rule can also be 'cross_referenced' once both an external pattern and an
-- internal result have independently supported it (see
-- api/_lib/sage-external-patterns.js buildCrossReferencedStrategyBlock()).

ALTER TABLE public.sage_swipe_rules
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'external';

ALTER TABLE public.sage_swipe_rules
  DROP CONSTRAINT IF EXISTS sage_swipe_rules_source_check;
ALTER TABLE public.sage_swipe_rules
  ADD CONSTRAINT sage_swipe_rules_source_check
  CHECK (source IN ('external', 'internal', 'cross_referenced'));

CREATE INDEX IF NOT EXISTS idx_sage_swipe_rules_source
  ON public.sage_swipe_rules (source);

-- ═══ sage_swipe_watchlist: source tag (for completeness/consistency) ═══════

ALTER TABLE public.sage_swipe_watchlist
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'external';
