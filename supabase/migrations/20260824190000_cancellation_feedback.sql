-- Exit-survey capture for the self-serve Cancel Subscription flow
-- (api/cancel-subscription.js), rebuilt 2026-08-24 after the Settings-tab
-- control regressed out of the app. Prompted by Heath, 2026-08-24 — a real
-- founding customer (Amanda Nuckles) has been unreachable by text/email/phone;
-- the cancel flow itself is likely the only feedback channel he'll ever get
-- from her, and he wants it captured for every cancelling customer going
-- forward, not just her.
--
-- Written unconditionally on every cancel attempt (before the Stripe call),
-- not only on a successful cancellation, so a Stripe/lookup failure never
-- loses feedback the customer already typed. reason/reason_detail/
-- what_would_have_kept_them are all optional — the survey is 2 short
-- questions and must never block or gate the actual cancellation.

CREATE TABLE IF NOT EXISTS public.cancellation_feedback (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email                       TEXT,
  reason                      TEXT, -- one of a fixed option set, see api/cancel-subscription.js REASON_OPTIONS; free text also accepted defensively
  reason_detail               TEXT,
  what_would_have_kept_them   TEXT,
  subscription_cancelled      BOOLEAN NOT NULL DEFAULT false, -- true only once the Stripe cancel_at_period_end call actually succeeded
  cancelled_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.cancellation_feedback IS
  'Exit-survey answers submitted from the Settings > Billing > Cancel Subscription flow. One row per cancel attempt (regardless of whether the Stripe cancellation itself succeeded) so feedback is never lost to a billing-side error. Read directly by Heath — also relayed live via the existing Telegram cancellation notification in api/cancel-subscription.js.';

CREATE INDEX IF NOT EXISTS idx_cancellation_feedback_user
  ON public.cancellation_feedback (user_id, cancelled_at DESC);

ALTER TABLE public.cancellation_feedback ENABLE ROW LEVEL SECURITY;

-- No SELECT/INSERT policy for anon/authenticated — this table is written and
-- read exclusively via the service-role key from api/cancel-subscription.js
-- and by Heath directly in the Supabase dashboard. RLS with zero policies
-- means "deny all" for any non-service-role caller, which is the intent:
-- customers should never be able to read each other's (or anyone's) exit
-- survey answers through a client-side query.
