-- Follow-up to 20260910_testimonial_request_automation.sql.
--
-- Heath, 2026-09-10, after seeing the first draft: "are we asking them to
-- post it directly to all of the different sites, Zillow, Google, all of
-- them... I don't think we can post testimonials ourselves to every
-- place." Correct -- Zillow only attributes a review that originates from
-- its own request flow, not a pasted link. Revised shape:
--   1. One closing-day ask: Google review link + a two-sentence quote +
--      name/address permission. Google only.
--   2. A SEPARATE agent-facing prompt ~7 days after the Google ask went
--      out (not after closing): "go run Zillow's own review-request flow
--      yourself." Never an email Dossie sends to the client.
--   3. Per-transaction platform state so the dossier shows what's gone out.
--
-- See memory dossie-post-closing-testimonial-request.md (updated 2026-09-10).

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS google_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS google_received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS zillow_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quote_received BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS zillow_prompt_created_at TIMESTAMPTZ;

COMMENT ON COLUMN public.transactions.google_requested_at IS
  'Stamped by send-testimonial-request.js when the agent taps Send on the closing-day Google review ask. Also the anchor cron-request-zillow-review-prompt.js watches for its 7-day-later Zillow nudge.';
COMMENT ON COLUMN public.transactions.google_received_at IS
  'Stamped by action-items.js PATCH when the agent marks the testimonial_request action item Done (i.e. confirms the Google review actually came back). Manual confirmation -- no Google API integration in v1.';
COMMENT ON COLUMN public.transactions.zillow_requested_at IS
  'Stamped by action-items.js PATCH when the agent marks the zillow_review_prompt action item Done -- i.e. they went and ran Zillow''s own review-request flow themselves. Dossie never emails a Zillow ask to the client.';
COMMENT ON COLUMN public.transactions.quote_received IS
  'True once the agent records a non-empty reply_text on the testimonial_request action item (the two-sentence quote for social/website reuse).';
COMMENT ON COLUMN public.transactions.zillow_prompt_created_at IS
  'Idempotency marker for cron-request-zillow-review-prompt.js -- the zillow_review_prompt action item is created once per dossier, ever.';

CREATE INDEX IF NOT EXISTS idx_transactions_zillow_prompt_pending
  ON public.transactions (google_requested_at)
  WHERE google_requested_at IS NOT NULL AND zillow_prompt_created_at IS NULL;

-- Per-agent review links (dossie-per-agent-contract-defaults.md: never
-- hardcode Heath's). google_review_url already exists (added outside
-- migration tracking, live in prod -- see cron-testimonial-request.js /
-- request-testimonial.js). zillow_profile_url is new: the agent's OWN
-- Zillow profile review-request page, distinct in purpose from the older
-- zillow_review_url column (a plain review-page link, insufficient for
-- Zillow's attribution requirement).
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS google_review_url TEXT,
  ADD COLUMN IF NOT EXISTS zillow_profile_url TEXT;

COMMENT ON COLUMN public.profiles.google_review_url IS
  'Agent''s direct Google write-review link (Settings). Used verbatim in the closing-day testimonial ask -- if unset, Dossie skips drafting the client email and prompts the agent to add it instead of sending a broken link.';
COMMENT ON COLUMN public.profiles.zillow_profile_url IS
  'Agent''s Zillow profile review-request page (Settings). Surfaced in the zillow_review_prompt action item so the agent can run Zillow''s own flow -- never emailed to a client, since Zillow does not attribute reviews from a pasted link.';
