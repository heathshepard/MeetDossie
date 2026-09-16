-- 20260916_auto_reply_veto.sql
--
-- Auto-reply-with-veto for LOW-RISK comments only. Heath's explicit approval,
-- 2026-09-16, to hit a 1-hour reply SLA on the TC discovery comment-reply
-- loop (tc_discovery_responses / api/cron-tc-reply-approval.js).
--
-- SCOPED EXCEPTION, NOT A REVERSAL: the 20260908b migration explicitly noted
-- that fb_comment_replies' old "auto-post after a 10-minute timeout" pattern
-- was forbidden ("nothing may post without explicit approval"). This is a
-- narrower, heavily-gated re-introduction of that shape for ONE risk tier:
--   - a deterministic, fail-closed risk classifier
--     (scripts/_lib/auto-reply-risk-classifier.js) must independently score
--     the comment+draft as low-risk, or it never enters this path at all;
--   - content gates (scripts/_lib/auto-reply-content-gates.js) must pass on
--     the draft (no pricing figures, no unverified war story, no
--     unverified Dossie capability claim, no AI-tell opener, in-range
--     length) or it routes to the existing manual Approve/Edit/Skip flow;
--   - a global kill switch (scripts/_lib/auto-reply-kill-switch.js), OFF by
--     default, gates the entire feature independent of the classifier;
--   - every auto-reply is logged with its classification + gate results.
-- Any row that fails ANY of the above still goes through the pre-existing
-- 'notified' -> Approve/Edit/Skip loop, unchanged.
--
-- New reply_status value: 'pending_veto' — drafted, classified low-risk,
-- gates passed, kill switch on, Telegram STOP-button message delivered,
-- waiting out a 10-minute veto window (veto_deadline_at). Two outcomes:
--   - Heath taps STOP (api/telegram-webhook.js autoreply_stop:<id>) before
--     the deadline -> 'skipped', reply_error='vetoed_by_heath'. Terminal.
--   - api/cron-auto-reply-veto-check.js finds veto_deadline_at elapsed with
--     no STOP tap -> 'approved' (auto_approved=true). From there it is
--     INDISTINGUISHABLE from a manually-approved row: same
--     scripts/fb-group-commenter.js --tc-reply-queue poster, same
--     facebook_reply cap/min-gap, same posting/posted/post_failed states.
--
-- Owner: Carter, 2026-09-16

ALTER TABLE public.tc_discovery_responses
  DROP CONSTRAINT IF EXISTS tc_discovery_responses_reply_status_check;
ALTER TABLE public.tc_discovery_responses
  ADD CONSTRAINT tc_discovery_responses_reply_status_check
  CHECK (reply_status IN ('new','flagged','notified','pending_veto','approved','skipped','posting','posted','post_failed'));

ALTER TABLE public.tc_discovery_responses
  ADD COLUMN IF NOT EXISTS auto_reply_eligible BOOLEAN,
  ADD COLUMN IF NOT EXISTS auto_reply_category TEXT,
  ADD COLUMN IF NOT EXISTS auto_reply_gate_failures TEXT[],
  ADD COLUMN IF NOT EXISTS veto_deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_approved BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sla_alerted_at TIMESTAMPTZ;

COMMENT ON COLUMN public.tc_discovery_responses.auto_reply_eligible IS
  'Output of scripts/_lib/auto-reply-risk-classifier.js at draft time. NULL = not evaluated (e.g. hostile/flagged rows, or evaluated before this column existed).';
COMMENT ON COLUMN public.tc_discovery_responses.auto_reply_category IS
  'Risk classifier category: auto_eligible, or an escalate reason (pricing, demo_request, complaint, legal_compliance, specific_client, contact_request, competitor_mention, low_confidence).';
COMMENT ON COLUMN public.tc_discovery_responses.auto_reply_gate_failures IS
  'Content-gate failure codes from scripts/_lib/auto-reply-content-gates.js when the draft failed one or more gates (pricing_figure, unverified_war_story, unverified_capability_claim, voice_violation, length_out_of_range). Empty array = all gates passed.';
COMMENT ON COLUMN public.tc_discovery_responses.veto_deadline_at IS
  'For reply_status=pending_veto: the instant api/cron-auto-reply-veto-check.js may auto-approve this row if no STOP tap has landed. Set to notified_at + 10 minutes.';
COMMENT ON COLUMN public.tc_discovery_responses.auto_approved IS
  'TRUE when this row reached approved via the veto-timeout path (no Heath tap), not a manual Approve/edit. Audit trail only — the poster treats it identically to a manual approval, except the kill-switch defense-in-depth check in fb-group-commenter.js.';
COMMENT ON COLUMN public.tc_discovery_responses.sla_alerted_at IS
  'Stamped once api/cron-auto-reply-veto-check.js has alerted Heath that this comment sat unanswered past the 60-minute SLA, so the alert fires exactly once per row.';

CREATE INDEX IF NOT EXISTS idx_tc_discovery_responses_pending_veto
  ON public.tc_discovery_responses (veto_deadline_at)
  WHERE reply_status = 'pending_veto';

CREATE INDEX IF NOT EXISTS idx_tc_discovery_responses_sla_watch
  ON public.tc_discovery_responses (harvested_at)
  WHERE sla_alerted_at IS NULL AND reply_status IN ('new','flagged','notified','pending_veto');
