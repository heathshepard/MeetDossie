-- 20260918_account_invites_and_lifecycle_log.sql
--
-- WHY
--   docs/ACTIVATION-FORENSICS-2026-09-18.md: every Dossie account is
--   provisioned server-side with a random 48-char scratch password nobody ever
--   sees, and the customer's ONLY credential is a single Supabase recovery link
--   that expires in 1 hour. Three paying customers never set a password at all
--   (auth.users.updated_at == recovery_sent_at, no later mutation) -- they had
--   no usable way in, ever.
--
--   Second defect from the same doc: ten profiles carry a byte-identical
--   microsecond timestamp across all three activation_email_*_sent_at columns.
--   That can only come from one `UPDATE ... = now()`. The columns are a
--   backfill, not a record of sends, and they permanently suppress the drip.
--   A boolean-ish timestamp column on `profiles` cannot tell "sent" from
--   "someone ran an UPDATE" -- there is no room in it for provenance.
--
-- WHAT
--   1. account_invites  -- a DURABLE invite credential we own, decoupled from
--      GoTrue's 1-hour link. The emailed URL carries our token; clicking it
--      mints a FRESH Supabase recovery link at click time (api/invite.js), so
--      the short-lived window only ever opens when the person is actually
--      there. Missing the window becomes impossible; losing the email is
--      recoverable via /api/invite-resend without a human.
--
--   2. lifecycle_email_log -- an append-only ledger of outbound lifecycle
--      email. A row exists ONLY when Resend accepted a message and returned an
--      id. From here on, "genuinely sent" means "has a ledger row with a
--      resend_message_id"; a profiles.* timestamp with no ledger row is, by
--      construction, a backfill. Provenance lives in the ledger, not in a
--      nullable timestamp.
--
-- SAFETY
--   Purely additive. Two new empty tables. No existing table is altered, no
--   row is written, updated or deleted. Applying this migration cannot cause
--   any email to be sent and does not by itself change any running behavior --
--   the code that reads these tables degrades to today's behavior when they
--   are empty or absent.
--
--   RLS is ENABLED with NO policies on both tables: every reader/writer is
--   service-role (API routes + crons), which bypasses RLS. This is the same
--   posture as supabase/migrations/20260914_telegram_alerts_rls.sql and
--   deliberately denies the anon/publishable key, which otherwise inherits
--   full CRUD from Postgres's default public-schema grants. An invite token
--   hash readable by the anon key would be an account-takeover primitive.
--
-- Owner: 2026-09-18.

-- ---------------------------------------------------------------------------
-- 1. account_invites
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.account_invites (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email             text NOT NULL,

  -- SHA-256 hex of the raw token. The raw token exists in exactly two places:
  -- the URL in the customer's email, and memory during the request that
  -- created it. It is never logged and never stored. A database leak therefore
  -- does not hand anyone a working invite.
  token_hash        text NOT NULL UNIQUE,

  -- Which provisioning path minted this: 'stripe_webhook' | 'signup' |
  -- 'complete_onboarding' | 'self_service' | 'admin_resend'.
  source            text NOT NULL,

  created_at        timestamptz NOT NULL DEFAULT now(),

  -- 30 days by default, vs GoTrue's 1 hour. Long enough that a customer who
  -- reads email on Sunday, or whose IT quarantines Friday's mail, still has a
  -- working credential -- and short enough that a forwarded old email is not
  -- a permanent backdoor.
  expires_at        timestamptz NOT NULL DEFAULT (now() + interval '30 days'),

  -- Set the first time the invite is exchanged for a live session. NOT a hard
  -- stop: see redeem_count. A customer who clicks, gets distracted, and clicks
  -- again an hour later must still get in -- that exact dead end is what
  -- stranded Terry Katz (one 42-second session, never completed the form).
  consumed_at       timestamptz,
  redeem_count      integer NOT NULL DEFAULT 0,
  last_redeemed_at  timestamptz,

  -- Set when Resend accepts the invite email. NULL here with a row present
  -- means "invite minted, delivery never confirmed" -- an alertable state, and
  -- the one the old code could not represent at all.
  email_sent_at     timestamptz,
  resend_message_id text,

  -- Set by /api/invite once the customer actually sets a password, so the
  -- invite stops being a live credential the moment it is no longer needed.
  completed_at      timestamptz,

  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS account_invites_user_id_idx
  ON public.account_invites (user_id);

CREATE INDEX IF NOT EXISTS account_invites_email_lower_idx
  ON public.account_invites (lower(email));

-- Supports "find this user's live invite" and the expiry sweep.
CREATE INDEX IF NOT EXISTS account_invites_live_idx
  ON public.account_invites (expires_at)
  WHERE completed_at IS NULL;

ALTER TABLE public.account_invites ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.account_invites IS
  'Durable, resendable account-invite credentials. Replaces the single 1-hour Supabase recovery link as the sole way into a server-provisioned account. See docs/ACTIVATION-FORENSICS-2026-09-18.md.';

-- ---------------------------------------------------------------------------
-- 2. lifecycle_email_log
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.lifecycle_email_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  email             text NOT NULL,

  -- 'activation' | 'referral' | 'invite'
  sequence          text NOT NULL,
  -- 'email_1' | 'email_2' | 'email_3' | 'referral_ask' | 'invite' | 'invite_resend'
  step              text NOT NULL,

  sent_at           timestamptz NOT NULL DEFAULT now(),

  -- The proof. A row without this is not evidence of delivery and callers
  -- treat it as such.
  resend_message_id text,

  -- Which code path sent it, e.g. 'cron-activation-drip', 'api/invite-resend'.
  source            text NOT NULL,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Idempotency: a given user can only ever hold one ledger row per sequence
-- step. A retried cron run cannot double-send, and an INSERT conflict is a
-- reliable "already sent" signal that does not depend on profiles.*.
CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_email_log_user_step_key
  ON public.lifecycle_email_log (user_id, sequence, step)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS lifecycle_email_log_sent_at_idx
  ON public.lifecycle_email_log (sent_at DESC);

ALTER TABLE public.lifecycle_email_log ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.lifecycle_email_log IS
  'Append-only ledger of outbound lifecycle email. A row is written ONLY when Resend accepted the message. Distinguishes a genuine send from a profiles.* timestamp backfill.';
