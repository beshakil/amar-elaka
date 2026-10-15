-- 0058_verification
--
-- Store and member verification (ADR 062). Three levels, shown as a badge:
--   phone_verified    automatic (users.phone_verified_at), never a row here;
--   identity_checked  NID number (salted hash + last 3 digits only — the raw
--                     number and any NID image are never stored) + a selfie;
--   business_verified trade licence + a shop-front photo with the owner,
--                     reviewed by the area's moderators; optional field visit
--                     (a request flag now; field agent mode fills it later).
--
--   verifications        NEW, tenant-scoped (the area that reviews it: the
--                          member's area where submitted, or the store's):
--                          subject (member = a user | store), level, status,
--                          NID hash/last3, decision, expiry, visit status,
--                          documents_purged_at. Written only by the functions.
--   verification_evidence NEW, tenant-scoped: the private media of a request.
--   media_kinds          + verification_image (private bucket; re-encoded
--                          without metadata like any photo — GPS gone).
--   media_asset_is_referenced CHANGED: verification evidence counts (the
--                          orphan cleaner must not take it).
--   moderation_actions   + verification_id target; action type
--                          verification_visit_requested; reason
--                          verification_review.
--   role_permissions     + verifications read/approve for moderators.
--   functions            verification_level_of_user / _of_member / _of_store (the one
--                          rule), refresh_verification_caches (stores.is_verified,
--                          seller_profiles.verification_level_code, trust stale),
--                          submit_identity_verification, submit_business_verification,
--                          decide_verification, verification_queue_page,
--                          verification_detail, my_verifications,
--                          expire_verifications, due_verification_reminders,
--                          purge_verification_documents (legal holds first).
--   notification types   verification_approved, verification_rejected,
--                          verification_expiring, verification_expired.
--   scheduled jobs       expire-verifications, purge-verification-documents.
--   settings             verification_*.
--
-- verification_requests and business_verifications (0010) stay as they are:
-- unused, superseded by verifications; a later migration may drop them.
-- Tests: apps/api/test/verification.db-spec.ts, verification.e2e-spec.ts.

SELECT set_config('app.is_platform_admin', 'true', true);
--> statement-breakpoint

INSERT INTO public.media_kinds (code, label_key, sort_order) VALUES
  ('verification_image', 'enum.media_kinds.verification_image', 60);
--> statement-breakpoint
INSERT INTO public.moderation_action_types (code, label_key, sort_order) VALUES
  ('verification_visit_requested', 'enum.moderation_action_types.verification_visit_requested', 270);
--> statement-breakpoint
INSERT INTO public.moderation_reasons (code, label_key, sort_order) VALUES
  ('verification_review', 'enum.moderation_reasons.verification_review', 320);
--> statement-breakpoint

-- ============================================================================
-- verifications: TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.verifications (
  id                     uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id              uuid        NOT NULL DEFAULT public.current_tenant_id(),
  subject_type           text        NOT NULL,
  -- member: the user (identity is the person's, in every area); store: the store.
  subject_id             uuid        NOT NULL,
  level_code             text        NOT NULL,
  status_code            text        NOT NULL DEFAULT 'submitted',
  submitted_by_user_id   uuid        NOT NULL,
  nid_hash               text,
  nid_last3              text,
  -- Another account submitted the same NID (shown to the reviewer).
  nid_duplicate          boolean     NOT NULL DEFAULT false,
  visit_status           text        NOT NULL DEFAULT 'not_needed',
  agent_visit_id         uuid,
  reviewed_by_user_id    uuid,
  reviewed_at            timestamptz,
  rejection_reason_code  text,
  decision_note          text,
  expires_at             timestamptz,
  reminder_sent_at       timestamptz,
  documents_purged_at    timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verifications_pk PRIMARY KEY (id),
  CONSTRAINT verifications_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT verifications_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT verifications_submitted_by_user_id_fk FOREIGN KEY (submitted_by_user_id)
    REFERENCES public.users (id) ON DELETE RESTRICT,
  CONSTRAINT verifications_reviewed_by_user_id_fk FOREIGN KEY (reviewed_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT verifications_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.verification_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT verifications_rejection_reason_code_fk FOREIGN KEY (rejection_reason_code)
    REFERENCES public.verification_rejection_reasons (code) ON DELETE RESTRICT,
  CONSTRAINT verifications_subject_ck CHECK (subject_type IN ('member', 'store')),
  CONSTRAINT verifications_level_ck CHECK (
    (subject_type = 'member' AND level_code = 'identity_checked')
    OR (subject_type = 'store' AND level_code = 'business_verified')
  ),
  -- An identity request carries the hash and the last 3 digits — never more.
  CONSTRAINT verifications_nid_ck CHECK (
    (level_code = 'identity_checked') = (nid_hash IS NOT NULL AND nid_last3 IS NOT NULL)
  ),
  CONSTRAINT verifications_nid_hash_ck CHECK (nid_hash IS NULL OR nid_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT verifications_nid_last3_ck CHECK (nid_last3 IS NULL OR nid_last3 ~ '^[0-9]{3}$'),
  CONSTRAINT verifications_visit_ck CHECK (visit_status IN ('not_needed', 'requested', 'done')),
  CONSTRAINT verifications_decided_ck CHECK (
    status_code NOT IN ('approved', 'rejected') OR (reviewed_at IS NOT NULL AND reviewed_by_user_id IS NOT NULL)
  ),
  CONSTRAINT verifications_approved_expiry_ck CHECK (status_code <> 'approved' OR expires_at IS NOT NULL),
  CONSTRAINT verifications_rejected_reason_ck CHECK (status_code <> 'rejected' OR rejection_reason_code IS NOT NULL)
);
--> statement-breakpoint
-- One open request per subject and level.
CREATE UNIQUE INDEX verifications_open_uq ON public.verifications (subject_type, subject_id, level_code)
  WHERE status_code IN ('submitted', 'in_review');
--> statement-breakpoint
-- The badge: a subject's approved, unexpired verifications.
CREATE INDEX verifications_subject_idx ON public.verifications (subject_type, subject_id, level_code, expires_at)
  WHERE status_code = 'approved';
--> statement-breakpoint
CREATE INDEX verifications_queue_idx ON public.verifications (tenant_id, id)
  WHERE status_code IN ('submitted', 'in_review');
--> statement-breakpoint
CREATE INDEX verifications_nid_hash_idx ON public.verifications (nid_hash) WHERE nid_hash IS NOT NULL;
--> statement-breakpoint
CREATE INDEX verifications_expiry_idx ON public.verifications (expires_at) WHERE status_code = 'approved';
--> statement-breakpoint
CREATE TRIGGER verifications_set_updated_at BEFORE UPDATE ON public.verifications
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE TABLE public.verification_evidence (
  id               uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL DEFAULT public.current_tenant_id(),
  verification_id  uuid        NOT NULL,
  kind_code        text        NOT NULL,
  media_asset_id   uuid        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verification_evidence_pk PRIMARY KEY (id),
  CONSTRAINT verification_evidence_tenant_id_verification_id_fk FOREIGN KEY (tenant_id, verification_id)
    REFERENCES public.verifications (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT verification_evidence_tenant_id_media_asset_id_fk FOREIGN KEY (tenant_id, media_asset_id)
    REFERENCES public.media_assets (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT verification_evidence_kind_ck CHECK (kind_code IN ('selfie', 'trade_licence', 'shop_front', 'visit_photo')),
  CONSTRAINT verification_evidence_media_uq UNIQUE (media_asset_id)
);
--> statement-breakpoint
CREATE INDEX verification_evidence_verification_idx ON public.verification_evidence (tenant_id, verification_id);
--> statement-breakpoint
CREATE TRIGGER verification_evidence_set_updated_at BEFORE UPDATE ON public.verification_evidence
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

ALTER TABLE public.verifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.verifications FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.verification_evidence ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.verification_evidence FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The subject reads their own: a member their identity request (in any area),
-- a store's owner and managers the store's.
CREATE POLICY verifications_subject_read ON public.verifications
  FOR SELECT USING (
    (subject_type = 'member' AND subject_id = (SELECT public.current_user_id()))
    OR (subject_type = 'store' AND tenant_id = (SELECT public.current_tenant_id())
        AND (SELECT public.can_manage_store(subject_id)))
  );
--> statement-breakpoint
CREATE POLICY verifications_staff_read ON public.verifications
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY verifications_system ON public.verifications
  FOR ALL USING ((SELECT public.app_is_system())) WITH CHECK ((SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY verifications_platform_admin ON public.verifications
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint
-- Evidence: the area's staff (through the API's signed URLs) and the system only.
CREATE POLICY verification_evidence_staff_read ON public.verification_evidence
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY verification_evidence_system ON public.verification_evidence
  FOR ALL USING ((SELECT public.app_is_system())) WITH CHECK ((SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY verification_evidence_platform_admin ON public.verification_evidence
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint
GRANT SELECT ON public.verifications, public.verification_evidence TO ae_app;
--> statement-breakpoint

ALTER TABLE public.moderation_actions
  ADD COLUMN verification_id uuid,
  ADD CONSTRAINT moderation_actions_tenant_id_verification_id_fk FOREIGN KEY (tenant_id, verification_id)
    REFERENCES public.verifications (tenant_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE public.moderation_actions DROP CONSTRAINT moderation_actions_one_target_ck;
--> statement-breakpoint
ALTER TABLE public.moderation_actions
  ADD CONSTRAINT moderation_actions_one_target_ck
    CHECK (num_nonnulls(post_id, place_id, place_claim_id, store_id, conversation_id, review_id, verification_id) = 1);
--> statement-breakpoint
CREATE INDEX moderation_actions_tenant_verification_idx
  ON public.moderation_actions (tenant_id, verification_id, id DESC)
  WHERE verification_id IS NOT NULL;
--> statement-breakpoint

INSERT INTO public.role_permissions (role_id, module, action)
SELECT r.id, grant_row.module, grant_row.action
FROM public.roles r
JOIN (VALUES
  ('moderator', 'verifications', 'read'), ('moderator', 'verifications', 'approve')
) AS grant_row (role_code, module, action) ON grant_row.role_code = r.code
WHERE r.tenant_id IS NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- The orphan cleaner and the media purge must see verification evidence as a use.
CREATE OR REPLACE FUNCTION public.media_asset_is_referenced(
  p_media_asset_id uuid,
  p_storage_key text,
  p_ignore_post_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM public.media_attachments a
      WHERE a.media_asset_id = p_media_asset_id
        AND (p_ignore_post_id IS NULL OR a.post_id IS DISTINCT FROM p_ignore_post_id)
    )
    OR EXISTS (SELECT 1 FROM public.messages m WHERE m.media_asset_id = p_media_asset_id)
    OR EXISTS (SELECT 1 FROM public.ad_creatives c WHERE c.media_asset_id = p_media_asset_id)
    OR EXISTS (SELECT 1 FROM public.user_profiles u WHERE u.avatar_storage_key = p_storage_key)
    OR EXISTS (SELECT 1 FROM public.tenant_settings s WHERE s.logo_storage_key = p_storage_key)
    OR EXISTS (SELECT 1 FROM public.verification_evidence v WHERE v.media_asset_id = p_media_asset_id)
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.media_asset_is_referenced(uuid, text, uuid) IS
  'True while anything uses the asset (attachments, messages, ad creatives, avatars, tenant logos, verification evidence). '
  'p_ignore_post_id leaves out one post''s attachments (the post being deleted).';
--> statement-breakpoint
GRANT SELECT ON public.verification_evidence TO ae_rls_bypass;
--> statement-breakpoint

-- ============================================================================
-- Settings (CLAUDE.md rule 9)
-- ============================================================================

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('verification_identity_valid_days', '730', 'integer', 'days', 30, 3650, 'platform',
   'An approved identity check is valid this long; then the badge goes until re-verified.'),
  ('verification_business_valid_days', '365', 'integer', 'days', 30, 3650, 'platform',
   'An approved business verification is valid this long (a moderator may set an earlier end, e.g. the trade licence''s).'),
  ('verification_reminder_days_before', '30', 'integer', 'days', 1, 365, 'platform',
   'Re-verification is offered, and the holder reminded, this long before a verification expires.'),
  ('verification_doc_retention_days', '90', 'integer', 'days', 1, 3650, 'platform',
   'Verification documents and photos are deleted this long after the decision (never under a legal hold); the hash, last 3 digits and the decision stay.'),
  ('verification_doc_url_ttl_seconds', '300', 'integer', 'seconds', 30, 3600, 'platform',
   'How long a signed link to a verification document works (moderators only).'),
  ('verification_queue_page_size_max', '50', 'integer', 'count', 5, 200, 'platform',
   'Largest page of the verification queue.'),
  ('verification_job_batch_size', '500', 'integer', 'count', 10, 10000, 'platform',
   'Most verifications the expiry, reminder and purge jobs handle per run.');
--> statement-breakpoint

INSERT INTO public.notification_types (code, label_key, sort_order) VALUES
  ('verification_approved', 'enum.notification_types.verification_approved', 320),
  ('verification_rejected', 'enum.notification_types.verification_rejected', 330),
  ('verification_expiring', 'enum.notification_types.verification_expiring', 340),
  ('verification_expired', 'enum.notification_types.verification_expired', 350);
--> statement-breakpoint
UPDATE public.notification_types SET default_channels = '{in_app,push}'
WHERE code IN ('verification_approved', 'verification_rejected', 'verification_expiring', 'verification_expired');
--> statement-breakpoint
INSERT INTO public.notification_templates
  (type_code, channel_code, locale, variant, title_template, body_template, variables)
VALUES
  ('verification_approved', 'in_app', 'bn', 'single',
   '{{#storeName}}{{storeName}} যাচাই সম্পন্ন{{/storeName}}{{^storeName}}পরিচয় যাচাই সম্পন্ন{{/storeName}}',
   'অভিনন্দন! এখন থেকে আপনার {{#storeName}}দোকানে{{/storeName}}{{^storeName}}প্রোফাইল ও পোস্টে{{/storeName}} যাচাইয়ের ব্যাজ দেখা যাবে।',
   '{storeName}'),
  ('verification_approved', 'in_app', 'en', 'single',
   '{{#storeName}}{{storeName}} verified{{/storeName}}{{^storeName}}Identity verified{{/storeName}}',
   'Congratulations! Your {{#storeName}}store{{/storeName}}{{^storeName}}profile and posts{{/storeName}} now show the verified badge.',
   '{storeName}'),
  ('verification_rejected', 'in_app', 'bn', 'single',
   '{{#storeName}}{{storeName}} যাচাই করা যায়নি{{/storeName}}{{^storeName}}পরিচয় যাচাই করা যায়নি{{/storeName}}',
   'কেন হয়নি তা দেখে কাগজপত্র ঠিক করে আবার জমা দিতে পারবেন।', '{storeName}'),
  ('verification_rejected', 'in_app', 'en', 'single',
   '{{#storeName}}{{storeName}} not verified{{/storeName}}{{^storeName}}Identity not verified{{/storeName}}',
   'See why, fix the documents and submit again.', '{storeName}'),
  ('verification_expiring', 'in_app', 'bn', 'single', 'যাচাইয়ের মেয়াদ শেষ হচ্ছে',
   '{{expiresAt|date}} তারিখে যাচাইয়ের মেয়াদ শেষ হবে। ব্যাজ রাখতে আবার যাচাই করুন।', '{expiresAt}'),
  ('verification_expiring', 'in_app', 'en', 'single', 'Your verification is expiring',
   'It expires on {{expiresAt|date}}. Verify again to keep your badge.', '{expiresAt}'),
  ('verification_expired', 'in_app', 'bn', 'single', 'যাচাইয়ের মেয়াদ শেষ',
   'যাচাইয়ের ব্যাজ আর দেখা যাচ্ছে না। আবার যাচাই করলে ফিরে আসবে।', '{}'),
  ('verification_expired', 'in_app', 'en', 'single', 'Your verification has expired',
   'The verified badge is no longer shown. Verify again to get it back.', '{}');
--> statement-breakpoint

INSERT INTO public.scheduled_jobs (code, label_key, sort_order) VALUES
  ('expire-verifications', 'enum.scheduled_jobs.expire-verifications', 170),
  ('purge-verification-documents', 'enum.scheduled_jobs.purge-verification-documents', 180);
--> statement-breakpoint

-- ============================================================================
-- Functions (owner ae_rls_bypass)
-- ============================================================================

GRANT SELECT, INSERT, UPDATE ON public.verifications, public.verification_evidence TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.seller_profiles, public.stores, public.member_trust_scores, public.media_assets TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.moderation_actions TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.users, public.tenant_members, public.user_profiles, public.store_members,
  public.platform_settings, public.tenant_settings, public.verification_rejection_reasons TO ae_rls_bypass;
--> statement-breakpoint

SET LOCAL ROLE ae_rls_bypass;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.verification_setting_int(p_key text, p_tenant_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT (public.setting_value_for(p_key, p_tenant_id) #>> '{}')::numeric::integer
$$;
--> statement-breakpoint

-- A person's level (ADR 062), the one rule: an approved identity check that
-- hasn't expired, in any area; else a verified phone; else none.
CREATE OR REPLACE FUNCTION public.verification_level_of_user(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM public.verifications v
      WHERE v.subject_type = 'member' AND v.subject_id = p_user_id AND v.level_code = 'identity_checked'
        AND v.status_code = 'approved' AND v.expires_at > now()
    ) THEN 'identity_checked'
    WHEN EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user_id AND u.phone_verified_at IS NOT NULL)
      THEN 'phone_verified'
    ELSE 'none'
  END
$$;
--> statement-breakpoint

-- A member's level, by their membership (a post's author, a seller card).
CREATE OR REPLACE FUNCTION public.verification_level_of_member(p_member_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce((
    SELECT public.verification_level_of_user(tm.user_id) FROM public.tenant_members tm WHERE tm.id = p_member_id
  ), 'none')
$$;
--> statement-breakpoint

-- A store's level: business_verified while its verification is approved and
-- unexpired; else its owner's own level.
CREATE OR REPLACE FUNCTION public.verification_level_of_store(p_store_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM public.verifications v
      WHERE v.subject_type = 'store' AND v.subject_id = p_store_id AND v.level_code = 'business_verified'
        AND v.status_code = 'approved' AND v.expires_at > now()
    ) THEN 'business_verified'
    ELSE coalesce((
      SELECT public.verification_level_of_user(tm.user_id)
      FROM public.stores s
      JOIN public.tenant_members tm ON tm.tenant_id = s.tenant_id AND tm.id = s.owner_member_id
      WHERE s.id = p_store_id
    ), 'none')
  END
$$;
--> statement-breakpoint

-- Brings every badge cache in line with the rule after a decision or an
-- expiry: stores.is_verified (store page, cards, seller score), the member's
-- seller_profiles.verification_level_code in every area (store page badge),
-- and the trust score of the people concerned (recomputed on next read).
CREATE OR REPLACE FUNCTION public.refresh_verification_caches(p_subject_type text, p_subject_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role text := current_setting('app.role', true);
  v_user uuid;
  v_level text;
BEGIN
  -- The cache columns only take the system's writes (0006, 0057).
  PERFORM set_config('app.role', 'system', true);
  IF p_subject_type = 'store' THEN
    UPDATE public.stores s
    SET is_verified = (public.verification_level_of_store(s.id) = 'business_verified')
    WHERE s.id = p_subject_id
      AND s.is_verified IS DISTINCT FROM (public.verification_level_of_store(s.id) = 'business_verified');
    SELECT tm.user_id INTO v_user FROM public.stores s
    JOIN public.tenant_members tm ON tm.tenant_id = s.tenant_id AND tm.id = s.owner_member_id
    WHERE s.id = p_subject_id;
  ELSE
    v_user := p_subject_id;
  END IF;
  IF v_user IS NOT NULL THEN
    v_level := public.verification_level_of_user(v_user);
    UPDATE public.seller_profiles sp
    SET verification_level_code = CASE WHEN v_level = 'identity_checked' THEN 'identity' ELSE 'phone' END
    FROM public.tenant_members tm
    WHERE tm.tenant_id = sp.tenant_id AND tm.id = sp.member_id AND tm.user_id = v_user;
    UPDATE public.member_trust_scores ts SET next_recompute_at = now()
    FROM public.tenant_members tm
    WHERE tm.tenant_id = ts.tenant_id AND tm.id = ts.member_id AND tm.user_id = v_user;
  END IF;
  PERFORM set_config('app.role', coalesce(v_role, ''), true);
END
$$;
--> statement-breakpoint

-- The caller's own uploads, ready, of an allowed kind, in this area, used nowhere else.
CREATE OR REPLACE FUNCTION public.verification_attach_evidence(
  p_verification_id uuid,
  p_kind text,
  p_media_id uuid,
  p_allowed_kinds text[]
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tenant uuid := public.current_tenant_id();
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.media_assets m
    WHERE m.tenant_id = v_tenant AND m.id = p_media_id
      AND m.uploaded_by_user_id = public.current_user_id()
      AND m.kind_code = ANY (p_allowed_kinds)
      AND m.status_code = 'ready' AND m.deleted_at IS NULL
      AND NOT public.media_asset_is_referenced(m.id, m.storage_key)
  ) THEN
    RAISE EXCEPTION 'verification: % is not usable', p_kind USING ERRCODE = 'AE702', DETAIL = p_kind;
  END IF;
  INSERT INTO public.verification_evidence (tenant_id, verification_id, kind_code, media_asset_id)
  VALUES (v_tenant, p_verification_id, p_kind, p_media_id);
END
$$;
--> statement-breakpoint

-- Is a new request allowed? Not while one is open; not while an approval is
-- valid beyond the reminder window (renewal opens inside it).
CREATE OR REPLACE FUNCTION public.verification_can_request(p_subject_type text, p_subject_id uuid, p_tenant uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM public.verifications v
                 WHERE v.subject_type = p_subject_type AND v.subject_id = p_subject_id
                   AND v.status_code IN ('submitted', 'in_review')) THEN 'open_request'
    WHEN EXISTS (SELECT 1 FROM public.verifications v
                 WHERE v.subject_type = p_subject_type AND v.subject_id = p_subject_id
                   AND v.status_code = 'approved'
                   AND v.expires_at > now() + make_interval(days =>
                         public.verification_setting_int('verification_reminder_days_before', p_tenant)))
      THEN 'already_verified'
    ELSE 'ok'
  END
$$;
--> statement-breakpoint

-- Identity (ADR 062): the caller, phone verified, sends the NID's salted
-- hash and last 3 digits (the API made them; the number itself never comes
-- here) and a selfie. Reviewed by this area's moderators.
-- Errors: AE701 (detail: no_member | phone_unverified | open_request | already_verified), AE702 evidence.
CREATE OR REPLACE FUNCTION public.submit_identity_verification(
  p_nid_hash text,
  p_nid_last3 text,
  p_selfie_media_id uuid
)
RETURNS TABLE (verification_id uuid, nid_duplicate boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := public.current_user_id();
  v_state text;
  v_dup boolean;
  v_id uuid;
BEGIN
  IF v_user IS NULL OR public.current_member_id() IS NULL THEN
    RAISE EXCEPTION 'verification: no member' USING ERRCODE = 'AE701', DETAIL = 'no_member';
  END IF;
  PERFORM 1 FROM public.users u WHERE u.id = v_user FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_user AND u.phone_verified_at IS NOT NULL) THEN
    RAISE EXCEPTION 'verification: phone first' USING ERRCODE = 'AE701', DETAIL = 'phone_unverified';
  END IF;
  v_state := public.verification_can_request('member', v_user, v_tenant);
  IF v_state <> 'ok' THEN
    RAISE EXCEPTION 'verification: %', v_state USING ERRCODE = 'AE701', DETAIL = v_state;
  END IF;
  v_dup := EXISTS (
    SELECT 1 FROM public.verifications v
    WHERE v.nid_hash = p_nid_hash AND v.subject_id <> v_user AND v.status_code <> 'rejected'
  );
  INSERT INTO public.verifications (tenant_id, subject_type, subject_id, level_code, submitted_by_user_id,
                                    nid_hash, nid_last3, nid_duplicate)
  VALUES (v_tenant, 'member', v_user, 'identity_checked', v_user, p_nid_hash, p_nid_last3, v_dup)
  RETURNING id INTO v_id;
  PERFORM public.verification_attach_evidence(v_id, 'selfie', p_selfie_media_id, ARRAY['verification_image']);
  RETURN QUERY SELECT v_id, v_dup;
END
$$;
--> statement-breakpoint

-- Business (ADR 062): the store's owner — whose identity is checked — sends
-- the trade licence (a photo or a PDF) and a shop-front photo with them in it.
-- Errors: AE701 (detail: not_owner | identity_required | open_request | already_verified | store_inactive), AE702.
CREATE OR REPLACE FUNCTION public.submit_business_verification(
  p_store_id uuid,
  p_licence_media_id uuid,
  p_shop_front_media_id uuid
)
RETURNS TABLE (verification_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := public.current_user_id();
  v_store public.stores%ROWTYPE;
  v_state text;
  v_id uuid;
BEGIN
  SELECT * INTO v_store FROM public.stores s WHERE s.id = p_store_id AND s.tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND OR v_store.owner_member_id IS DISTINCT FROM public.current_member_id() THEN
    RAISE EXCEPTION 'verification: not the owner' USING ERRCODE = 'AE701', DETAIL = 'not_owner';
  END IF;
  IF v_store.status_code <> 'active' THEN
    RAISE EXCEPTION 'verification: store not active' USING ERRCODE = 'AE701', DETAIL = 'store_inactive';
  END IF;
  IF public.verification_level_of_user(v_user) <> 'identity_checked' THEN
    RAISE EXCEPTION 'verification: identity first' USING ERRCODE = 'AE701', DETAIL = 'identity_required';
  END IF;
  v_state := public.verification_can_request('store', p_store_id, v_tenant);
  IF v_state <> 'ok' THEN
    RAISE EXCEPTION 'verification: %', v_state USING ERRCODE = 'AE701', DETAIL = v_state;
  END IF;
  INSERT INTO public.verifications (tenant_id, subject_type, subject_id, level_code, submitted_by_user_id)
  VALUES (v_tenant, 'store', p_store_id, 'business_verified', v_user)
  RETURNING id INTO v_id;
  PERFORM public.verification_attach_evidence(v_id, 'trade_licence', p_licence_media_id,
                                              ARRAY['verification_image', 'document']);
  PERFORM public.verification_attach_evidence(v_id, 'shop_front', p_shop_front_media_id, ARRAY['verification_image']);
  RETURN QUERY SELECT v_id;
END
$$;
--> statement-breakpoint

-- A moderator's decision (ADR 062): approve (valid for the level's days, or
-- until p_expires_at if earlier — a licence that ends sooner), reject with a
-- reason, or ask for a field visit (stays in review). A moderation_actions
-- row in the same transaction (rule 13); the badge caches follow at once.
-- Returns what the notification needs.
-- Errors: insufficient_privilege, AE703 no such open request, AE704 bad decision.
CREATE OR REPLACE FUNCTION public.decide_verification(
  p_verification_id uuid,
  p_decision text,
  p_rejection_reason text,
  p_note text,
  p_expires_at timestamptz
)
RETURNS TABLE (status_code text, subject_type text, subject_id uuid, submitted_by_user_id uuid, expires_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_actor uuid := public.current_user_id();
  v_row public.verifications%ROWTYPE;
  v_valid integer;
  v_expires timestamptz;
BEGIN
  IF NOT public.app_is_staff() THEN
    RAISE EXCEPTION 'decide_verification: staff only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_row FROM public.verifications v
  WHERE v.id = p_verification_id AND v.tenant_id = v_tenant AND v.status_code IN ('submitted', 'in_review')
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'decide_verification: no open request' USING ERRCODE = 'AE703';
  END IF;
  -- Nobody decides their own.
  IF v_row.submitted_by_user_id = v_actor THEN
    RAISE EXCEPTION 'decide_verification: own request' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_decision = 'approve' THEN
    v_valid := public.verification_setting_int(
      CASE WHEN v_row.level_code = 'identity_checked' THEN 'verification_identity_valid_days'
           ELSE 'verification_business_valid_days' END, v_tenant);
    v_expires := now() + make_interval(days => v_valid);
    IF p_expires_at IS NOT NULL THEN
      IF p_expires_at <= now() THEN
        RAISE EXCEPTION 'decide_verification: expiry in the past' USING ERRCODE = 'AE704';
      END IF;
      v_expires := least(v_expires, p_expires_at);
    END IF;
    UPDATE public.verifications v SET status_code = 'approved', reviewed_by_user_id = v_actor, reviewed_at = now(),
      expires_at = v_expires, decision_note = nullif(btrim(coalesce(p_note, '')), ''), reminder_sent_at = NULL,
      visit_status = CASE WHEN v.visit_status = 'requested' THEN 'done' ELSE v.visit_status END
    WHERE v.id = v_row.id;
    -- A renewal supersedes the approval it renews.
    UPDATE public.verifications v SET status_code = 'expired'
    WHERE v.subject_type = v_row.subject_type AND v.subject_id = v_row.subject_id
      AND v.level_code = v_row.level_code AND v.status_code = 'approved' AND v.id <> v_row.id;
    INSERT INTO public.moderation_actions (tenant_id, verification_id, actor_user_id, action_code, reason_code, reason_text)
    VALUES (v_tenant, v_row.id, v_actor, 'approved', 'verification_review', nullif(btrim(coalesce(p_note, '')), ''));
  ELSIF p_decision = 'reject' THEN
    IF p_rejection_reason IS NULL THEN
      RAISE EXCEPTION 'decide_verification: a reason is required' USING ERRCODE = 'AE704';
    END IF;
    UPDATE public.verifications v SET status_code = 'rejected', reviewed_by_user_id = v_actor, reviewed_at = now(),
      rejection_reason_code = p_rejection_reason, decision_note = nullif(btrim(coalesce(p_note, '')), '')
    WHERE v.id = v_row.id;
    INSERT INTO public.moderation_actions (tenant_id, verification_id, actor_user_id, action_code, reason_code, reason_text)
    VALUES (v_tenant, v_row.id, v_actor, 'rejected', 'verification_review',
            p_rejection_reason || coalesce(': ' || nullif(btrim(coalesce(p_note, '')), ''), ''));
  ELSIF p_decision = 'request_visit' AND v_row.level_code = 'business_verified' THEN
    UPDATE public.verifications v SET status_code = 'in_review', visit_status = 'requested',
      decision_note = nullif(btrim(coalesce(p_note, '')), '')
    WHERE v.id = v_row.id;
    INSERT INTO public.moderation_actions (tenant_id, verification_id, actor_user_id, action_code, reason_code, reason_text)
    VALUES (v_tenant, v_row.id, v_actor, 'verification_visit_requested', 'verification_review',
            nullif(btrim(coalesce(p_note, '')), ''));
  ELSE
    RAISE EXCEPTION 'decide_verification: decision %', p_decision USING ERRCODE = 'AE704';
  END IF;

  PERFORM public.refresh_verification_caches(v_row.subject_type, v_row.subject_id);
  RETURN QUERY
  SELECT v.status_code, v.subject_type, v.subject_id, v.submitted_by_user_id, v.expires_at
  FROM public.verifications v WHERE v.id = v_row.id;
END
$$;
--> statement-breakpoint

-- The area's open requests, oldest first (staff only).
CREATE OR REPLACE FUNCTION public.verification_queue_page(p_after uuid, p_limit integer)
RETURNS TABLE (
  verification_id uuid, subject_type text, subject_id uuid, subject_name text, level_code text,
  status_code text, nid_last3 text, nid_duplicate boolean, visit_status text, evidence_count bigint,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.app_is_staff() THEN
    RAISE EXCEPTION 'verification_queue_page: staff only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT v.id, v.subject_type, v.subject_id,
    CASE WHEN v.subject_type = 'store' THEN (SELECT s.name_bn FROM public.stores s WHERE s.id = v.subject_id)
         ELSE (SELECT up.display_name FROM public.user_profiles up WHERE up.user_id = v.subject_id) END,
    v.level_code, v.status_code, v.nid_last3, v.nid_duplicate, v.visit_status,
    (SELECT count(*) FROM public.verification_evidence e WHERE e.tenant_id = v.tenant_id AND e.verification_id = v.id),
    v.created_at
  FROM public.verifications v
  WHERE v.tenant_id = public.current_tenant_id() AND v.status_code IN ('submitted', 'in_review')
    AND (p_after IS NULL OR v.id > p_after)
  ORDER BY v.id
  LIMIT p_limit;
END
$$;
--> statement-breakpoint

-- One request with its evidence (storage keys: the API signs short-lived
-- URLs) and the subject's earlier verifications (staff only).
CREATE OR REPLACE FUNCTION public.verification_detail(p_verification_id uuid)
RETURNS TABLE (
  verification_id uuid, subject_type text, subject_id uuid, subject_name text, level_code text,
  status_code text, nid_last3 text, nid_duplicate boolean, visit_status text, decision_note text,
  rejection_reason_code text, expires_at timestamptz, documents_purged_at timestamptz, created_at timestamptz,
  owner_identity text, evidence jsonb, history jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.app_is_staff() THEN
    RAISE EXCEPTION 'verification_detail: staff only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT v.id, v.subject_type, v.subject_id,
    CASE WHEN v.subject_type = 'store' THEN (SELECT s.name_bn FROM public.stores s WHERE s.id = v.subject_id)
         ELSE (SELECT up.display_name FROM public.user_profiles up WHERE up.user_id = v.subject_id) END,
    v.level_code, v.status_code, v.nid_last3, v.nid_duplicate, v.visit_status, v.decision_note,
    v.rejection_reason_code, v.expires_at, v.documents_purged_at, v.created_at,
    CASE WHEN v.subject_type = 'store' THEN public.verification_level_of_store(v.subject_id) END,
    coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'kind', e.kind_code, 'mediaId', m.id, 'mediaKind', m.kind_code, 'mimeType', m.mime_type,
        'storageKey', m.storage_key, 'variants', m.variants, 'purged', m.purged_at IS NOT NULL OR m.deleted_at IS NOT NULL)
        ORDER BY e.kind_code)
      FROM public.verification_evidence e
      JOIN public.media_assets m ON m.tenant_id = e.tenant_id AND m.id = e.media_asset_id
      WHERE e.tenant_id = v.tenant_id AND e.verification_id = v.id
    ), '[]'::jsonb),
    coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', h.id, 'status', h.status_code, 'createdAt', h.created_at,
                                          'reviewedAt', h.reviewed_at, 'rejectionReason', h.rejection_reason_code)
                       ORDER BY h.id DESC)
      FROM public.verifications h
      WHERE h.subject_type = v.subject_type AND h.subject_id = v.subject_id AND h.id <> v.id
    ), '[]'::jsonb)
  FROM public.verifications v
  WHERE v.id = p_verification_id AND v.tenant_id = public.current_tenant_id();
END
$$;
--> statement-breakpoint

-- The caller's own: their identity checks (any area) and their stores'
-- business verifications in this area, newest first; and their levels.
CREATE OR REPLACE FUNCTION public.my_verifications()
RETURNS TABLE (
  verification_id uuid, subject_type text, subject_id uuid, level_code text, status_code text,
  rejection_reason_code text, decision_note text, expires_at timestamptz, created_at timestamptz,
  can_request text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT v.id, v.subject_type, v.subject_id, v.level_code, v.status_code, v.rejection_reason_code,
         v.decision_note, v.expires_at, v.created_at,
         public.verification_can_request(v.subject_type, v.subject_id, public.current_tenant_id())
  FROM public.verifications v
  WHERE (v.subject_type = 'member' AND v.subject_id = public.current_user_id())
     OR (v.subject_type = 'store' AND v.tenant_id = public.current_tenant_id()
         AND EXISTS (SELECT 1 FROM public.stores s WHERE s.id = v.subject_id
                     AND s.owner_member_id = public.current_member_id()))
  ORDER BY v.id DESC
$$;
--> statement-breakpoint

-- The expiry job (ADR 062): approved verifications past expires_at become
-- expired, the badge caches follow; returns who to tell. System only.
CREATE OR REPLACE FUNCTION public.expire_verifications(p_limit integer)
RETURNS TABLE (verification_id uuid, tenant_id uuid, subject_type text, subject_id uuid, user_id uuid, store_name text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  r record;
BEGIN
  IF NOT public.app_is_system() THEN
    RAISE EXCEPTION 'expire_verifications: system only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOR r IN
    UPDATE public.verifications v SET status_code = 'expired'
    WHERE v.id IN (
      SELECT x.id FROM public.verifications x
      WHERE x.status_code = 'approved' AND x.expires_at <= now()
      ORDER BY x.expires_at LIMIT p_limit FOR UPDATE SKIP LOCKED)
    RETURNING v.id, v.tenant_id, v.subject_type, v.subject_id, v.submitted_by_user_id
  LOOP
    PERFORM public.refresh_verification_caches(r.subject_type, r.subject_id);
    -- refresh_verification_caches restores app.role to what it found: system.
    verification_id := r.id; tenant_id := r.tenant_id; subject_type := r.subject_type; subject_id := r.subject_id;
    user_id := r.submitted_by_user_id;
    store_name := (SELECT s.name_bn FROM public.stores s WHERE s.id = r.subject_id AND r.subject_type = 'store');
    RETURN NEXT;
  END LOOP;
END
$$;
--> statement-breakpoint

-- Approvals entering the reminder window, reminded once. System only.
CREATE OR REPLACE FUNCTION public.due_verification_reminders(p_limit integer)
RETURNS TABLE (verification_id uuid, tenant_id uuid, subject_type text, user_id uuid, store_name text, expires_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.app_is_system() THEN
    RAISE EXCEPTION 'due_verification_reminders: system only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  UPDATE public.verifications v SET reminder_sent_at = now()
  WHERE v.id IN (
    SELECT x.id FROM public.verifications x
    WHERE x.status_code = 'approved' AND x.reminder_sent_at IS NULL AND x.expires_at > now()
      AND x.expires_at <= now() + make_interval(days =>
            public.verification_setting_int('verification_reminder_days_before', x.tenant_id))
      -- A renewal already waiting needs no reminder.
      AND NOT EXISTS (SELECT 1 FROM public.verifications o
                      WHERE o.subject_type = x.subject_type AND o.subject_id = x.subject_id
                        AND o.status_code IN ('submitted', 'in_review'))
    ORDER BY x.expires_at LIMIT p_limit FOR UPDATE SKIP LOCKED)
  RETURNING v.id, v.tenant_id, v.subject_type, v.submitted_by_user_id,
    (SELECT s.name_bn FROM public.stores s WHERE s.id = v.subject_id AND v.subject_type = 'store'),
    v.expires_at;
END
$$;
--> statement-breakpoint

-- Retention (ADR 062): verification_doc_retention_days after the decision
-- (or the expiry), the evidence files go — handed to the media purge
-- (purge_due_at), which deletes the objects — and the request records
-- documents_purged_at; the hash, last 3 digits and the decision stay.
-- Never under a legal hold on the person, the store or the file (rule 11).
-- System only; returns how many requests were purged.
CREATE OR REPLACE FUNCTION public.purge_verification_documents(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_count integer := 0;
  r record;
BEGIN
  IF NOT public.app_is_system() THEN
    RAISE EXCEPTION 'purge_verification_documents: system only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOR r IN
    SELECT v.id, v.tenant_id, v.subject_type, v.subject_id FROM public.verifications v
    WHERE v.documents_purged_at IS NULL
      AND v.status_code IN ('approved', 'rejected', 'expired', 'revoked')
      AND coalesce(v.reviewed_at, v.updated_at) < now() - make_interval(days =>
            public.verification_setting_int('verification_doc_retention_days', v.tenant_id))
      AND NOT public.legal_hold_blocks(CASE WHEN v.subject_type = 'store' THEN 'store' ELSE 'user' END, v.subject_id)
    ORDER BY v.id LIMIT p_limit FOR UPDATE SKIP LOCKED
  LOOP
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.verification_evidence e
      WHERE e.tenant_id = r.tenant_id AND e.verification_id = r.id
        AND public.legal_hold_blocks('media_asset', e.media_asset_id));
    UPDATE public.media_assets m SET deleted_at = coalesce(m.deleted_at, now()), purge_due_at = now()
    WHERE m.tenant_id = r.tenant_id
      AND m.id IN (SELECT e.media_asset_id FROM public.verification_evidence e
                   WHERE e.tenant_id = r.tenant_id AND e.verification_id = r.id);
    UPDATE public.verifications v SET documents_purged_at = now() WHERE v.id = r.id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END
$$;
--> statement-breakpoint

RESET ROLE;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.verification_setting_int(text, uuid), public.refresh_verification_caches(text, uuid),
  public.verification_attach_evidence(uuid, text, uuid, text[]), public.verification_can_request(text, uuid, uuid),
  public.submit_identity_verification(text, text, uuid), public.submit_business_verification(uuid, uuid, uuid),
  public.decide_verification(uuid, text, text, text, timestamptz), public.verification_queue_page(uuid, integer),
  public.verification_detail(uuid), public.my_verifications(), public.expire_verifications(integer),
  public.due_verification_reminders(integer), public.purge_verification_documents(integer),
  public.verification_level_of_user(uuid), public.verification_level_of_store(uuid),
  public.verification_level_of_member(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.submit_identity_verification(text, text, uuid),
  public.submit_business_verification(uuid, uuid, uuid), public.decide_verification(uuid, text, text, text, timestamptz),
  public.verification_queue_page(uuid, integer), public.verification_detail(uuid), public.my_verifications(),
  public.expire_verifications(integer), public.due_verification_reminders(integer),
  public.purge_verification_documents(integer), public.verification_level_of_user(uuid),
  public.verification_level_of_store(uuid), public.verification_level_of_member(uuid) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.verification_setting_int(text, uuid), public.refresh_verification_caches(text, uuid),
  public.verification_attach_evidence(uuid, text, uuid, text[]), public.verification_can_request(text, uuid, uuid),
  public.verification_level_of_user(uuid), public.verification_level_of_store(uuid) TO ae_rls_bypass;
