-- 20260906_group_registry_access_audit.sql
--
-- Read-only Facebook group access audit (Carter, 2026-09-06): every row in
-- group_registry visited live via the DossieBot Chrome profile to record
-- whether the account can actually read the group's feed, what the pinned
-- self-promotion rule says (verbatim, when readable), member count, and a
-- rough 7-day post-volume/question-type signal.
--
-- Note on naming: group_registry.last_posted_at is misleading -- it is
-- actually set by fb-engagement-scraper.js's SCAN pass (any group-page
-- visit), not by an actual post. Left as-is here (out of scope for this
-- migration) but flagged for anyone reading it going forward.

alter table public.group_registry
  add column if not exists access_state text
    check (access_state in (
      'member-and-readable',
      'member-but-feed-empty',
      'pending-approval',
      'not-a-member',
      'inaccessible-or-removed',
      'group-deleted'
    )),
  add column if not exists promo_policy text,
  add column if not exists member_count integer,
  add column if not exists post_volume_7d integer,
  add column if not exists question_signal text
    check (question_signal in (
      'answerable-questions',
      'listings-feed',
      'jobs-board',
      'vendor-spam',
      'unclear-low-sample'
    ) or question_signal is null),
  add column if not exists audit_notes text,
  add column if not exists last_audited_at timestamptz;

comment on column public.group_registry.access_state is
  'Read-only audit result (Carter, 2026-09-06): can DossieBot actually see this group''s feed right now.';
comment on column public.group_registry.promo_policy is
  'Verbatim self-promotion/vendor rule quoted from the group''s pinned Group Rules (About tab), when readable. NULL if rules unreadable or no promo-specific line found.';
comment on column public.group_registry.member_count is
  'Member count as rendered on the group page at audit time (approximate, FB-rounded).';
comment on column public.group_registry.post_volume_7d is
  'Rough count of visible posts with a relative timestamp <=7d, from a capped-scroll sample. Not exhaustive -- an inventory signal, not a full count.';
comment on column public.group_registry.question_signal is
  'Best-effort classification of the visible post sample: real answerable questions vs listings feed vs jobs board vs vendor spam vs too little sample to tell.';
