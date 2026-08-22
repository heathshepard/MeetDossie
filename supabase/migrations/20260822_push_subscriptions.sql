-- ============================================================================
-- push_subscriptions — Web Push subscription storage for the Jarvis PWA.
--
-- Built 2026-08-22 (Carter) so a real bridge reply (scripts/jarvis-bridge/
-- server.ts's `reply` tool, final:true) can wake Heath up via a real OS-level
-- notification even when the Jarvis tab is backgrounded/suspended — mobile
-- browsers throttle or fully suspend background tabs (Android especially),
-- which was breaking live replies mid-conversation.
--
-- One row per browser/device subscription (Heath may have this open on his
-- phone AND desktop at once — both should get the push). Single-tenant app
-- (only Heath has an account), same pattern as jarvis_todos/jarvis_balls:
-- RLS scopes to "any authenticated user" rather than a specific uid.
-- service_role (api/jarvis-push-subscribe.js, api/jarvis-push-send.js) both
-- use SUPABASE_SERVICE_ROLE_KEY and bypass RLS regardless.
--
-- NOT added to supabase_realtime — nothing in the UI needs to live-render
-- this table; it's write-once-per-device, read-only-by-the-send-endpoint.
--
-- Owner: Carter (SV-ENG-JARVIS-WEB-PUSH / 2026-08-22)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who this subscription belongs to. Kept even though this is a
  -- single-tenant app today, so RLS has a real column to scope to if a
  -- second user is ever added, and so the send endpoint can filter by user
  -- without a schema change.
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- The PushSubscription object's three parts (W3C Push API). `endpoint` is
  -- globally unique per browser+device+installation — used as the natural
  -- dedupe key so re-subscribing (e.g. after a permission re-grant) upserts
  -- instead of piling up dead rows.
  endpoint      TEXT NOT NULL UNIQUE,
  p256dh        TEXT NOT NULL,
  auth_key      TEXT NOT NULL,  -- "auth" is reserved-adjacent in some tooling; auth_key avoids ambiguity with the auth schema.

  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.push_subscriptions IS
  'Web Push subscriptions for the Jarvis PWA. One row per browser/device. endpoint is the PushSubscription.endpoint URL (unique per device), p256dh/auth_key are the two keys off PushSubscription.toJSON().keys. Sent-to via api/jarvis-push-send.js using the web-push npm package + VAPID_PRIVATE_KEY.';
COMMENT ON COLUMN public.push_subscriptions.endpoint IS
  'PushSubscription.endpoint — globally unique per browser+device. Natural upsert key.';
COMMENT ON COLUMN public.push_subscriptions.last_used_at IS
  'Updated on every successful push send. Rows whose endpoint the push service reports as gone (404/410) are deleted by api/jarvis-push-send.js rather than left to rot.';

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON public.push_subscriptions (user_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view push_subscriptions"
  ON public.push_subscriptions FOR SELECT
  USING ((select auth.role()) = 'authenticated');

CREATE POLICY "Authenticated users can insert push_subscriptions"
  ON public.push_subscriptions FOR INSERT
  WITH CHECK ((select auth.role()) = 'authenticated');

CREATE POLICY "Authenticated users can update push_subscriptions"
  ON public.push_subscriptions FOR UPDATE
  USING ((select auth.role()) = 'authenticated');

CREATE POLICY "Authenticated users can delete push_subscriptions"
  ON public.push_subscriptions FOR DELETE
  USING ((select auth.role()) = 'authenticated');
