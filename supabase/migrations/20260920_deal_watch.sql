-- 20260920_deal_watch.sql
--
-- THE CASE THIS EXISTS TO PREVENT
--   2026-09, 23 Nopalito (transaction 952e0d82, a live $1,295,000 listing):
--   the seller replied to Heath answering the single biggest open question on
--   the file — whether stale tax exemptions would cost them up to $20,000 at
--   closing. Dossie said nothing. Not because she could not read the mailbox
--   (api/_lib/inbox-tools.js shipped this week and works), but because
--   NOTHING RUNS ON A SCHEDULE THAT LOOKS. A coordinator's actual job is
--   noticing, and no code in this repo was doing it.
--
--   The forensics on that row are worth keeping, because they set the design:
--   23 Nopalito has parties = '{}' and every counterparty email column NULL.
--   cron-email-to-dossier.js files an inbound email onto a deal only on an
--   EXACT From-address match against a counterparty already on that deal. A
--   deal with no addresses on file can never match, so the reply was never
--   filed, so there was never anything for a watcher to find. That is why
--   `missing_contacts` is a first-class observation below and not an
--   afterthought: the most valuable thing the watcher can say about that file
--   is "I cannot see this deal at all, and here is why."
--
-- WHAT THIS PROVISIONS
--   public.deal_watch_log   — one row per FACT the watcher has ever formed an
--                             opinion about, per member.
--   public.deal_watch_state — one row per member: the baseline timestamp and
--                             last-run bookkeeping.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY UNIQUE (user_id, fact_key) IS THE WHOLE DESIGN
--
--   Alert fatigue is the only thing that can kill this feature. A watcher that
--   speaks every morning is trained out inside a week, and then it is WORSE
--   than nothing because it looks like coverage while being ignored.
--
--   This repo already learned that lesson the expensive way. The daily
--   regression suite alerted on RED unconditionally while being RED for two
--   solid months — identical failure set, every single day. The fix
--   (api/_lib/regression-alert-policy.js) was delta-based: speak when the
--   failure SET CHANGES, plus a low-frequency still-failing reminder. Replayed
--   against real data that produced 2 alerts instead of 12.
--
--   The same discipline is applied here, and the database enforces it rather
--   than a code path that remembers to check. `fact_key` is a stable string
--   identifying one fact about one deal ("the other agent has not returned the
--   amendment on deal X"). UNIQUE (user_id, fact_key) means that fact can be
--   spoken AT MOST ONCE, EVER, per member. "Wesley still hasn't sent it" every
--   morning for six days is structurally impossible, not merely unlikely.
--
--   The fact_key deliberately INCLUDES the consequence tier
--   (`awaiting:<deal>:<party>:high`). That is what allows the one escalation
--   that is actually the product: an item that was routine while the option
--   period was three weeks out becomes urgent when it is three days out. Those
--   are two different fact_keys, so each still speaks exactly once, and the
--   member hears "Wesley hasn't sent it and the option ends Monday" at the
--   moment it matters instead of six times beforehand.
--
-- WHY A BASELINE ROW EXISTS (deal_watch_state.baseline_at)
--
--   Measured against live data on 2026-09-20, a watcher with no baseline would
--   have opened by sending 26 deadline alerts in a single message — 9 expired
--   option periods and 17 past closing dates — on a dataset where 52 of 64
--   active deals had not been touched in 30 days and 8 closings were more than
--   a month stale. That is the regression-suite failure reproduced exactly: a
--   first impression of pure noise, on data the member had already moved past.
--
--   So the first run for a member SEEDS rather than speaks. Every fact true at
--   that moment is written with outcome='baseline' and the member hears
--   nothing. Only facts that become true AFTER baseline_at can ever be spoken.
--   The watcher earns the right to talk by first proving it can stay quiet.
--
-- Owner: 2026-09-20.

-- ─────────────────────────────────────────────────────────────────────────────
-- deal_watch_state — per-member baseline + run bookkeeping
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.deal_watch_state (
  user_id          UUID PRIMARY KEY,

  -- The moment this member was seeded. NULL is impossible (NOT NULL): a row
  -- existing AT ALL means the baseline pass completed. The watcher checks for
  -- the row, not for a boolean somebody could set optimistically.
  baseline_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  baseline_facts   INTEGER NOT NULL DEFAULT 0,

  last_run_at      TIMESTAMPTZ,
  last_run_status  TEXT,
  last_run_notes   TEXT,
  facts_spoken_last_run INTEGER NOT NULL DEFAULT 0,

  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.deal_watch_state IS
  'One row per member watched by api/cron-deal-watch.js. The row''s EXISTENCE is the baseline guarantee: no row = never seeded = this run seeds silently and speaks nothing. baseline_at is the cutoff; only facts observed after it are eligible to be spoken.';
COMMENT ON COLUMN public.deal_watch_state.baseline_at IS
  'Facts already true when the watcher first saw this member were recorded, not announced. Nothing observed at or before this timestamp can ever be spoken — this is what stops a day-one flood of pre-existing backlog (26 stale deadline hits, measured on live data 2026-09-20).';

-- ─────────────────────────────────────────────────────────────────────────────
-- deal_watch_log — one row per fact, ever
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.deal_watch_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- TENANT. Every read the watcher performs is scoped to this member, and
  -- every row it writes carries them. A watcher that crossed tenants would
  -- surface one agent's client correspondence to another agent; the column is
  -- NOT NULL and part of the uniqueness key so a cross-tenant row is not
  -- merely wrong but unrepresentable.
  user_id          UUID NOT NULL,
  transaction_id   UUID NOT NULL,

  -- Stable identity of ONE fact about ONE deal, including its consequence
  -- tier. See the header: this is the "say it once" key.
  fact_key         TEXT NOT NULL,

  kind             TEXT NOT NULL CHECK (kind IN (
                     'party_reply',        -- a party wrote in on a live file
                     'awaiting_delivery',  -- someone owes something, undelivered
                     'document_arrived',   -- signed/executed doc landed
                     'missing_required',   -- file lacks something it should have
                     'missing_contacts'    -- deal is unwatchable: no addresses on file
                   )),

  consequence      TEXT NOT NULL CHECK (consequence IN ('critical', 'high', 'normal', 'low')),

  -- When the underlying REAL-WORLD event happened (the email's own date, the
  -- signature request's created_at), NOT when the cron noticed it. Ranking and
  -- the baseline cutoff both key off this.
  observed_at      TIMESTAMPTZ,

  headline         TEXT NOT NULL,
  detail           TEXT,

  -- Plain-language deadline the fact threatens, if any. This is what turns
  -- "Wesley hasn't sent it" into "Wesley hasn't sent it and the option ends
  -- Monday" — the difference between noise and the product.
  deadline_label   TEXT,
  deadline_date    DATE,
  days_to_deadline INTEGER,

  outcome          TEXT NOT NULL CHECK (outcome IN (
                     'baseline',              -- true at seeding; recorded, never announced
                     'spoken',                -- delivered; provider id recorded
                     'dry_run',               -- composed + validated, deliberately not sent
                     'skipped_disabled',      -- ops_flags switch off (the default state)
                     'skipped_below_threshold', -- real, but not worth interrupting a day for
                     'skipped_dormant',       -- stale fact on a deal nobody has touched
                     'skipped_capped',        -- over the per-member per-run speaking cap
                     'failed'                 -- send attempted, provider rejected
                   )),
  suppressed_reason TEXT,

  -- EVIDENCE, not optimism. 2026-09-18 activation forensics found ten profiles
  -- flagged as emailed that were never emailed — a boolean set next to code
  -- that failed silently. The CHECK below makes that shape illegal here:
  -- "spoken" can only ever mean "Telegram handed us back a message id".
  telegram_message_id TEXT,
  spoken_at        TIMESTAMPTZ,
  send_error       TEXT,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- SAY IT ONCE. Per member, per fact, forever. Enforced by Postgres.
  CONSTRAINT deal_watch_log_user_fact_uniq UNIQUE (user_id, fact_key),

  CONSTRAINT deal_watch_log_spoken_needs_evidence CHECK (
    outcome <> 'spoken'
    OR (telegram_message_id IS NOT NULL AND spoken_at IS NOT NULL)
  )
);

COMMENT ON TABLE public.deal_watch_log IS
  'One row per fact api/cron-deal-watch.js has ever formed an opinion about. UNIQUE(user_id, fact_key) is the anti-fatigue guarantee: a given fact is announced at most once per member, ever. outcome=''baseline'' rows are facts that were already true when the member was first seeded — recorded so they can never be re-announced as news.';
COMMENT ON COLUMN public.deal_watch_log.fact_key IS
  'Stable per-fact identity INCLUDING the consequence tier, e.g. awaiting:<txid>:<party-hash>:high. Including the tier is deliberate: it permits exactly one re-speak when a routine item escalates because a deadline approached, while still guaranteeing each (fact, tier) is said only once.';
COMMENT ON COLUMN public.deal_watch_log.telegram_message_id IS
  'Telegram''s own id for the delivered notification. NULL means nothing reached the member, regardless of what any other column says.';
COMMENT ON COLUMN public.deal_watch_log.observed_at IS
  'When the real-world event happened (email date, signature-request creation) — never when the cron ran. Compared against deal_watch_state.baseline_at to decide eligibility.';

CREATE INDEX IF NOT EXISTS idx_deal_watch_log_user_created
  ON public.deal_watch_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deal_watch_log_transaction
  ON public.deal_watch_log (transaction_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deal_watch_log_spoken
  ON public.deal_watch_log (user_id, spoken_at DESC)
  WHERE spoken_at IS NOT NULL;

-- Same RLS pattern as ops_flags / support_triage_log / telegram_send_log:
-- enable, zero policies. Every real caller uses SUPABASE_SERVICE_ROLE_KEY
-- (which bypasses RLS); anon/authenticated default to deny-all. These tables
-- carry per-deal client correspondence summaries, so anon-readable would be a
-- cross-tenant disclosure of exactly the kind this feature must never cause.
ALTER TABLE public.deal_watch_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deal_watch_log ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- THE SWITCH — seeded OFF, deliberately
--
-- Everything in this change can deploy, run on schedule, observe every live
-- deal, rank every fact, write the full ledger, and alarm on its own silence
-- with this flag OFF. The ONLY thing it gates is a notification actually
-- reaching Heath.
--
-- api/_lib/ops-policy.js checkCapability() fails CLOSED on any read failure,
-- so a missing row, an unreadable table or a Supabase blip all resolve to "do
-- not speak" rather than "speak". There is no code path where the absence of a
-- decision becomes permission.
--
-- Heath turns it on with one UPDATE, no deploy required:
--   UPDATE public.ops_flags SET enabled = TRUE, updated_by = 'heath'
--    WHERE key = 'deal_watch_notify';
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.ops_flags (key, enabled, reason, updated_by) VALUES
  ('deal_watch_notify', FALSE,
   'Unprompted deal-watch notifications to the member (api/cron-deal-watch.js). OFF until Heath has seen a dry-run ledger he agrees with. Scope is strictly NOTIFY-ONLY: the watcher observes and tells. It never emails a client, never chases the other agent, never files anything. Anything reaching a real person stays gated behind Heath regardless of this flag.',
   'migration:20260920_deal_watch')
ON CONFLICT (key) DO NOTHING;
