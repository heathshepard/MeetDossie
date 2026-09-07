-- 20260907_tc_discovery_responses.sql
--
-- Response-capture layer for the TC discovery campaign
-- (docs/TC-DISCOVERY-CAMPAIGN.md, "2026-09-07 EXPANSION" section: 13
-- questions Q1-Q13, ~48 Facebook posts Sep 8-21). Without this table the
-- comments those posts draw live only inside Facebook threads and the
-- campaign produces nothing durable.
--
-- Doctrine (same as reddit_pain_language): comment_text is VERBATIM customer
-- language destined for landing copy. It is never normalized, summarized,
-- truncated, or cleaned. The classification columns (theme, pain_category,
-- sentiment, tags) are nullable and filled during human/agent review later —
-- never forced at write time.
--
-- Idempotency: comment_hash is a stored generated md5 of the verbatim text;
-- (post_url, commenter_name, comment_hash) is UNIQUE, so re-harvesting the
-- same thread can never duplicate a row (per the campaign doc's capture
-- spec: "Unique on (post_url, respondent_name, md5(response_text))").
--
-- Also adds harvest metadata to group_posts (discovery_question_id,
-- last_harvested_at, harvest_count) and backfills discovery_question_id for
-- the four campaign posts already live (Q1 Texas Realtors 9/6, Q2 DFW N&C,
-- Q3 Texas Real Estate Agents, Q4 Texas Transaction Coordinator, all 9/7),
-- matched by their verified live post_body snippets. Nothing else on those
-- rows is touched. Rows queued for the Sep 8-21 calendar must set
-- discovery_question_id at insert time.
--
-- Harvester: scripts/harvest-tc-discovery-responses.js (read-only against
-- Facebook; Windows Task Scheduler cadence — see that file's header).
--
-- Owner: Carter, 2026-09-07

CREATE TABLE IF NOT EXISTS public.tc_discovery_responses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Source post (both a durable FK and the raw permalink; the permalink is
  -- part of the uniqueness key so manual/Reddit rows work without an FK)
  group_post_id     UUID REFERENCES public.group_posts(id) ON DELETE SET NULL,
  post_url          TEXT NOT NULL,
  question_id       TEXT CHECK (question_id ~ '^Q[0-9]{1,2}$'),
  platform          TEXT NOT NULL DEFAULT 'facebook'
                    CHECK (platform IN ('facebook', 'reddit', 'manual')),
  source_group      TEXT,

  -- The response itself. comment_text is VERBATIM — never cleaned.
  commenter_name    TEXT NOT NULL,
  comment_text      TEXT NOT NULL,
  -- Dedupe hash is WHITESPACE-NORMALIZED (collapse runs, trim) because
  -- Facebook renders each comment twice in the DOM with slightly different
  -- whitespace between the two renderings (verified live 2026-09-07 on the
  -- Q2 DFW post — same comment, "me." + 3 spaces vs 1). comment_text itself
  -- stays VERBATIM; only the hash normalizes.
  comment_hash      TEXT GENERATED ALWAYS AS (md5(btrim(regexp_replace(comment_text, '\s+', ' ', 'g')))) STORED,
  comment_permalink TEXT,
  commented_at      TIMESTAMPTZ,          -- best-effort absolute time
  commented_at_raw  TEXT,                 -- FB's rendered timestamp verbatim ("2h", "Yesterday at 3:14 PM")
  is_own_comment    BOOLEAN NOT NULL DEFAULT FALSE,  -- Heath's own replies, captured but flagged

  -- Harvest bookkeeping
  harvested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- first seen
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- bumped on every re-harvest that still sees it

  -- Later-analysis structure — ALL nullable, never populated at write time
  theme             TEXT,
  pain_category     TEXT,
  sentiment         TEXT CHECK (sentiment IN ('positive', 'negative', 'neutral', 'mixed')),
  tags              TEXT[],
  replied           BOOLEAN NOT NULL DEFAULT FALSE,  -- Heath-voice follow-up sent (Section D.3 loop)

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotency backstop: same thread + same commenter + same verbatim text = one row.
ALTER TABLE public.tc_discovery_responses
  DROP CONSTRAINT IF EXISTS tc_discovery_responses_dedupe;
ALTER TABLE public.tc_discovery_responses
  ADD CONSTRAINT tc_discovery_responses_dedupe
  UNIQUE (post_url, commenter_name, comment_hash);

CREATE INDEX IF NOT EXISTS idx_tc_discovery_responses_post
  ON public.tc_discovery_responses (group_post_id);

CREATE INDEX IF NOT EXISTS idx_tc_discovery_responses_question
  ON public.tc_discovery_responses (question_id);

COMMENT ON TABLE public.tc_discovery_responses IS
  'TC discovery campaign responses (docs/TC-DISCOVERY-CAMPAIGN.md). comment_text is VERBATIM agent language for landing copy — never normalize, summarize, truncate, or clean it. Classification columns stay NULL until review.';
COMMENT ON COLUMN public.tc_discovery_responses.comment_text IS
  'VERBATIM comment text as rendered on the platform. The entire point of the table. Never edited.';
COMMENT ON COLUMN public.tc_discovery_responses.comment_hash IS
  'Generated md5 of whitespace-normalized comment_text; part of the dedupe key so re-harvests (and FB''s double-rendered DOM) never duplicate rows. The stored text itself is verbatim.';
COMMENT ON COLUMN public.tc_discovery_responses.commented_at_raw IS
  'The platform''s rendered timestamp exactly as scraped ("2h", "Yesterday at 3:14 PM") — kept because the parsed commented_at is best-effort.';

ALTER TABLE public.tc_discovery_responses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tc_discovery_responses_service_all ON public.tc_discovery_responses;
CREATE POLICY tc_discovery_responses_service_all ON public.tc_discovery_responses
  FOR ALL USING (true) WITH CHECK (true);

-- ── group_posts harvest metadata ────────────────────────────────────────────

ALTER TABLE public.group_posts
  ADD COLUMN IF NOT EXISTS discovery_question_id TEXT
    CHECK (discovery_question_id ~ '^Q[0-9]{1,2}$' OR discovery_question_id IS NULL),
  ADD COLUMN IF NOT EXISTS last_harvested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS harvest_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.group_posts.discovery_question_id IS
  'TC discovery campaign question (Q1-Q13, docs/TC-DISCOVERY-CAMPAIGN.md). Set at queue time for campaign rows (category=tc_discovery_research).';
COMMENT ON COLUMN public.group_posts.last_harvested_at IS
  'Last time scripts/harvest-tc-discovery-responses.js read this post''s comments.';
COMMENT ON COLUMN public.group_posts.harvest_count IS
  'Completed harvest passes; drives the +24h / +72h / every-3-days cadence in the harvester.';

-- Backfill question ids for the four campaign posts already live, matched on
-- their verified live post_body snippets (scripts/.sage-tc-day3-verify.json).
UPDATE public.group_posts SET discovery_question_id = 'Q1'
  WHERE category = 'tc_discovery_research' AND discovery_question_id IS NULL
    AND post_body LIKE '%when you have hired a TC or thought about it%';
UPDATE public.group_posts SET discovery_question_id = 'Q2'
  WHERE category = 'tc_discovery_research' AND discovery_question_id IS NULL
    AND post_body LIKE '%drove you the most crazy%';
UPDATE public.group_posts SET discovery_question_id = 'Q3'
  WHERE category = 'tc_discovery_research' AND discovery_question_id IS NULL
    AND post_body LIKE '%make your TC do ONE thing%';
UPDATE public.group_posts SET discovery_question_id = 'Q4'
  WHERE category = 'tc_discovery_research' AND discovery_question_id IS NULL
    AND post_body LIKE '%what TC software or platform%';
-- Sep-8 calendar rows already queued at migration time (variant-A copy):
UPDATE public.group_posts SET discovery_question_id = 'Q6'
  WHERE category = 'tc_discovery_research' AND discovery_question_id IS NULL
    AND post_body LIKE '%what do y''all actually pay%';
UPDATE public.group_posts SET discovery_question_id = 'Q8'
  WHERE category = 'tc_discovery_research' AND discovery_question_id IS NULL
    AND post_body LIKE '%fired a TC or switched to a new one%';
