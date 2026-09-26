-- 0027_trust_moderation
--
-- Trust-based moderation (ADR 030):
--
--   member_trust_scores     TENANT-SCOPED: one 0–100 score per tenant_members
--                           row, with its components. Written only by the
--                           system (inputs include reports and bans a member
--                           can't read); read by the member and tenant staff.
--   moderation_queue_items  TENANT-SCOPED, staff-only: why a post needs a human — pending
--                           after the pre-filter / low trust, a random sample
--                           of auto-approved posts, a re-review after an edit.
--   scrub_post()            ADR 006's irreversible scrub, one transaction,
--                           refusing any post under a legal hold (ADR 012).
--
-- Plus lookup codes (approved/rejected moderation actions, a
-- `meets_guidelines` reason for approvals, the post_removed notification) and
-- the settings: trust weights and thresholds, pre-filter limits, the banned
-- keyword list (platform default, tenant_admin override), sampling rate.
-- Seeds: the settings and lookup rows below; the tables start empty and are
-- filled by the API (apps/api/src/trust, apps/api/src/moderation).

-- ============================================================================
-- Lookup codes
-- ============================================================================

INSERT INTO public.moderation_action_types (code, label_key, sort_order) VALUES
  ('approved', 'enum.moderation_action_types.approved', 5),
  ('rejected', 'enum.moderation_action_types.rejected', 6);
--> statement-breakpoint
INSERT INTO public.moderation_reasons (code, label_key, sort_order) VALUES
  ('meets_guidelines', 'enum.moderation_reasons.meets_guidelines', 1);
--> statement-breakpoint
INSERT INTO public.notification_types (code, label_key, sort_order) VALUES
  ('post_removed', 'enum.notification_types.post_removed', 35);
--> statement-breakpoint

-- ============================================================================
-- member_trust_scores
-- ============================================================================

CREATE TABLE public.member_trust_scores (
  id                 uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id          uuid        NOT NULL DEFAULT public.current_tenant_id(),
  member_id          uuid        NOT NULL,
  score              smallint    NOT NULL,
  components         jsonb       NOT NULL DEFAULT '{}',
  algorithm_version  smallint    NOT NULL,
  computed_at        timestamptz NOT NULL DEFAULT now(),
  -- Set by any module whose event changes an input (a ban, a verified phone,
  -- an upheld report): the next read recomputes. No cron over all members.
  next_recompute_at  timestamptz,
  override_score     smallint,
  override_reason    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_trust_scores_pk PRIMARY KEY (id),
  CONSTRAINT member_trust_scores_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT member_trust_scores_tenant_id_member_id_fk FOREIGN KEY (tenant_id, member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT member_trust_scores_member_uq UNIQUE (tenant_id, member_id),
  CONSTRAINT member_trust_scores_score_ck CHECK (score BETWEEN 0 AND 100),
  CONSTRAINT member_trust_scores_override_ck
    CHECK (override_score IS NULL OR (override_score BETWEEN 0 AND 100 AND btrim(coalesce(override_reason, '')) <> '')),
  CONSTRAINT member_trust_scores_components_ck CHECK (jsonb_typeof(components) = 'object')
);
--> statement-breakpoint
CREATE INDEX member_trust_scores_recompute_idx ON public.member_trust_scores (next_recompute_at)
  WHERE next_recompute_at IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER member_trust_scores_set_updated_at BEFORE UPDATE ON public.member_trust_scores
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
ALTER TABLE public.member_trust_scores ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.member_trust_scores FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The member sees their own score and components (to learn how to improve).
CREATE POLICY member_trust_scores_self_read ON public.member_trust_scores
  FOR SELECT USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND member_id = (SELECT public.current_member_id())
  );
--> statement-breakpoint
CREATE POLICY member_trust_scores_staff_read ON public.member_trust_scores
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
-- Writes: only the system (the recompute) and platform staff (overrides).
CREATE POLICY member_trust_scores_system_write ON public.member_trust_scores
  FOR ALL
  USING ((SELECT public.app_is_system()) OR (SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.app_is_system()) OR (SELECT public.is_platform_admin()));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.member_trust_scores TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- moderation_queue_items
-- ============================================================================

CREATE TABLE public.moderation_queue_items (
  id                    uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id             uuid        NOT NULL DEFAULT public.current_tenant_id(),
  post_id               uuid        NOT NULL,
  -- Kept even after a scrub nulls posts.author_member_id: the queue is the
  -- per-post moderation ledger trust scores count (rejections, removals).
  -- Staff-only, so it never re-identifies a scrubbed seller publicly.
  author_member_id      uuid        NOT NULL,
  -- submission: waiting before going live; sample: auto-approved, reviewed
  -- after the fact; rereview: a live post whose edit needs a look.
  source_code           text        NOT NULL,
  reasons               text[]      NOT NULL DEFAULT '{}',
  author_trust_score    smallint,
  status_code           text        NOT NULL DEFAULT 'open',
  resolution_code       text,
  resolved_by_user_id   uuid,
  resolved_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT moderation_queue_items_pk PRIMARY KEY (id),
  CONSTRAINT moderation_queue_items_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT moderation_queue_items_tenant_id_post_id_fk FOREIGN KEY (tenant_id, post_id)
    REFERENCES public.posts (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT moderation_queue_items_tenant_id_author_member_id_fk FOREIGN KEY (tenant_id, author_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT moderation_queue_items_resolved_by_user_id_fk FOREIGN KEY (resolved_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT moderation_queue_items_source_ck CHECK (source_code IN ('submission', 'sample', 'rereview')),
  CONSTRAINT moderation_queue_items_status_ck CHECK (status_code IN ('open', 'resolved')),
  CONSTRAINT moderation_queue_items_reasons_ck CHECK (reasons <@ ARRAY[
    'low_trust', 'pre_moderation', 'outside_boundary', 'resubmission',
    'banned_keyword', 'contact_info', 'link_spam', 'duplicate', 'price_outlier',
    'sample', 'rereview'
  ]::text[]),
  CONSTRAINT moderation_queue_items_resolution_ck CHECK (
    (status_code = 'resolved') = (resolved_at IS NOT NULL)
    AND (resolution_code IS NULL OR resolution_code IN ('approved', 'rejected', 'removed', 'hard_removed', 'withdrawn'))
  ),
  CONSTRAINT moderation_queue_items_trust_ck
    CHECK (author_trust_score IS NULL OR author_trust_score BETWEEN 0 AND 100)
);
--> statement-breakpoint
-- At most one open item per post: a new reason joins the existing item.
CREATE UNIQUE INDEX moderation_queue_items_open_post_uq ON public.moderation_queue_items (post_id)
  WHERE status_code = 'open';
--> statement-breakpoint
-- The queue: oldest first within a tenant.
CREATE INDEX moderation_queue_items_queue_idx ON public.moderation_queue_items (tenant_id, created_at, id)
  WHERE status_code = 'open';
--> statement-breakpoint
-- Trust inputs: a member's resolved items.
CREATE INDEX moderation_queue_items_author_idx ON public.moderation_queue_items (tenant_id, author_member_id)
  WHERE status_code = 'resolved';
--> statement-breakpoint
CREATE INDEX moderation_queue_items_reasons_idx ON public.moderation_queue_items USING gin (reasons);
--> statement-breakpoint
CREATE TRIGGER moderation_queue_items_set_updated_at BEFORE UPDATE ON public.moderation_queue_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
ALTER TABLE public.moderation_queue_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.moderation_queue_items FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY moderation_queue_items_staff ON public.moderation_queue_items
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY moderation_queue_items_system ON public.moderation_queue_items
  FOR ALL
  USING ((SELECT public.app_is_system()) OR (SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.app_is_system()) OR (SELECT public.is_platform_admin()));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.moderation_queue_items TO ae_app;
--> statement-breakpoint

-- The author's own submit/edit files the item, in their transaction, but may
-- never read the queue (the reasons would teach a spammer the filters). A
-- plain INSERT ... ON CONFLICT can't do that: ON CONFLICT requires the row to
-- pass the inserter's SELECT policies. So this narrow function files it:
-- only for a post the caller authored (or staff/system), the author taken
-- from the post itself, and a no-op when the post already has an open item.
CREATE OR REPLACE FUNCTION public.file_moderation_item(
  p_post_id uuid,
  p_source text,
  p_reasons text[],
  p_author_trust_score smallint
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_author uuid;
BEGIN
  SELECT p.author_member_id INTO v_author FROM public.posts p
  WHERE p.id = p_post_id AND p.tenant_id = v_tenant;
  IF v_author IS NULL THEN
    RAISE EXCEPTION 'file_moderation_item: no post % in this tenant', p_post_id USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT (v_author = public.current_member_id() OR public.app_is_staff() OR public.app_is_system()) THEN
    RAISE EXCEPTION 'file_moderation_item: not your post' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.moderation_queue_items (tenant_id, post_id, author_member_id, source_code, reasons, author_trust_score)
  VALUES (v_tenant, p_post_id, v_author, p_source, p_reasons, p_author_trust_score)
  ON CONFLICT (post_id) WHERE status_code = 'open' DO NOTHING;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION public.file_moderation_item(uuid, text, text[], smallint) OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.file_moderation_item(uuid, text, text[], smallint) TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.moderation_queue_items TO ae_rls_bypass;
--> statement-breakpoint

-- ============================================================================
-- Settings (CLAUDE.md rule 9). Defaults sized for a Bangladeshi marketplace:
-- most new sellers are strangers, the common scams are advance-payment and
-- "send money first", and a phone number in the title means someone is
-- dodging the reveal-phone flow.
-- ============================================================================

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('trust_base_score', '20', 'integer', 'points', 0, 100, 'platform',
   'Where every member starts before any history.'),
  ('trust_points_per_approved_post', '5', 'integer', 'points', 0, 50, 'platform',
   'Points per post a moderator approved or that went live and stayed up.'),
  ('trust_max_approved_points', '40', 'integer', 'points', 0, 100, 'platform',
   'Cap on points from approved posts.'),
  ('trust_penalty_per_rejected_post', '8', 'integer', 'points', 0, 100, 'platform',
   'Points lost per rejected post.'),
  ('trust_penalty_per_removed_post', '15', 'integer', 'points', 0, 100, 'platform',
   'Points lost per post a moderator removed (ordinary or hard removal).'),
  ('trust_penalty_per_upheld_report', '10', 'integer', 'points', 0, 100, 'platform',
   'Points lost per report against the member that moderators acted on.'),
  ('trust_points_per_account_month', '2', 'integer', 'points', 0, 20, 'platform',
   'Points per month since the member joined this tenant.'),
  ('trust_max_account_age_points', '15', 'integer', 'points', 0, 100, 'platform',
   'Cap on points from membership age.'),
  ('trust_points_phone_verified', '10', 'integer', 'points', 0, 100, 'platform',
   'Points for a verified phone number.'),
  ('trust_points_store_verified', '15', 'integer', 'points', 0, 100, 'platform',
   'Points for owning a verified store in this tenant.'),
  ('trust_penalty_per_ban', '30', 'integer', 'points', 0, 100, 'platform',
   'Points lost per ban (active or past, not revoked) in this tenant.'),
  ('trust_auto_approve_threshold', '60', 'integer', 'points', 0, 101, 'platform',
   'Score at or above which a clean post goes live without waiting. 101 = never auto-approve.'),
  ('moderation_sample_rate_percent', '10', 'integer', 'percent', 0, 100, 'platform',
   'Share of auto-approved posts that still land in the queue for an after-the-fact review.'),
  ('moderation_banned_keywords',
   '["অগ্রিম টাকা", "অগ্রিম পেমেন্ট", "আগে টাকা", "বিকাশে আগে", "advance payment", "pay first", "send money first", "bkash first", "lottery", "লটারি"]',
   'text_array', NULL, NULL, NULL, 'tenant_admin',
   'Words or phrases that send a post to the queue. Matched after normalising Bengali/ASCII digits, case and spacing. Tenant admins can replace the list.'),
  ('moderation_max_links_per_post', '1', 'integer', 'count', 0, 20, 'platform',
   'Links allowed in a title + description before the post is held (link spam).'),
  ('moderation_duplicate_window_hours', '24', 'integer', 'hours', 1, 720, 'platform',
   'A post with the same title and photos as one of the author''s posts from this window is held as a duplicate.'),
  ('moderation_price_outlier_factor', '5', 'decimal', 'ratio', 1.5, 100, 'platform',
   'A price this many times above or below the category median in the tenant is held for review.'),
  ('moderation_price_min_samples', '10', 'integer', 'count', 3, 1000, 'platform',
   'Live posts with a price needed in a category before prices are checked against its median.'),
  ('moderation_price_lookback_days', '90', 'integer', 'days', 7, 365, 'platform',
   'How far back the category price median looks.'),
  ('moderation_bulk_max', '50', 'integer', 'count', 1, 500, 'none',
   'Most posts one bulk moderation request may act on.'),
  ('moderation_queue_page_size_default', '25', 'integer', 'count', 1, 200, 'none',
   'Queue items per page when the client does not ask.'),
  ('moderation_queue_page_size_max', '100', 'integer', 'count', 1, 500, 'none',
   'Largest queue page.');
--> statement-breakpoint

-- ============================================================================
-- scrub_post (ADR 006)
-- ============================================================================

-- Irreversible, one transaction. Refuses a post under a legal hold (direct or
-- transitive, ADR 012) and requires the justifying moderation_actions row
-- (moderator_removed or privacy_scrub) written earlier in the SAME
-- transaction — no scrub without a recorded reason (ADR 005).
-- p_deletion_reason: 'moderator_removed' for a hard removal (set in the same
-- UPDATE, since that reason requires scrubbed_at); NULL for a privacy scrub.
CREATE OR REPLACE FUNCTION public.scrub_post(p_post_id uuid, p_scrub_reason text, p_deletion_reason text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_post public.posts%ROWTYPE;
  v_seller_user uuid;
  v_keep text[];
  v_purge_days integer;
BEGIN
  SELECT * INTO v_post FROM public.posts WHERE id = p_post_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scrub_post: no post %', p_post_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_post.scrubbed_at IS NOT NULL THEN
    RETURN; -- already scrubbed: idempotent
  END IF;
  IF public.legal_hold_blocks('post', p_post_id) THEN
    RAISE EXCEPTION 'scrub_post: post % is under a legal hold', p_post_id USING ERRCODE = 'AE100';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.moderation_actions ma
    WHERE ma.post_id = p_post_id
      AND ma.action_code IN ('moderator_removed', 'privacy_scrub')
      AND ma.xact_id = pg_current_xact_id()
  ) THEN
    RAISE EXCEPTION 'scrub_post: no moderation_actions row for post % in this transaction', p_post_id
      USING ERRCODE = 'AE101';
  END IF;
  IF p_deletion_reason IS NOT NULL AND p_deletion_reason <> 'moderator_removed' THEN
    RAISE EXCEPTION 'scrub_post: deletion reason must be moderator_removed or NULL' USING ERRCODE = 'AE102';
  END IF;

  SELECT tm.user_id INTO v_seller_user FROM public.tenant_members tm
  WHERE tm.tenant_id = v_post.tenant_id AND tm.id = v_post.author_member_id;

  -- Analytics whitelist: the generated columns' keys plus the schema's own.
  SELECT ARRAY['price', 'bedrooms', 'seats', 'area'] || coalesce(s.analytics_fields, '{}')
    INTO v_keep
  FROM public.category_field_schemas s WHERE s.id = v_post.field_schema_id;

  -- Messages first, while conversations still point at the post.
  UPDATE public.messages m SET listing_snapshot = '{"state": "listing_removed"}'::jsonb
  WHERE m.listing_snapshot IS NOT NULL
    AND m.conversation_id IN (SELECT c.id FROM public.conversations c WHERE c.post_id = p_post_id);
  UPDATE public.conversations SET post_id = NULL, post_context_removed = true WHERE post_id = p_post_id;
  DELETE FROM public.saved_posts WHERE post_id = p_post_id;
  UPDATE public.reviews SET post_id = NULL WHERE post_id = p_post_id;
  UPDATE public.lead_events SET subject_scrubbed = true WHERE post_id = p_post_id;
  UPDATE public.lead_daily_stats SET subject_scrubbed = true WHERE post_id = p_post_id;

  UPDATE public.posts p SET
    title = '',
    description = NULL,
    fields = coalesce(
      (SELECT jsonb_object_agg(f.key, f.value) FROM jsonb_each(p.fields) f WHERE f.key = ANY (v_keep)),
      '{}'::jsonb),
    contact_phone_e164 = NULL,
    contact_name = NULL,
    author_member_id = NULL,
    store_id = NULL,
    locality_id = NULL,
    location = NULL,
    geo_area_id = NULL,
    deleted_by_user_id = CASE WHEN p.deleted_by_user_id = v_seller_user THEN NULL ELSE p.deleted_by_user_id END,
    scrubbed_at = now(),
    scrub_reason = p_scrub_reason,
    deleted_at = CASE WHEN p_deletion_reason IS NULL THEN p.deleted_at ELSE coalesce(p.deleted_at, now()) END,
    deletion_reason_code = coalesce(p_deletion_reason, p.deletion_reason_code)
  WHERE p.id = p_post_id;

  -- Photos go now (scrub_media_purge_days). posts_soft_delete_media already
  -- did this if the UPDATE above first set deleted_at; a post deleted
  -- earlier needs it here, with the scrub's purge window.
  SELECT (value #>> '{}')::integer INTO v_purge_days
  FROM public.platform_settings WHERE key = 'scrub_media_purge_days';
  UPDATE public.media_assets m
  SET deleted_at = coalesce(m.deleted_at, now()),
      purge_due_at = CASE WHEN m.evidence_hold THEN NULL ELSE now() + make_interval(days => v_purge_days) END
  WHERE m.tenant_id = v_post.tenant_id
    AND m.id IN (SELECT a.media_asset_id FROM public.media_attachments a WHERE a.post_id = p_post_id)
    AND NOT public.media_asset_is_referenced(m.id, m.storage_key, p_post_id);
END;
$$;
--> statement-breakpoint
ALTER FUNCTION public.scrub_post(uuid, text, text) OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.scrub_post(uuid, text, text) TO ae_app;
--> statement-breakpoint
-- BYPASSRLS skips policies, not table grants (0012 precedent).
GRANT SELECT, UPDATE ON public.posts TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.media_assets TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.conversations TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.messages TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, DELETE ON public.saved_posts TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.reviews TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.lead_events TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.lead_daily_stats TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.category_field_schemas TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.platform_settings TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.media_attachments TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.tenant_members TO ae_rls_bypass;
