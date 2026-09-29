-- Repoint everything that still references the two form_templates rows that
-- 20260816_form_templates_version_correction.sql deactivates.
--
-- NOT APPLIED. Needs Heath's sign-off — this edits production rows.
--
-- RUN THIS **BEFORE** 20260816_form_templates_version_correction.sql.
-- Applying the version-correction migration on its own breaks live data.
--
-- WHY THIS IS NEEDED
-- ------------------
-- The version-correction migration is right about what should be active, but
-- deactivating a form_templates row is not inert. Three code paths filter on
-- `is_active = true` and silently return nothing when the row goes inactive:
--
--   api/_lib/resolve-blank-template-pdf.js:134  (serves the blank PDF bytes)
--   api/form-packages.js:245                    (expands a package)
--   api/form-templates.js:95,139                (Form Library list + detail)
--
-- Verified against production on 2026-08-16:
--
--   form_template_id = c42a8bbe-… ('1-4 Family Contract', TREC 20-18)
--     32 documents rows, ALL of them document_type='form_template',
--     status='blank' — i.e. every one goes through resolveBlankTemplatePdf and
--     every one would stop resolving.
--     2 form_package_items rows.
--
--   form_template_id = 90759772-… ('Seller Disclosure', mislabeled 25-15)
--     18 documents rows, all blank templates. 1 form_package_items row.
--
-- 50 blank-template documents and 3 package memberships. Deactivating first
-- means those documents fall through to Supabase Storage, which is exactly the
-- case the base64 resolver exists to cover — so they would fail to open, and
-- two form packages would quietly expand one form short.
--
-- Repointing is safe because the target rows serve the SAME PDF bytes:
-- resolve-blank-template-pdf.js maps both '1-4 Family Contract' rows to
-- 'resale-contract' -> trec-resale-20-19-base64.js, and both disclosure rows to
-- 'sellers-disclosure' -> trec-sellers-disclosure-55-1-base64.js. No document's
-- content changes; only which template row it is attributed to.
--
-- Target rows (verified present and active on 2026-08-16):
--   a6114e4e-35b7-42af-8a90-375ae7ff608f  '1-4 Family Contract'  TREC 20-19
--   299268e7-734e-4e5b-a003-0827f7857514  'OP-H'                 Seller's Disclosure Notice

begin;

-- 1. Blank-template documents -> the surviving template row.
update public.documents
   set form_template_id = 'a6114e4e-35b7-42af-8a90-375ae7ff608f'
 where form_template_id = 'c42a8bbe-6e6f-4a78-9f15-6746b07eabbc';

update public.documents
   set form_template_id = '299268e7-734e-4e5b-a003-0827f7857514'
 where form_template_id = '90759772-394c-45f8-90f6-6b330f96a28d';

-- 2. Package membership -> the surviving template row.
--    Guarded against creating a duplicate (package_id, form_template_id) pair
--    if the package already contains the survivor.
delete from public.form_package_items old
 where old.form_template_id in (
         'c42a8bbe-6e6f-4a78-9f15-6746b07eabbc',
         '90759772-394c-45f8-90f6-6b330f96a28d')
   and exists (
         select 1
           from public.form_package_items keep
          where keep.package_id = old.package_id
            and keep.form_template_id = case old.form_template_id
                  when 'c42a8bbe-6e6f-4a78-9f15-6746b07eabbc'
                    then 'a6114e4e-35b7-42af-8a90-375ae7ff608f'
                  else '299268e7-734e-4e5b-a003-0827f7857514'
                end);

update public.form_package_items
   set form_template_id = 'a6114e4e-35b7-42af-8a90-375ae7ff608f'
 where form_template_id = 'c42a8bbe-6e6f-4a78-9f15-6746b07eabbc';

update public.form_package_items
   set form_template_id = '299268e7-734e-4e5b-a003-0827f7857514'
 where form_template_id = '90759772-394c-45f8-90f6-6b330f96a28d';

commit;

-- Verify BEFORE running the version-correction migration. Both must be 0:
--   select count(*) from public.documents
--    where form_template_id in ('c42a8bbe-6e6f-4a78-9f15-6746b07eabbc',
--                               '90759772-394c-45f8-90f6-6b330f96a28d');
--   select count(*) from public.form_package_items
--    where form_template_id in ('c42a8bbe-6e6f-4a78-9f15-6746b07eabbc',
--                               '90759772-394c-45f8-90f6-6b330f96a28d');
