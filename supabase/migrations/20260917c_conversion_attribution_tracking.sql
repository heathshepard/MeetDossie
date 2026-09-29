-- End-to-end conversion attribution (Carter, 2026-09-17).
--
-- WHY: "which post produced a signup" was impossible to answer — no
-- outbound link carried an id back to the row that generated it, and
-- founding_applications/subscriptions had no record of what brought the
-- person there. This adds exactly the three columns the code in this
-- change actually writes to and reads from:
--
--   1. social_posts.content_tag — the decodable tag
--      (<brand>.<platform>.<format>.<shortId>.<date>, see
--      api/_lib/content-tag.js) stamped at PUBLISH time by
--      api/cron-publish-approved.js, not at draft/generation time.
--
--   2. founding_applications.first_touch / .last_touch — jsonb, captured
--      client-side by assets/dossie-acquisition.js on meetdossie.com and
--      forwarded verbatim by api/signup.js's free/comped path.
--
--   3. subscriptions.first_touch / .last_touch — jsonb, forwarded through
--      Stripe Checkout metadata by api/create-checkout-session.js and read
--      back in api/stripe-webhook.js's checkout.session.completed handler
--      (also written directly for the comped design-partner path in
--      api/signup.js).
--
-- jsonb (not flat utm_source/utm_medium/... columns) so first-touch and
-- last-touch can each carry the full { utm_source, utm_medium, utm_campaign,
-- content_tag, referrer, landing_page } shape without doubling the column
-- count on two tables that don't need to be queried by any single field
-- other than content_tag (extracted via ->>'content_tag' — see
-- api/_lib/attribution.js's effectiveTag()).
--
-- All nullable, no backfill — existing rows (everyone who signed up or paid
-- before this shipped) correctly stay NULL rather than guessing at a source
-- they were never asked to report. api/_lib/attribution.js treats a NULL
-- content_tag as "unattributed" and always counts it in the total, never
-- drops it.

ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS content_tag text;

COMMENT ON COLUMN public.social_posts.content_tag IS
  'Decodable attribution tag (<brand>.<platform>.<format>.<shortId>.<YYYYMMDD>) stamped by api/cron-publish-approved.js at the moment this row actually published, via api/_lib/content-tag.js buildContentTag(). NULL on every row published before 2026-09-17 and on any row whose outbound link had nothing to tag (no meetdossie.com link in the caption) — both are legitimately unattributed, not a bug. See PLATFORMS_WITHOUT_CAPTION_LINKS in content-tag.js: Instagram/TikTok captions are never clickable, so a tag can be recorded here even though no click can ever be traced to it.';

CREATE INDEX IF NOT EXISTS idx_social_posts_content_tag
  ON public.social_posts (content_tag)
  WHERE content_tag IS NOT NULL;

ALTER TABLE public.founding_applications
  ADD COLUMN IF NOT EXISTS first_touch jsonb,
  ADD COLUMN IF NOT EXISTS last_touch jsonb;

COMMENT ON COLUMN public.founding_applications.first_touch IS
  'First real acquisition signal captured on this browser (assets/dossie-acquisition.js, first-touch-wins — never overwritten once set). Shape: { utm_source, utm_medium, utm_campaign, content_tag, referrer, landing_page, captured_at }. Client-supplied, unauthenticated — attribution only, never trusted for anything security- or billing-sensitive.';
COMMENT ON COLUMN public.founding_applications.last_touch IS
  'Same shape as first_touch, but always overwritten on every visit that carries a real signal — answers "what made them convert on THIS visit" as distinct from what first created awareness.';

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS first_touch jsonb,
  ADD COLUMN IF NOT EXISTS last_touch jsonb;

COMMENT ON COLUMN public.subscriptions.first_touch IS
  'Same contract as founding_applications.first_touch — forwarded through Stripe Checkout session/subscription metadata (api/create-checkout-session.js -> api/stripe-webhook.js) for the paid path, or written directly for the comped design-partner path (api/signup.js). NULL on every subscription created before 2026-09-17.';
COMMENT ON COLUMN public.subscriptions.last_touch IS
  'Same contract as founding_applications.last_touch — see subscriptions.first_touch comment for how it gets here.';
