-- =============================================================================
-- Multi-Tenant Rollback — reverses all three phase migrations.
-- DOD-S-6: reversible migration with documented rollback path
-- =============================================================================
--
-- USE WITH CAUTION. This drops:
--   - organizations + members + roles
--   - tc_authorizations + tc_authorizations_audit + tc_consent_requests + tc_consent_events
--   - admin_actions_audit
--   - data_vault_subscriptions + storage_usage_snapshots
--   - org_id columns on transactions / documents / action_items / email_queue / social_posts / dossier_milestones
--   - user_id column on social_posts (new addition)
--   - is_org_admin / has_active_tc_auth helper functions
--   - all multitenant triggers + RLS policies created by the phase migrations
--
-- Existing Solo customer data is NOT touched (org_id is nullable; dropping it loses only org linkage).
--
-- Order matters: drop dependents before parents.
-- =============================================================================

-- Drop triggers first (so we don't trip last-admin enforcement during rollback)
DROP TRIGGER IF EXISTS trg_enforce_last_admin_member ON public.organization_members;
DROP TRIGGER IF EXISTS trg_enforce_last_admin_update ON public.organization_member_roles;
DROP TRIGGER IF EXISTS trg_enforce_last_admin_delete ON public.organization_member_roles;
DROP TRIGGER IF EXISTS trg_auto_revoke_tc_auths ON public.organization_member_roles;
DROP TRIGGER IF EXISTS trg_enforce_org_parent_tier ON public.organizations;
DROP TRIGGER IF EXISTS trg_block_consent_events_update ON public.tc_consent_events;
DROP TRIGGER IF EXISTS trg_block_consent_events_delete ON public.tc_consent_events;
DROP TRIGGER IF EXISTS trg_block_tc_audit_update ON public.tc_authorizations_audit;
DROP TRIGGER IF EXISTS trg_block_tc_audit_delete ON public.tc_authorizations_audit;
DROP TRIGGER IF EXISTS trg_block_admin_audit_update ON public.admin_actions_audit;
DROP TRIGGER IF EXISTS trg_block_admin_audit_delete ON public.admin_actions_audit;
DROP TRIGGER IF EXISTS trg_enforce_tc_send_authorization ON public.email_queue;
DROP TRIGGER IF EXISTS trg_enforce_self_signing_sig_req ON public.signature_requests;

-- Drop RLS policies on customer tables
DROP POLICY IF EXISTS "org_admin_select_transactions"  ON public.transactions;
DROP POLICY IF EXISTS "org_admin_insert_transactions"  ON public.transactions;
DROP POLICY IF EXISTS "org_admin_update_transactions"  ON public.transactions;
DROP POLICY IF EXISTS "org_admin_delete_transactions"  ON public.transactions;
DROP POLICY IF EXISTS "org_admin_select_documents"     ON public.documents;
DROP POLICY IF EXISTS "org_admin_insert_documents"     ON public.documents;
DROP POLICY IF EXISTS "org_admin_update_documents"     ON public.documents;
DROP POLICY IF EXISTS "org_admin_delete_documents"     ON public.documents;
DROP POLICY IF EXISTS "org_admin_select_action_items"  ON public.action_items;
DROP POLICY IF EXISTS "org_admin_insert_action_items"  ON public.action_items;
DROP POLICY IF EXISTS "org_admin_update_action_items"  ON public.action_items;
DROP POLICY IF EXISTS "org_admin_delete_action_items"  ON public.action_items;
DROP POLICY IF EXISTS "org_admin_select_email_queue"   ON public.email_queue;
DROP POLICY IF EXISTS "org_admin_insert_email_queue"   ON public.email_queue;
DROP POLICY IF EXISTS "org_admin_update_email_queue"   ON public.email_queue;
DROP POLICY IF EXISTS "tc_select_authorized_email_queue" ON public.email_queue;
DROP POLICY IF EXISTS "org_admin_select_dossier_milestones" ON public.dossier_milestones;
DROP POLICY IF EXISTS "org_admin_insert_dossier_milestones" ON public.dossier_milestones;
DROP POLICY IF EXISTS "org_admin_update_dossier_milestones" ON public.dossier_milestones;

-- Drop helper view
DROP VIEW IF EXISTS public.organization_members_with_roles;

-- Disable append-only triggers so DROP TABLE cascade works on audit tables
ALTER TABLE IF EXISTS public.tc_consent_events DISABLE TRIGGER ALL;
ALTER TABLE IF EXISTS public.tc_authorizations_audit DISABLE TRIGGER ALL;
ALTER TABLE IF EXISTS public.admin_actions_audit DISABLE TRIGGER ALL;

-- Drop tables in dep order
DROP TABLE IF EXISTS public.storage_usage_snapshots CASCADE;
DROP TABLE IF EXISTS public.data_vault_subscriptions CASCADE;
DROP TABLE IF EXISTS public.admin_actions_audit CASCADE;
DROP TABLE IF EXISTS public.tc_consent_events CASCADE;
-- Detach FK before dropping consent_requests
ALTER TABLE public.tc_authorizations DROP CONSTRAINT IF EXISTS fk_tc_auth_request;
DROP TABLE IF EXISTS public.tc_consent_requests CASCADE;
DROP TABLE IF EXISTS public.tc_authorizations_audit CASCADE;
DROP TABLE IF EXISTS public.tc_authorizations CASCADE;
DROP TABLE IF EXISTS public.organization_member_roles CASCADE;
DROP TABLE IF EXISTS public.organization_members CASCADE;
DROP TABLE IF EXISTS public.organizations CASCADE;

-- Drop helper functions
DROP FUNCTION IF EXISTS public.is_org_admin(UUID);
DROP FUNCTION IF EXISTS public.has_active_tc_auth(UUID);
DROP FUNCTION IF EXISTS public.enforce_self_signing();
DROP FUNCTION IF EXISTS public.enforce_tc_send_authorization();
DROP FUNCTION IF EXISTS public.auto_revoke_tc_auths_on_role_revoke();
DROP FUNCTION IF EXISTS public.enforce_last_admin_member();
DROP FUNCTION IF EXISTS public.enforce_last_admin_role();
DROP FUNCTION IF EXISTS public.enforce_org_parent_tier();
DROP FUNCTION IF EXISTS public.block_audit_mutations();

-- Drop org_id columns on customer tables (and new user_id on social_posts)
ALTER TABLE public.transactions       DROP COLUMN IF EXISTS org_id;
ALTER TABLE public.documents          DROP COLUMN IF EXISTS org_id;
ALTER TABLE public.action_items       DROP COLUMN IF EXISTS org_id;
ALTER TABLE public.email_queue        DROP COLUMN IF EXISTS org_id;
ALTER TABLE public.social_posts       DROP COLUMN IF EXISTS org_id;
ALTER TABLE public.social_posts       DROP COLUMN IF EXISTS user_id;
ALTER TABLE public.dossier_milestones DROP COLUMN IF EXISTS org_id;
