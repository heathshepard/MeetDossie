-- Supersedes the 20260817 assumption in 20260817_zernio_accounts_owner.sql
-- that Heath's realtor Facebook Page would need a distinct OAuth grant /
-- distinct zernio_account_id. Confirmed live 2026-08-18 via Zernio's own
-- GET /v1/accounts (api/debug-zernio-accounts.js): BOTH Pages are already
-- visible under the SAME connected account
-- (zernio_account_id 69f253c3985e734bf3d8f9bc, metadata.availablePages):
--   - MeetDossie            Facebook Page ID 1066823756515739
--   - HeathShepardRealtor   Facebook Page ID 102113502016276
--     ("Heath Shepard, Realtor with Keller Williams City View")
--
-- Per docs.zernio.com/platforms/facebook, the publish payload accepts
-- platforms[].platformSpecificData.pageId to target a specific Page under
-- one connected account, independent of whichever Page is currently
-- selected in Zernio's dashboard toggle. This column stores that Page ID.
--
-- page_id is the Facebook-native numeric Page ID — NOT the Zernio
-- accountId (zernio_account_id). Nullable: null means "let Zernio use
-- whatever Page is currently selected on its dashboard toggle" (today's
-- existing single-Page behavior, unaffected for any row that stays null).

ALTER TABLE public.zernio_accounts
  ADD COLUMN IF NOT EXISTS page_id text;

COMMENT ON COLUMN public.zernio_accounts.page_id IS
  'Facebook-native numeric Page ID (not the Zernio accountId) sent as platforms[].platformSpecificData.pageId on publish, letting one Zernio-connected account post to a specific Page it manages. Null = defer to whatever Page is selected on Zernio''s dashboard toggle.';

-- Make the existing dossie row explicit rather than implicit/dashboard-
-- dependent, now that a second owner shares the same connected account.
UPDATE public.zernio_accounts
  SET page_id = '1066823756515739'
  WHERE platform = 'facebook' AND owner = 'dossie' AND page_id IS NULL;

-- Second Facebook destination: same connected account, different Page.
INSERT INTO public.zernio_accounts (platform, account_handle, zernio_account_id, page_id, owner, is_active)
SELECT 'facebook', '@HeathShepardRealtor', '69f253c3985e734bf3d8f9bc', '102113502016276', 'heath-realtor', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.zernio_accounts WHERE platform = 'facebook' AND owner = 'heath-realtor'
);
