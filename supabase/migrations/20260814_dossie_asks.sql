-- ============================================================================
-- dossie_asks — the "Dossie asks" action-card feed at the top of the app home
-- (Morning Brief) screen.
--
-- WHAT THIS IS NOT: a chat log. In a chat, if Dossie raises four things and the
-- agent answers two, the other two scroll away and die. These are deal-critical
-- asks with real deadlines, so each one is a ROW with a status that persists
-- until it is actually resolved or dismissed. Conversational replies are
-- supported (see `thread`), but the card — not the message — is the unit of
-- state.
--
-- Multi-tenant. Unlike jarvis_todos / jarvis_balls (single-tenant Heath-only
-- HUD tables that scope RLS to `auth.role() = 'authenticated'`), this table is
-- customer-facing and rides alongside public.transactions, so RLS scopes to
-- `auth.uid() = user_id`. Do not copy the jarvis_* policy shape here — it would
-- expose every agent's asks to every other agent.
--
-- Ask GENERATION (reading inboxes/deadlines and creating rows automatically) is
-- deliberately NOT part of this migration. This pass is the surface, the data
-- model, and the interaction. Rows are inserted by service_role for now.
--
-- Owner: Carter (SV-ENG-DOSSIE-ASKS / 2026-08-14)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.dossie_asks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenancy. user_id is the agent who sees the card.
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- The deal this ask belongs to. Nullable: a few asks are account-level
  -- ("your IABS is missing"), not deal-level. Card renders without a deal
  -- chip in that case.
  transaction_id    UUID REFERENCES public.transactions(id) ON DELETE CASCADE,

  -- Consequence half of the ordering. See dossie_ask_score() below.
  urgency           TEXT NOT NULL DEFAULT 'normal'
                      CHECK (urgency IN ('critical', 'high', 'normal', 'low')),

  -- Short headline. NOT the deal address — the UI renders the address from the
  -- joined transaction so it can never drift out of sync with the record.
  title             TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),

  -- The ask itself, in plain conversational language, INCLUDING the
  -- consequence — not just the fact. "The Lintons haven't signed and the
  -- option expires in 9 hours" beats "amendment unsigned".
  body              TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),

  -- Clock half of the ordering. Nullable — not every ask has a deadline.
  due_at            TIMESTAMPTZ,
  -- Human-facing deadline caption, e.g. "option ends 5:00 PM". Kept separate
  -- from due_at so copy can stay warm without the UI re-deriving phrasing.
  due_label         TEXT,

  -- 2-3 quick-action buttons: [{ "id": "draft", "label": "Draft it",
  -- "kind": "primary" }]. Free-text reply is always available regardless.
  suggested_actions JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Conversation captured against THIS card, so a reply can never orphan
  -- itself from the ask it answers:
  -- [{ "at": iso, "role": "agent"|"dossie", "text": "...", "action_id": "..." }]
  thread            JSONB NOT NULL DEFAULT '[]'::jsonb,

  status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'snoozed', 'resolved', 'dismissed')),

  -- Which quick action (or 'free_text') closed it, plus the agent's own words.
  resolution        TEXT,
  resolution_note   TEXT,
  resolved_at       TIMESTAMPTZ,
  snoozed_until     TIMESTAMPTZ,

  -- Provenance. 'dossie' = she raised it, 'system' = rule/cron, 'agent' = the
  -- human added it themselves. Free-text `source` records the specific origin
  -- (e.g. 'seed:wild-cherry-option', later 'email:<message_id>').
  created_by        TEXT NOT NULL DEFAULT 'dossie'
                      CHECK (created_by IN ('dossie', 'system', 'agent')),
  source            TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.dossie_asks IS
  'Persistent, prioritized action cards shown at the top of the app home page. Each row survives until resolved/dismissed — deliberately not a chat log, so deal-critical asks cannot scroll away unanswered.';
COMMENT ON COLUMN public.dossie_asks.body IS
  'The ask in plain language INCLUDING the consequence of inaction, not just the fact. This is the whole point of the surface.';
COMMENT ON COLUMN public.dossie_asks.suggested_actions IS
  'JSON array of 2-3 quick actions: [{id,label,kind}]. kind is primary|secondary|done and only drives styling.';
COMMENT ON COLUMN public.dossie_asks.thread IS
  'Replies captured against this specific card, newest last. Keeps a conversational answer bound to the ask it resolves.';
COMMENT ON COLUMN public.dossie_asks.status IS
  'open | snoozed | resolved | dismissed. Only open (and snoozed past snoozed_until) rows are surfaced.';

-- Feed query: this table is always read as "my open asks, most consequential
-- first", so index the exact predicate.
CREATE INDEX IF NOT EXISTS idx_dossie_asks_feed
  ON public.dossie_asks (user_id, status, due_at NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_dossie_asks_transaction
  ON public.dossie_asks (transaction_id)
  WHERE transaction_id IS NOT NULL;

-- Keep updated_at honest even for writers that only touch status/thread.
CREATE OR REPLACE FUNCTION public.dossie_asks_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dossie_asks_touch_updated_at ON public.dossie_asks;
CREATE TRIGGER trg_dossie_asks_touch_updated_at
  BEFORE UPDATE ON public.dossie_asks
  FOR EACH ROW EXECUTE FUNCTION public.dossie_asks_touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — per-agent. auth.uid() wrapped in (select ...) per the 2026-08-06
-- advisor lockdown convention to avoid the auth_rls_initplan warning.
-- service_role bypasses RLS at the Postgres level and is what inserts asks.
-- ---------------------------------------------------------------------------
ALTER TABLE public.dossie_asks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own dossie_asks"   ON public.dossie_asks;
DROP POLICY IF EXISTS "Users can insert their own dossie_asks" ON public.dossie_asks;
DROP POLICY IF EXISTS "Users can update their own dossie_asks" ON public.dossie_asks;
DROP POLICY IF EXISTS "Users can delete their own dossie_asks" ON public.dossie_asks;

CREATE POLICY "Users can view their own dossie_asks"
  ON public.dossie_asks FOR SELECT
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert their own dossie_asks"
  ON public.dossie_asks FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update their own dossie_asks"
  ON public.dossie_asks FOR UPDATE
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete their own dossie_asks"
  ON public.dossie_asks FOR DELETE
  USING ((select auth.uid()) = user_id);
