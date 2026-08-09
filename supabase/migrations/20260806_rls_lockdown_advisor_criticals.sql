-- 20260806_rls_lockdown_advisor_criticals.sql
-- =============================================================================
-- Fixes all 6 CRITICAL findings from Supabase's security advisor (get_advisors).
-- Applied live via Management API 2026-08-06 by Atlas; this file documents the
-- change in migration history (matches existing repo convention).
--
-- 1. RLS was DISABLED on 4 internal agent/content-pipeline tables, meaning the
--    public anon API key had full CRUD (grants confirmed: anon/authenticated
--    had INSERT/SELECT/UPDATE/DELETE/TRUNCATE on all 4 via PostgREST default
--    schema grants). All 4 are written/read exclusively server-side via
--    SUPABASE_SERVICE_ROLE_KEY (cron-trending-audio-scan.js,
--    cron-competitor-scan-weekly.js, cron-comment-monitor.js,
--    cron-weekly-post-review.js + their claude-code-task-handlers). No
--    client-side/anon-key usage found anywhere in the repo.
--
--    Fix: ENABLE ROW LEVEL SECURITY with zero policies — this is the existing
--    convention already used on ~40 other internal tables in this schema
--    (agent_queue, agent_dispatch_queue, cron_notifications, sms_messages,
--    stripe_webhook_events, etc). RLS-enabled + no policy = deny-by-default for
--    anon/authenticated; service_role bypasses RLS at the Postgres level
--    (BYPASSRLS), so crons are unaffected.
--
-- 2. `agent_queue_ready` and `heath_todo_ready` views were flagged
--    "Security Definer View" — neither migration (20260617_agent_queue.sql,
--    20260617_heath_todo.sql) explicitly declared this; it's Postgres/Supabase's
--    default view behavior (views run as owner unless security_invoker is set,
--    PG15+ only). Underlying tables (agent_queue, heath_todo) both have RLS
--    enabled with no policies and are read exclusively via SERVICE_ROLE_KEY
--    (api/agent-queue-*.js, api/heath-todo-*.js, api/cron-agent-queue-*.js).
--
--    Fix: SET (security_invoker = true) so the view now enforces the querying
--    role's own RLS instead of the owner's — matches Supabase's documented
--    recommended default.
--
-- Verified post-fix: get_advisors security scan clears from 6 ERROR-level
-- findings to 0. Anon key confirmed via live REST call to return `[]` on all
-- 6 objects (previously would have returned real rows on the 4 tables).
-- Service-role path confirmed still reading real data (507/13/0/0 rows on the
-- 4 tables, 0/25 rows through the 2 views) — nothing broken.
--
-- NOT included here (reported separately, not a quick/safe change):
-- `public.transactions` has 7 overlapping RLS policies triggering both
-- auth_rls_initplan (auth.uid() not wrapped in `(select ...)`) and
-- multiple_permissive_policies (redundant policies stacked across migrations:
-- "users can view own transactions", "Users can manage own transactions",
-- own_transactions, org_admin_select_transactions, "Service role bypass
-- transactions", etc). Rewriting safely requires reading and consolidating
-- all 7 policy definitions, not a one-line auth.uid() wrap — needs its own
-- pass with a real access-pattern review, not appropriate to batch into this
-- security-critical, post-outage fix.
-- =============================================================================

ALTER TABLE public.trending_audio ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.competitor_tracked_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_comment_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sage_weekly_reviews ENABLE ROW LEVEL SECURITY;

ALTER VIEW public.agent_queue_ready SET (security_invoker = true);
ALTER VIEW public.heath_todo_ready SET (security_invoker = true);
