-- =============================================================================
-- Swipe-file pipeline — storage for ads/posts that are demonstrably working,
-- the patterns extracted from them, and the hook-bank candidates they produce.
--
-- Author: swipe-file build, 2026-09-18.
-- Docs: docs/SWIPE-FILE-PIPELINE.md
--
-- RELATIONSHIP TO THE EXISTING sage_swipe_* TABLES
-- ------------------------------------------------
-- public.sage_swipe_watchlist / sage_swipe_items / sage_swipe_rules /
-- sage_hook_bank already exist (see 20260828190000_sage_swipe_external_source.sql).
-- Those hold PATTERN-LEVEL data only; sage_swipe_items carries a hard CHECK
-- (sage_swipe_items_external_no_verbatim) forbidding verbatim external copy,
-- because sage_swipe_items/_rules are read by the POST GENERATOR
-- (api/_lib/sage-external-patterns.js -> api/cron-generate-posts.js).
--
-- That boundary is deliberate and this migration does NOT weaken it.
--
-- The new tables below sit on the COLLECTION side of that boundary:
--   swipe_ads      — the raw archive record, including verbatim copy.
--   swipe_patterns — structure/hook/CTA abstracted out of each ad.
--   swipe_hook_candidates — proposed additions to the doc hook bank.
--   swipe_inbox    — Heath's manual paste queue + browser-extension capture.
--
-- swipe_ads.full_copy / hook_text are for HUMAN STUDY and pattern extraction
-- only. Nothing that generates a Dossie post may read swipe_ads directly —
-- generation reads sage_swipe_items/sage_swipe_rules, which stay pattern-only.
-- Enforced by convention + the read-path comment in docs/SWIPE-FILE-PIPELINE.md;
-- see also the "What we take and what we never take" section there.
--
-- IDEMPOTENT: safe to re-run.
-- =============================================================================

-- ═══ 1. swipe_ads — the catch ═══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.swipe_ads (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Where it came from. 'meta_ad_library' = public Ad Library web surface.
  source            TEXT NOT NULL
                      CHECK (source IN (
                        'meta_ad_library',
                        'youtube',
                        'tiktok_creative_center',
                        'manual'
                      )),

  -- Stable per-source identifier: Meta Library ID, YouTube video id, or a
  -- sha256 of the submitted URL for manual entries. Dedupe key.
  source_ref        TEXT NOT NULL,

  -- Which of the three markets this belongs to. Set by the collector's
  -- classifier; 'unknown' when nothing matched (kept, not discarded, so a
  -- bad classifier is visible rather than silent).
  market            TEXT NOT NULL DEFAULT 'unknown'
                      CHECK (market IN (
                        'tx_real_estate',   -- Texas real estate / realtor services
                        'tc_saas',          -- transaction coordination + RE SaaS
                        'fitness_ai',       -- fitness / AI coaching apps
                        'unknown'
                      )),

  advertiser        TEXT,                 -- page / channel / account name
  advertiser_url    TEXT,

  creative_type     TEXT
                      CHECK (creative_type IS NULL OR creative_type IN (
                        'video', 'image', 'carousel', 'text', 'unknown'
                      )),

  -- The opening line / scroll-stopper, as the source published it.
  hook_text         TEXT,
  -- Full published body copy, as the source published it.
  full_copy         TEXT,
  -- The call to action as published ("Learn more", "Sign up", "Book a call").
  cta_text          TEXT,

  link              TEXT,                 -- permalink back to the source record

  -- Longevity. run_started_on is what the SOURCE reported (Meta prints
  -- "Started running on <date>"); NULL when the source gave us nothing.
  -- Never inferred from first_seen — that would fabricate a run length.
  run_started_on    DATE,
  run_ended_on      DATE,
  still_active      BOOLEAN,

  first_seen        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Real numbers only, exactly as the source gave them. Shape:
  --   { "kind": "ad_longevity", "days_running": 412, "as_of": "2026-09-18" }
  --   { "kind": "youtube_engagement", "views": 88213, "likes": 1904,
  --     "comments": 233, "published_at": "2025-11-02" }
  -- A source that reports no numbers leaves this NULL. Collectors must never
  -- synthesise a metric a source did not publish.
  evidence          JSONB,
  evidence_kind     TEXT
                      CHECK (evidence_kind IS NULL OR evidence_kind IN (
                        'ad_longevity',       -- how long it has been paid for
                        'youtube_engagement', -- real view/like/comment counts
                        'source_reported',    -- source published its own metric
                        'none'                -- we have no performance evidence
                      )),

  raw               JSONB,                -- untouched collector payload
  notes             TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT swipe_ads_source_ref_unique UNIQUE (source, source_ref)
);

-- days_running is DERIVED, never stored as a free number, so nobody can type
-- an unbacked figure into it. NULL when the source never told us a start date.
CREATE OR REPLACE FUNCTION public.swipe_ads_days_running(a public.swipe_ads)
RETURNS INT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN a.run_started_on IS NULL THEN NULL
    ELSE GREATEST(
      0,
      (COALESCE(a.run_ended_on, (a.last_seen AT TIME ZONE 'UTC')::date) - a.run_started_on)
    )
  END;
$$;

CREATE INDEX IF NOT EXISTS idx_swipe_ads_market_lastseen
  ON public.swipe_ads (market, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_swipe_ads_source
  ON public.swipe_ads (source, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_swipe_ads_run_started
  ON public.swipe_ads (run_started_on)
  WHERE run_started_on IS NOT NULL;

-- ═══ 2. swipe_patterns — what we actually take ══════════════════════════════

CREATE TABLE IF NOT EXISTS public.swipe_patterns (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  swipe_ad_id       UUID NOT NULL REFERENCES public.swipe_ads(id) ON DELETE CASCADE,

  market            TEXT NOT NULL DEFAULT 'unknown',

  -- Abstracted, never verbatim. "Names a specific dollar cost the reader
  -- already pays, then withholds the alternative until line 2."
  hook_pattern      TEXT NOT NULL,
  -- Beat-by-beat shape: "cost anchor -> agitation -> single proof -> ask".
  structure         TEXT,
  -- CTA shape, not CTA text: "low-commitment, no-price, curiosity-preserving".
  cta_shape         TEXT,
  -- Vocabulary matched against api/cron-generate-posts.js HOOK_FORMULAS where
  -- possible: question / stat / before-after / testimonial / bold-claim /
  -- story-open / curiosity-gap / contrast.
  hook_type         TEXT,

  -- 0-100. Computed from REAL evidence only (see docs/SWIPE-FILE-PIPELINE.md
  -- "Scoring"). An ad with no evidence scores low; it is never guessed up.
  evidence_score    NUMERIC(5,2),
  -- Plain-language statement of what the score is actually built on, e.g.
  -- "412 days continuously running per Meta Ad Library; no spend data available".
  evidence_basis    TEXT NOT NULL,

  extracted_by      TEXT,                 -- model id, or 'human'
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT swipe_patterns_one_per_ad UNIQUE (swipe_ad_id)
);

CREATE INDEX IF NOT EXISTS idx_swipe_patterns_score
  ON public.swipe_patterns (market, evidence_score DESC NULLS LAST);

-- ═══ 3. swipe_hook_candidates — proposals for the doc hook bank ═════════════
-- These NEVER auto-edit docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md. A human moves
-- a row to 'accepted'; scripts/swipe-merge-hook-candidates.js then appends the
-- accepted rows to the playbook's candidate section and marks them 'merged'.

CREATE TABLE IF NOT EXISTS public.swipe_hook_candidates (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_id        UUID REFERENCES public.swipe_patterns(id) ON DELETE SET NULL,

  market            TEXT NOT NULL DEFAULT 'unknown',
  -- A Dossie/Rust/realtor-specific hook written IN OUR VOICE against the
  -- borrowed STRUCTURE. Must survive the swap test and the practitioner test.
  candidate_hook    TEXT NOT NULL,
  -- Which structure it borrows and why it should work for us.
  rationale         TEXT NOT NULL,
  target_brand      TEXT CHECK (target_brand IS NULL OR target_brand IN ('dossie','rust','realtor')),

  evidence_score    NUMERIC(5,2),

  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','accepted','rejected','merged')),
  reviewed_at       TIMESTAMPTZ,
  reviewed_by       TEXT,
  merged_at         TIMESTAMPTZ,
  reject_reason     TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_swipe_hook_candidates_status
  ON public.swipe_hook_candidates (status, created_at DESC);

-- ═══ 4. swipe_inbox — Heath pastes a link ═══════════════════════════════════
-- Server-fetchable links (YouTube, a blog, a Meta Ad Library permalink) are
-- resolved inline. Instagram/LinkedIn/TikTok post URLs are login-walled or
-- bot-blocked server-side, so those park at 'needs_capture' until the browser
-- extension — already signed in as Heath, in his own browser — posts the
-- visible text back. See docs/SWIPE-FILE-PIPELINE.md "Manual swipe inbox".

CREATE TABLE IF NOT EXISTS public.swipe_inbox (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submitted_url     TEXT NOT NULL,
  submitted_by      TEXT,
  note              TEXT,                 -- Heath's one-line "why I sent this"
  platform          TEXT,                 -- instagram / youtube / tiktok / meta_ad_library / web

  status            TEXT NOT NULL DEFAULT 'needs_capture'
                      CHECK (status IN (
                        'needs_capture',  -- waiting on the browser extension
                        'captured',       -- content in hand, not yet analyzed
                        'analyzed',       -- swipe_ad_id populated
                        'failed'
                      )),

  captured_content  TEXT,                 -- visible text the extension scraped
  captured_at       TIMESTAMPTZ,
  captured_by       TEXT,                 -- 'extension' | 'server_fetch' | 'heath'

  swipe_ad_id       UUID REFERENCES public.swipe_ads(id) ON DELETE SET NULL,
  error             TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_swipe_inbox_status
  ON public.swipe_inbox (status, created_at DESC);

-- ═══ 5. RLS — service-role only ═════════════════════════════════════════════
-- No customer ever reads these. Everything goes through service-role code
-- paths (crons, scripts, CRON_SECRET-gated API routes). Enabling RLS with no
-- permissive policy denies anon/authenticated outright while the service role
-- continues to bypass it.

ALTER TABLE public.swipe_ads             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.swipe_patterns        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.swipe_hook_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.swipe_inbox           ENABLE ROW LEVEL SECURITY;

-- ═══ 6. updated_at triggers ═════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.swipe_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_swipe_ads_touch ON public.swipe_ads;
CREATE TRIGGER trg_swipe_ads_touch
  BEFORE UPDATE ON public.swipe_ads
  FOR EACH ROW EXECUTE FUNCTION public.swipe_touch_updated_at();

DROP TRIGGER IF EXISTS trg_swipe_inbox_touch ON public.swipe_inbox;
CREATE TRIGGER trg_swipe_inbox_touch
  BEFORE UPDATE ON public.swipe_inbox
  FOR EACH ROW EXECUTE FUNCTION public.swipe_touch_updated_at();

-- ═══ 7. Digest view — what the Monday brief reads ═══════════════════════════
-- Longest-running first, because on Meta that is the only honest performance
-- signal available for a commercial ad: nobody keeps paying to run a loser.

CREATE OR REPLACE VIEW public.swipe_digest_v AS
SELECT
  a.id,
  a.source,
  a.market,
  a.advertiser,
  a.hook_text,
  a.cta_text,
  a.link,
  a.run_started_on,
  public.swipe_ads_days_running(a.*) AS days_running,
  a.evidence,
  a.evidence_kind,
  a.first_seen,
  a.last_seen,
  p.hook_pattern,
  p.structure,
  p.cta_shape,
  p.hook_type,
  p.evidence_score,
  p.evidence_basis,
  (a.first_seen > NOW() - INTERVAL '7 days') AS is_new_this_week
FROM public.swipe_ads a
LEFT JOIN public.swipe_patterns p ON p.swipe_ad_id = a.id;

COMMENT ON TABLE public.swipe_ads IS
  'Raw swipe-file catch incl. verbatim published copy. FOR STUDY ONLY — the post generator must never read this table; it reads sage_swipe_items/sage_swipe_rules, which are pattern-only by design. See docs/SWIPE-FILE-PIPELINE.md.';
COMMENT ON COLUMN public.swipe_ads.evidence IS
  'Real, source-published numbers only. Never synthesise a metric the source did not give.';
COMMENT ON TABLE public.swipe_hook_candidates IS
  'Proposed hook-bank entries. A human accepts; scripts/swipe-merge-hook-candidates.js then appends to docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md. Nothing here ever silently rewrites the playbook.';
