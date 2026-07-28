-- Migration: Sage Content Engine — hook bank, swipe file, filming briefs, performance log
-- Purpose: Support Sage's weekly filming brief generator, hook bank with performance
--          tracking, swipe-file system with decay/pruning, and Editor's feedback loop.

-- Hook bank: tested opening lines tagged by pillar, account, platform
CREATE TABLE IF NOT EXISTS public.sage_hook_bank (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hook TEXT NOT NULL,
  pillar TEXT NOT NULL CHECK (pillar IN ('educational', 'hyper-local', 'personal-brand', 'social-proof', 'listings')),
  account TEXT NOT NULL DEFAULT 'dossie' CHECK (account IN ('dossie', 'real-estate', 'workout-app')),
  platform TEXT,
  status TEXT NOT NULL DEFAULT 'untested' CHECK (status IN ('untested', 'tested', 'proven', 'retired')),
  times_used INTEGER NOT NULL DEFAULT 0,
  avg_performance NUMERIC(5,2),
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Swipe-file watchlist: creators tracked for marketing craft
CREATE TABLE IF NOT EXISTS public.sage_swipe_watchlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  handle TEXT,
  reason TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Swipe-file rules: distilled rules from approved swipe items
CREATE TABLE IF NOT EXISTS public.sage_swipe_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_text TEXT NOT NULL,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('copywriting', 'hook-format', 'trend', 'edit-technique', 'cta-pattern')),
  source_creator TEXT,
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'declining', 'expired', 'superseded')),
  superseded_by UUID REFERENCES public.sage_swipe_rules(id),
  date_added TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  times_used INTEGER NOT NULL DEFAULT 0,
  avg_performance NUMERIC(5,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Swipe-file digest items: raw items surfaced from watched creators
CREATE TABLE IF NOT EXISTS public.sage_swipe_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  watchlist_id UUID REFERENCES public.sage_swipe_watchlist(id),
  creator_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  post_url TEXT,
  post_text TEXT,
  engagement_score NUMERIC(10,2),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  distilled_rule_id UUID REFERENCES public.sage_swipe_rules(id),
  surfaced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ
);

-- Weekly filming briefs
CREATE TABLE IF NOT EXISTS public.sage_filming_briefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start DATE NOT NULL,
  brief_json JSONB NOT NULL,
  trend_data JSONB,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'completed')),
  telegram_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Performance log: per-post metrics tagged to hooks and edit styles
CREATE TABLE IF NOT EXISTS public.sage_performance_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID,
  platform TEXT NOT NULL,
  account TEXT NOT NULL DEFAULT 'dossie' CHECK (account IN ('dossie', 'real-estate', 'workout-app')),
  pillar TEXT,
  hook_id UUID REFERENCES public.sage_hook_bank(id),
  edit_style TEXT,
  views INTEGER,
  watch_through_rate NUMERIC(5,4),
  saves INTEGER,
  shares INTEGER,
  comments INTEGER,
  link_clicks INTEGER,
  completion_rate NUMERIC(5,4),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_hook_bank_pillar_status ON public.sage_hook_bank(pillar, status);
CREATE INDEX IF NOT EXISTS idx_hook_bank_account ON public.sage_hook_bank(account);
CREATE INDEX IF NOT EXISTS idx_swipe_rules_status ON public.sage_swipe_rules(status);
CREATE INDEX IF NOT EXISTS idx_swipe_items_status ON public.sage_swipe_items(status);
CREATE INDEX IF NOT EXISTS idx_filming_briefs_week ON public.sage_filming_briefs(week_start);
CREATE INDEX IF NOT EXISTS idx_performance_log_post ON public.sage_performance_log(post_id);
CREATE INDEX IF NOT EXISTS idx_performance_log_hook ON public.sage_performance_log(hook_id);

-- RLS: service-role only (these are internal agent tables, not user-facing)
ALTER TABLE public.sage_hook_bank ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sage_swipe_watchlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sage_swipe_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sage_swipe_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sage_filming_briefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sage_performance_log ENABLE ROW LEVEL SECURITY;
