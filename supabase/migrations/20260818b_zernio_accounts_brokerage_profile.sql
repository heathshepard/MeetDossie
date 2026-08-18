-- Heath created a genuinely separate Zernio profile ("Brokerage", profile id
-- 6a8469b3a307bfe9b1958bc4) and connected three destinations to it directly
-- in the Zernio dashboard, confirmed live via GET /v1/accounts
-- (api/debug-zernio-accounts.js) on 2026-08-18:
--   - facebook  accountId 6a8469f177555aae01775798
--       selectedPageId 102113502016276 / username HeathShepardRealtor
--       ("Heath Shepard, Realtor with Keller Williams City View")
--   - instagram accountId 6a8469d677555aae017735a1
--       username heathshepardrealtor ("Heath Shepard")
--   - youtube   accountId 6a846a0c77555aae017776e3
--       channel "Shepard Real Estate Solutions" (no content plan yet — not
--       wired into zernio_accounts, just documented in docs/PIPELINE.md)
-- (a fourth, metaads accountId 6a846a2f77555aae01778a01, also exists under
-- this profile — out of scope, not social posting, not touched here)
--
-- This supersedes the 20260817/20260818 workaround where the realtor
-- Facebook Page rode the SAME zernio_account_id as MeetDossie's Page,
-- disambiguated only by platformSpecificData.pageId (necessary at the time
-- because both Pages lived under one shared Zernio connection). Now that a
-- dedicated Brokerage-profile connection exists, route heath-realtor
-- Facebook through it directly. page_id is left populated (harmless
-- belt-and-suspenders — it already matches this account's own
-- selectedPageId, so it's a no-op pin, not a disambiguation requirement).

UPDATE public.zernio_accounts
  SET zernio_account_id = '6a8469f177555aae01775798'
  WHERE platform = 'facebook' AND owner = 'heath-realtor';

-- First Instagram destination beyond @meetdossie. owner/routing pattern
-- (20260817_zernio_accounts_owner.sql) extends with no schema gap — the
-- partial unique index is on (platform, owner) WHERE is_active, so a second
-- active instagram row (dossie + heath-realtor) is already supported.
INSERT INTO public.zernio_accounts (platform, account_handle, zernio_account_id, owner, is_active)
SELECT 'instagram', '@heathshepardrealtor', '6a8469d677555aae017735a1', 'heath-realtor', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.zernio_accounts WHERE platform = 'instagram' AND owner = 'heath-realtor'
);
