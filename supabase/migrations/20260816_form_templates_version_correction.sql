-- form_templates: retire the superseded 1-4 Family contract and correct the
-- TREC revision numbers shown in the Form Library.
--
-- NOT APPLIED. Needs Heath's sign-off — this edits production rows.
-- Apply with: psql "$POSTGRES_URL_NON_POOLING" -f <this file>
--         or: the api/admin-migrate-* endpoint pattern, gated by CRON_SECRET.
--
-- WHY
-- ---
-- 1. Both TREC 20-18 and 20-19 were is_active, with identical display names, so
--    an agent could pick and send a superseded contract with no visible
--    difference. Only 20-19 is current. Nothing serves the 20-18 row's PDF —
--    api/_lib/resolve-blank-template-pdf.js maps short_name '1-4 Family
--    Contract' -> 'resale-contract' -> trec-resale-20-19-base64.js — so
--    deactivating it changes no document, only what the picker offers.
--
-- 2. trec_number is a compliance claim: it tells the agent which revision of a
--    TREC form they are about to send. On eight rows it disagreed with the PDF
--    actually served. Each correction below is taken from the asset filename
--    that resolve-blank-template-pdf.js resolves for that form, not from guesses:
--
--      Farm and Ranch      25-15 -> 25-17   (trec-farm-ranch-25-17-base64.js)
--      New Home Incomplete 23-15 -> 23-20   (trec-new-home-incomplete-23-20-base64.js)
--      New Home Completed  24-14 -> 24-20   (trec-new-home-complete-24-20-base64.js)
--      Amendment           39-10 -> 39-11   (trec-amendment-39-11-base64.js)
--      HOA Addendum        36-8  -> 36-11   (trec-hoa-addendum-36-11-base64.js)
--      Financing Addendum  40-9  -> 40-11   (trec-financing-40-11-base64.js)
--      Back-Up Contract    11-7  -> 11-9    (trec-backup-contract-11-9-base64.js)
--      Seller's Disclosure 25-15 -> 55-1    (trec-sellers-disclosure-55-1-base64.js)
--
-- 3. Two rows both claimed trec_number 25-15: 'Farm and Ranch Contract'
--    (correct family, stale revision) and 'Seller's Disclosure Notice'
--    (wrong form entirely — 25-x is Farm and Ranch; the disclosure is 55-1).
--    The disclosure row also duplicates the 'OP-H' row, and both short_names
--    already resolve to 'sellers-disclosure', so retiring the mislabeled one
--    loses no capability.
--
-- Every statement is guarded on BOTH short_name and the current (wrong) value,
-- so it is idempotent and cannot touch a row that has already been corrected or
-- that was never in the described state.

begin;

-- 1. Retire the superseded 1-4 Family Residential Contract (TREC 20-18).
update public.form_templates
   set is_active = false
 where trec_number = '20-18'
   and name = 'One to Four Family Residential Contract (Resale)';

-- 2. Retire the mislabeled duplicate Seller's Disclosure row (short_name
--    'Seller Disclosure', wrongly numbered 25-15). The canonical 'OP-H' row
--    stays active and gets the correct revision number in step 3.
update public.form_templates
   set is_active = false
 where short_name = 'Seller Disclosure'
   and trec_number = '25-15';

-- 3. Correct stale revision numbers so the Form Library states the same
--    revision the filler actually serves.
update public.form_templates set trec_number = '25-17' where short_name = 'TREC 25'            and trec_number = '25-15';
update public.form_templates set trec_number = '23-20' where short_name = 'New Home Contract'  and trec_number = '23-15';
update public.form_templates set trec_number = '24-20' where short_name = 'New Home Completed' and trec_number = '24-14';
update public.form_templates set trec_number = '39-11' where short_name = 'Amendment'          and trec_number = '39-10';
update public.form_templates set trec_number = '36-11' where short_name = 'HOA Addendum'       and trec_number = '36-8';
update public.form_templates set trec_number = '40-11' where short_name = 'Financing Addendum' and trec_number = '40-9';
update public.form_templates set trec_number = '11-9'  where short_name = 'Back-Up Contract'   and trec_number = '11-7';
update public.form_templates set trec_number = '55-1'  where short_name = 'OP-H'               and trec_number is null;

commit;

-- Verify after applying:
--   select short_name, trec_number, is_active from public.form_templates order by short_name;
-- Expect: exactly one active '1-4 Family Contract' (20-19); no row numbered
-- 20-18 active; no duplicate 25-15; 'OP-H' numbered 55-1.
