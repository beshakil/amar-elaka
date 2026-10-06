-- 0042_place_contributions_and_claims
--
-- User-contributed places and the "এই দোকানটি আমার" claim flow (ADR 047).
-- Field agents and users map shops first; owners claim them later.
--
--   places                + claim_store_id (the store whose map pin this place
--                           is, set when a claim is approved; one place per
--                           store) and street_photo_media_id.
--                         + places_creator_read / places_owner_read: a
--                           contributor reads back their own pending place, a
--                           claimed owner reads theirs in any status.
--                         + places_protect_system_columns: only staff/system
--                           set claimed_by_member_id / claim_store_id /
--                           created_by_user_id / ratings, and a claimed owner
--                           only moves between published and closed. Before
--                           this, any member could take over a place through a
--                           plain UPDATE/INSERT.
--   place_revisions       TENANT-SCOPED, append-only. One row per place per
--                           transaction, written by an AFTER trigger on places
--                           (every edit is versioned, whatever path it took)
--                           and record_place_hours_revision() for opening
--                           hours. changed_fields = {field: {from, to}}. Read by
--                           staff, agents and the claimed owner; nobody writes
--                           it directly.
--   revert_place_revision()  staff: puts a revision's `from` values back
--                           (refuses with AE222 when a field changed again
--                           since), recorded as a `reverted` revision and a
--                           moderation_actions row.
--   place_claims          + evidence_codes, otp_verified_*, store_id,
--                           review_note; at most ONE approved claim per place
--                           (unique index), so two concurrent approvals can't
--                           both commit; place_claims_protect_status: only
--                           staff/system decide a claim.
--   approve_place_claim() one transaction: lock claim and place, create or
--                           link the claimant's store, place.claim_store_id +
--                           claimed_by_member_id, store pin = place location,
--                           saves and reviews carried over to the store,
--                           competing pending claims rejected, everything in
--                           moderation_actions. Moderators, or the claimant
--                           themself for an OTP-verified claim when the tenant
--                           allows auto-approval.
--   moderation_actions    post_id becomes NULLABLE (constraint relaxed, no
--                           column dropped) and gains place_id /
--                           place_claim_id; exactly one target per row.
--   role 'agent'          built-in RBAC role (tenant_members.role_code
--                           'agent' had no grants at all): places + posts.
--   'places' grants       member/seller write, moderator approve.
--
-- Lookups: claim method shop_front_photo; action types claim_submitted /
-- claim_approved / claim_rejected / reverted; reasons
-- otp_verified / owner_request / place_already_claimed; four notification
-- types. Settings (CLAUDE.md rule 9): see the INSERT below.
-- Seeds: lookups, settings, roles here; demo revisions come from the places
-- seed (the trigger writes them). Tests: apps/api/test/places.db-spec.ts,
-- apps/api/test/places.e2e-spec.ts.

-- Lookup and settings tables are FORCE RLS with platform-admin-only writes;
-- this transaction-local flag lets the INSERTs below through (as 0010).
SELECT set_config('app.is_platform_admin', 'true', true);
--> statement-breakpoint

-- ============================================================================
-- Lookup codes
-- ============================================================================

INSERT INTO public.claim_verification_methods (code, label_key, sort_order) VALUES
  ('shop_front_photo', 'enum.claim_verification_methods.shop_front_photo', 15);
--> statement-breakpoint
INSERT INTO public.moderation_action_types (code, label_key, sort_order) VALUES
  ('claim_submitted', 'enum.moderation_action_types.claim_submitted', 100),
  ('claim_approved',  'enum.moderation_action_types.claim_approved',  110),
  ('claim_rejected',  'enum.moderation_action_types.claim_rejected',  120),
  ('reverted',        'enum.moderation_action_types.reverted',        130);
--> statement-breakpoint
INSERT INTO public.moderation_reasons (code, label_key, sort_order) VALUES
  ('otp_verified',          'enum.moderation_reasons.otp_verified',          200),
  ('owner_request',         'enum.moderation_reasons.owner_request',         210),
  ('place_already_claimed', 'enum.moderation_reasons.place_already_claimed', 220);
--> statement-breakpoint
INSERT INTO public.notification_types (code, label_key, sort_order) VALUES
  ('place_approved',       'enum.notification_types.place_approved',       220),
  ('place_rejected',       'enum.notification_types.place_rejected',       230),
  ('place_claim_approved', 'enum.notification_types.place_claim_approved', 240),
  ('place_claim_rejected', 'enum.notification_types.place_claim_rejected', 250);
--> statement-breakpoint

-- ============================================================================
-- places
-- ============================================================================

ALTER TABLE public.places
  ADD COLUMN claim_store_id uuid,
  ADD COLUMN street_photo_media_id uuid;
--> statement-breakpoint
ALTER TABLE public.places
  ADD CONSTRAINT places_tenant_id_claim_store_id_fk FOREIGN KEY (tenant_id, claim_store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE SET NULL (claim_store_id),
  ADD CONSTRAINT places_tenant_id_street_photo_media_id_fk FOREIGN KEY (tenant_id, street_photo_media_id)
    REFERENCES public.media_assets (tenant_id, id) ON DELETE SET NULL (street_photo_media_id),
  -- A claimed place has its owner; an owner without a store is never written.
  ADD CONSTRAINT places_claim_store_owner_ck
    CHECK (claim_store_id IS NULL OR claimed_by_member_id IS NOT NULL);
--> statement-breakpoint
-- One place per store (the store's map pin); also the FK index.
CREATE UNIQUE INDEX places_claim_store_id_uq ON public.places (tenant_id, claim_store_id)
  WHERE claim_store_id IS NOT NULL;
--> statement-breakpoint
-- FK index (§0.4).
CREATE INDEX places_street_photo_media_id_idx ON public.places (tenant_id, street_photo_media_id)
  WHERE street_photo_media_id IS NOT NULL;
--> statement-breakpoint
-- The contributions review queue, oldest first.
CREATE INDEX places_pending_review_idx ON public.places (tenant_id, id)
  WHERE status_code = 'pending_review' AND deleted_at IS NULL;
--> statement-breakpoint
-- "My contributions".
CREATE INDEX places_created_by_user_id_idx ON public.places (created_by_user_id, id DESC)
  WHERE created_by_user_id IS NOT NULL;
--> statement-breakpoint

CREATE POLICY places_creator_read ON public.places
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND created_by_user_id = (SELECT public.current_user_id())
    AND deleted_at IS NULL
  );
--> statement-breakpoint
CREATE POLICY places_owner_read ON public.places
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND claimed_by_member_id = (SELECT public.current_member_id())
  );
--> statement-breakpoint

-- Ownership and provenance are never a plain member's to write: the claim
-- columns change only through approve_place_claim() (which acts as system),
-- the creator is whoever inserted the row, ratings come from reviews. Agents
-- may set field_verified_at (they were there). A claimed owner may move their
-- place between published and temporarily/permanently closed, nothing else.
-- Silently reverted rather than rejected, like places_protect_landmark_columns.
CREATE OR REPLACE FUNCTION public.places_protect_system_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  open_states constant text[] := ARRAY['published', 'temporarily_closed', 'permanently_closed'];
BEGIN
  -- Guards the application's connection (ae_app; session_user stays ae_app
  -- inside SECURITY DEFINER functions too). Operators connecting as the owner
  -- or superuser (migrations, seeds, fixtures) are trusted, as for RLS.
  IF public.app_is_staff() OR public.app_is_system() OR public.is_platform_admin()
     OR session_user <> 'ae_app' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.claimed_by_member_id := NULL;
    NEW.claim_store_id := NULL;
    NEW.created_by_user_id := public.current_user_id();
    NEW.rating_avg := NULL;
    NEW.rating_count := 0;
    IF public.app_role() <> 'agent' THEN
      NEW.field_verified_at := NULL;
    END IF;
    IF NEW.status_code NOT IN ('pending_review', 'published') THEN
      NEW.status_code := 'pending_review';
    END IF;
  ELSE
    NEW.claimed_by_member_id := OLD.claimed_by_member_id;
    NEW.claim_store_id := OLD.claim_store_id;
    NEW.created_by_user_id := OLD.created_by_user_id;
    NEW.rating_avg := OLD.rating_avg;
    NEW.rating_count := OLD.rating_count;
    IF public.app_role() <> 'agent' THEN
      NEW.field_verified_at := OLD.field_verified_at;
      IF NEW.status_code IS DISTINCT FROM OLD.status_code
         AND NOT (OLD.status_code = ANY (open_states) AND NEW.status_code = ANY (open_states)) THEN
        NEW.status_code := OLD.status_code;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER places_a_protect_system_columns BEFORE INSERT OR UPDATE ON public.places
  FOR EACH ROW EXECUTE FUNCTION public.places_protect_system_columns();
--> statement-breakpoint

-- ============================================================================
-- place_revisions
-- ============================================================================

CREATE TABLE public.place_revisions (
  id                   uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id            uuid        NOT NULL DEFAULT public.current_tenant_id(),
  place_id             uuid        NOT NULL,
  -- {"name_bn": {"from": "…", "to": "…"}, "location": {"from": {"lat":…, "lng":…}, "to": …}, "hours": …}
  changed_fields       jsonb       NOT NULL,
  changed_by_user_id   uuid,
  kind_code            text        NOT NULL,
  reverts_revision_id  uuid,
  -- One revision per place per transaction: later changes in the same
  -- transaction merge into it. Immutable once that transaction commits.
  xact_id              xid8        NOT NULL DEFAULT pg_current_xact_id(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT place_revisions_pk PRIMARY KEY (id),
  CONSTRAINT place_revisions_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  -- Places are only ever soft-deleted by the app (no DELETE grant); a hard
  -- purge of a place takes its history with it.
  CONSTRAINT place_revisions_tenant_id_place_id_fk FOREIGN KEY (tenant_id, place_id)
    REFERENCES public.places (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT place_revisions_changed_by_user_id_fk FOREIGN KEY (changed_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT place_revisions_tenant_id_reverts_revision_id_fk FOREIGN KEY (tenant_id, reverts_revision_id)
    REFERENCES public.place_revisions (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT place_revisions_changed_fields_ck
    CHECK (jsonb_typeof(changed_fields) = 'object' AND changed_fields <> '{}'::jsonb),
  CONSTRAINT place_revisions_kind_code_ck
    CHECK (kind_code IN ('created', 'edited', 'claimed', 'reverted')),
  CONSTRAINT place_revisions_reverts_ck
    CHECK ((kind_code = 'reverted') = (reverts_revision_id IS NOT NULL)),
  -- Composite-FK target (§0.4).
  CONSTRAINT place_revisions_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- The merge target; one revision per place per transaction.
CREATE UNIQUE INDEX place_revisions_place_xact_uq ON public.place_revisions (place_id, xact_id);
--> statement-breakpoint
-- A place's history, newest first; also the FK index.
CREATE INDEX place_revisions_tenant_place_idx ON public.place_revisions (tenant_id, place_id, id DESC);
--> statement-breakpoint
-- FK indexes (§0.4); "what did this user change".
CREATE INDEX place_revisions_changed_by_user_id_idx ON public.place_revisions (changed_by_user_id, id DESC)
  WHERE changed_by_user_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX place_revisions_reverts_revision_id_idx ON public.place_revisions (tenant_id, reverts_revision_id)
  WHERE reverts_revision_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER place_revisions_set_updated_at BEFORE UPDATE ON public.place_revisions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- Append-only once committed: the merge of a later change in the SAME
-- transaction is the only UPDATE/DELETE ever allowed — besides the cascade
-- of a hard-purged place (its row is already gone when the cascade runs).
CREATE OR REPLACE FUNCTION public.place_revisions_prevent_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.places p WHERE p.id = OLD.place_id) THEN
    RETURN OLD;
  END IF;
  IF OLD.xact_id <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'place_revisions rows are immutable (% blocked)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint
CREATE TRIGGER place_revisions_a_prevent_mutation BEFORE UPDATE OR DELETE ON public.place_revisions
  FOR EACH ROW EXECUTE FUNCTION public.place_revisions_prevent_mutation();
--> statement-breakpoint

ALTER TABLE public.place_revisions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.place_revisions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The people who may edit a place may read its history. No write policy: rows
-- come only from the SECURITY DEFINER functions below.
CREATE POLICY place_revisions_editor_read ON public.place_revisions
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND (
      (SELECT public.app_is_staff())
      OR public.app_role() = 'agent'
      OR EXISTS (
        SELECT 1 FROM public.places p
        WHERE p.id = place_revisions.place_id
          AND p.claimed_by_member_id = (SELECT public.current_member_id())
      )
    )
  );
--> statement-breakpoint
CREATE POLICY place_revisions_platform_admin ON public.place_revisions
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint
GRANT SELECT ON public.place_revisions TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.place_revisions TO ae_rls_bypass;
--> statement-breakpoint

-- ============================================================================
-- place_claims
-- ============================================================================

ALTER TABLE public.place_claims
  ADD COLUMN evidence_codes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN otp_verified_phone_e164 text,
  ADD COLUMN otp_verified_at timestamptz,
  ADD COLUMN store_id uuid,
  ADD COLUMN review_note text;
--> statement-breakpoint
ALTER TABLE public.place_claims
  ADD CONSTRAINT place_claims_tenant_id_store_id_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE SET NULL (store_id),
  -- Known claim_verification_methods codes only. "At least one, from what
  -- the tenant accepts" is per-tenant configuration, checked by the API;
  -- claims recorded another way (an agent's visit) may carry none.
  ADD CONSTRAINT place_claims_evidence_codes_ck CHECK (
    evidence_codes <@ ARRAY['otp_to_listed_phone', 'shop_front_photo', 'trade_license', 'agent_visit', 'document']::text[]
  ),
  ADD CONSTRAINT place_claims_otp_ck CHECK ((otp_verified_at IS NULL) = (otp_verified_phone_e164 IS NULL)),
  ADD CONSTRAINT place_claims_store_ck CHECK (store_id IS NULL OR status_code IN ('approved', 'revoked'));
--> statement-breakpoint
-- At most one approved claim per place: the second of two concurrent
-- approvals fails here even if it got past every check.
CREATE UNIQUE INDEX place_claims_one_approved_uq ON public.place_claims (tenant_id, place_id)
  WHERE status_code = 'approved';
--> statement-breakpoint
-- FK index (§0.4).
CREATE INDEX place_claims_store_id_idx ON public.place_claims (tenant_id, store_id)
  WHERE store_id IS NOT NULL;
--> statement-breakpoint

-- Only staff and the system decide a claim. A claimant's INSERT always starts
-- pending with no review fields; their UPDATE can only withdraw (policy), and
-- never touches the evidence or the review fields.
CREATE OR REPLACE FUNCTION public.place_claims_protect_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Guards the application's connection (ae_app; session_user stays ae_app
  -- inside SECURITY DEFINER functions too). Operators connecting as the owner
  -- or superuser (migrations, seeds, fixtures) are trusted, as for RLS.
  IF public.app_is_staff() OR public.app_is_system() OR public.is_platform_admin()
     OR session_user <> 'ae_app' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.status_code := 'pending';
    NEW.reviewed_by_user_id := NULL;
    NEW.reviewed_at := NULL;
    NEW.rejection_reason_code := NULL;
    NEW.review_note := NULL;
    NEW.store_id := NULL;
  ELSE
    NEW.evidence_codes := OLD.evidence_codes;
    NEW.otp_verified_phone_e164 := OLD.otp_verified_phone_e164;
    NEW.otp_verified_at := OLD.otp_verified_at;
    NEW.reviewed_by_user_id := OLD.reviewed_by_user_id;
    NEW.reviewed_at := OLD.reviewed_at;
    NEW.rejection_reason_code := OLD.rejection_reason_code;
    NEW.review_note := OLD.review_note;
    NEW.store_id := OLD.store_id;
    NEW.place_id := OLD.place_id;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER place_claims_a_protect_status BEFORE INSERT OR UPDATE ON public.place_claims
  FOR EACH ROW EXECUTE FUNCTION public.place_claims_protect_status();
--> statement-breakpoint

-- ============================================================================
-- moderation_actions: places and claims as targets
-- ============================================================================

-- Relaxes NOT NULL on post_id (no column is dropped or renamed): a row now
-- targets exactly one of a post, a place or a place claim.
ALTER TABLE public.moderation_actions ALTER COLUMN post_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE public.moderation_actions
  ADD COLUMN place_id uuid,
  ADD COLUMN place_claim_id uuid;
--> statement-breakpoint
ALTER TABLE public.moderation_actions
  ADD CONSTRAINT moderation_actions_tenant_id_place_id_fk FOREIGN KEY (tenant_id, place_id)
    REFERENCES public.places (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT moderation_actions_tenant_id_place_claim_id_fk FOREIGN KEY (tenant_id, place_claim_id)
    REFERENCES public.place_claims (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT moderation_actions_one_target_ck
    CHECK (num_nonnulls(post_id, place_id, place_claim_id) = 1);
--> statement-breakpoint
-- A place's / a claim's moderation history; also the FK indexes.
CREATE INDEX moderation_actions_tenant_place_idx ON public.moderation_actions (tenant_id, place_id, id DESC)
  WHERE place_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX moderation_actions_tenant_place_claim_idx ON public.moderation_actions (tenant_id, place_claim_id, id DESC)
  WHERE place_claim_id IS NOT NULL;
--> statement-breakpoint
-- A claimant records their own submission (rule 13 audit trail);
-- every decision is staff's (moderation_actions_staff_insert) or the definer
-- functions below.
CREATE POLICY moderation_actions_claimant_insert ON public.moderation_actions
  FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND actor_user_id = (SELECT public.current_user_id())
    AND action_code = 'claim_submitted'
    AND place_claim_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.place_claims pc
      WHERE pc.id = moderation_actions.place_claim_id
        AND pc.claimant_member_id = (SELECT public.current_member_id())
    )
  );
--> statement-breakpoint
GRANT INSERT ON public.moderation_actions TO ae_rls_bypass;
--> statement-breakpoint

-- ============================================================================
-- Settings (CLAUDE.md rule 9)
-- ============================================================================

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('place_contribution_trust_threshold', '60', 'integer', 'points', 0, 101, 'platform',
   'Trust score at or above which a member''s new place goes live without review. Agents and staff always go live. 101 = always review.'),
  ('place_name_max_length', '120', 'integer', 'characters', 10, 500, 'none',
   'Longest place name (Bengali or English).'),
  ('place_max_photos', '10', 'integer', 'count', 0, 50, 'none',
   'Photos one place may carry, not counting the street photo.'),
  ('place_max_phones', '3', 'integer', 'count', 1, 10, 'none',
   'Phone numbers one place may list.'),
  ('place_claim_evidence_methods', '["otp_to_listed_phone", "shop_front_photo", "trade_license"]', 'text_array',
   NULL, NULL, NULL, 'tenant_admin',
   'Evidence a claimant may offer (at least one is required): an OTP to a number already on the place, a photo of the owner at the shop front, a trade licence. Tenant admins pick.'),
  ('place_claim_otp_auto_approve', 'false', 'boolean', NULL, NULL, NULL, 'tenant_admin',
   'An OTP-verified claim (the code went to a number already on the place) is approved at once, without a moderator.'),
  ('place_claim_max_documents', '5', 'integer', 'count', 1, 20, 'none',
   'Evidence files (shop-front photos and trade licence pages) one claim may carry.'),
  ('place_claim_note_max_length', '1000', 'integer', 'characters', 0, 5000, 'none',
   'Longest note a claimant or moderator may add to a claim.');
--> statement-breakpoint

-- ============================================================================
-- RBAC: the 'places' module, and a built-in role for field agents
-- ============================================================================

INSERT INTO public.roles (code, name, is_builtin, tenant_id) VALUES
  ('agent', 'Field Agent', true, NULL);
--> statement-breakpoint
INSERT INTO public.role_permissions (role_id, module, action)
SELECT r.id, grant_row.module, grant_row.action
FROM public.roles r
JOIN (VALUES
  ('agent', 'places', 'read'), ('agent', 'places', 'write'),
  ('agent', 'posts', 'read'), ('agent', 'posts', 'write'), ('agent', 'posts', 'delete'),
  ('moderator', 'places', 'read'), ('moderator', 'places', 'write'), ('moderator', 'places', 'approve'),
  ('seller', 'places', 'read'), ('seller', 'places', 'write'),
  ('member', 'places', 'read'), ('member', 'places', 'write')
) AS grant_row (role_code, module, action) ON grant_row.role_code = r.code
WHERE r.tenant_id IS NULL;
--> statement-breakpoint

-- ============================================================================
-- Revisions: the trigger and the helpers (owned by ae_rls_bypass)
-- ============================================================================

SET LOCAL ROLE ae_rls_bypass;
--> statement-breakpoint

-- Merges a change into the place's revision for this transaction (or starts
-- one): the earliest `from` and the latest `to` win; a field changed back to
-- where it started drops out, and a revision left empty is removed.
CREATE OR REPLACE FUNCTION public.place_revision_upsert(
  p_tenant_id uuid,
  p_place_id uuid,
  p_changed jsonb,
  p_kind text,
  p_reverts uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  existing public.place_revisions%ROWTYPE;
  merged jsonb;
  kind text;
BEGIN
  IF p_changed IS NULL OR p_changed = '{}'::jsonb THEN
    RETURN;
  END IF;
  SELECT * INTO existing FROM public.place_revisions
  WHERE place_id = p_place_id AND xact_id = pg_current_xact_id()
  FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.place_revisions
      (tenant_id, place_id, changed_fields, changed_by_user_id, kind_code, reverts_revision_id)
    VALUES (p_tenant_id, p_place_id, p_changed, public.current_user_id(), p_kind, p_reverts);
    RETURN;
  END IF;

  SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) INTO merged
  FROM (
    SELECT key AS k,
           CASE WHEN existing.changed_fields ? key AND p_changed ? key
                THEN jsonb_build_object('from', existing.changed_fields -> key -> 'from',
                                        'to', p_changed -> key -> 'to')
                ELSE coalesce(p_changed -> key, existing.changed_fields -> key)
           END AS v
    FROM (SELECT jsonb_object_keys(existing.changed_fields) AS key
          UNION SELECT jsonb_object_keys(p_changed)) keys
  ) m
  WHERE (v -> 'from') IS DISTINCT FROM (v -> 'to');

  IF merged = '{}'::jsonb THEN
    DELETE FROM public.place_revisions WHERE id = existing.id;
    RETURN;
  END IF;
  -- created > reverted > claimed > edited
  kind := CASE
    WHEN 'created' IN (existing.kind_code, p_kind) THEN 'created'
    WHEN 'reverted' IN (existing.kind_code, p_kind) THEN 'reverted'
    WHEN 'claimed' IN (existing.kind_code, p_kind) THEN 'claimed'
    ELSE 'edited'
  END;
  UPDATE public.place_revisions
  SET changed_fields = merged,
      kind_code = kind,
      reverts_revision_id = CASE WHEN kind = 'reverted' THEN coalesce(existing.reverts_revision_id, p_reverts) END
  WHERE id = existing.id;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.place_revision_upsert(uuid, uuid, jsonb, text, uuid) FROM PUBLIC;
--> statement-breakpoint

-- A place's versioned fields as jsonb, location as {lat, lng}.
CREATE OR REPLACE FUNCTION public.place_revision_fields(p public.places)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'name_bn', p.name_bn,
    'name_en', p.name_en,
    'description', p.description,
    'category_id', p.category_id,
    'phones', to_jsonb(p.phones),
    'address_text', p.address_text,
    'website_url', p.website_url,
    'facebook_url', p.facebook_url,
    'fields', p.fields,
    'location', jsonb_build_object(
      'lat', round(st_y(p.location::geometry)::numeric, 7),
      'lng', round(st_x(p.location::geometry)::numeric, 7)),
    'geo_area_id', p.geo_area_id,
    'outside_boundary', p.outside_boundary,
    'is_landmark', p.is_landmark,
    'landmark_radius_km', p.landmark_radius_km,
    'street_photo_media_id', p.street_photo_media_id,
    'status_code', p.status_code,
    'claimed_by_member_id', p.claimed_by_member_id,
    'claim_store_id', p.claim_store_id
  )
$$;
--> statement-breakpoint

-- Every INSERT/UPDATE of a place that changes a versioned field is a revision
-- (search sync, rating and timestamp bumps are not). Runs whoever wrote the
-- row, so no path can edit a place without leaving history.
CREATE OR REPLACE FUNCTION public.places_record_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  old_fields jsonb := CASE WHEN TG_OP = 'UPDATE' THEN public.place_revision_fields(OLD) ELSE '{}'::jsonb END;
  new_fields jsonb := public.place_revision_fields(NEW);
  changed jsonb;
  reverts uuid := nullif(current_setting('app.place_revision_reverts', true), '')::uuid;
  kind text;
BEGIN
  SELECT jsonb_object_agg(key, jsonb_build_object('from', old_fields -> key, 'to', value)) INTO changed
  FROM jsonb_each(new_fields)
  WHERE (old_fields -> key) IS DISTINCT FROM value
    AND NOT (TG_OP = 'INSERT' AND value = 'null'::jsonb);
  IF changed IS NULL THEN
    RETURN NULL;
  END IF;
  kind := CASE
    WHEN TG_OP = 'INSERT' THEN 'created'
    WHEN reverts IS NOT NULL THEN 'reverted'
    WHEN changed ? 'claimed_by_member_id' OR changed ? 'claim_store_id' THEN 'claimed'
    ELSE 'edited'
  END;
  PERFORM public.place_revision_upsert(NEW.tenant_id, NEW.id, changed, kind,
                                       CASE WHEN kind = 'reverted' THEN reverts END);
  RETURN NULL;
END
$$;
--> statement-breakpoint

-- Opening hours live in place_hours; the API calls this after replacing them,
-- in the same transaction, with the before/after weeks. Only someone who may
-- edit the place (its UPDATE policy: staff, agents, the claimed owner) or who
-- created it in this very transaction may record it.
CREATE OR REPLACE FUNCTION public.record_place_hours_revision(p_place_id uuid, p_from jsonb, p_to jsonb)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tenant uuid := public.current_tenant_id();
  pl public.places%ROWTYPE;
  just_created boolean;
BEGIN
  SELECT * INTO pl FROM public.places WHERE id = p_place_id AND tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_place_hours_revision: no place % in this tenant', p_place_id
      USING ERRCODE = 'no_data_found';
  END IF;
  just_created := EXISTS (
    SELECT 1 FROM public.place_revisions r
    WHERE r.place_id = p_place_id AND r.xact_id = pg_current_xact_id() AND r.kind_code = 'created'
      AND r.changed_by_user_id IS NOT DISTINCT FROM public.current_user_id()
  );
  -- coalesce: an unclaimed place's NULL owner must not turn the whole test NULL (= not raised).
  IF NOT (public.app_is_staff() OR public.app_role() = 'agent' OR public.app_is_system()
          OR coalesce(pl.claimed_by_member_id = public.current_member_id(), false)
          OR just_created) THEN
    RAISE EXCEPTION 'record_place_hours_revision: not an editor of place %', p_place_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_from IS NOT DISTINCT FROM p_to THEN
    RETURN;
  END IF;
  PERFORM public.place_revision_upsert(
    v_tenant, p_place_id,
    jsonb_build_object('hours', jsonb_build_object('from', p_from, 'to', p_to)),
    CASE WHEN just_created THEN 'created' ELSE 'edited' END,
    NULL);
END
$$;
--> statement-breakpoint

-- A place's opening hours as the jsonb a revision stores.
CREATE OR REPLACE FUNCTION public.place_hours_json(p_place_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'day', h.iso_day_of_week,
           'opens', to_char(h.opens_at, 'HH24:MI'),
           'closes', to_char(h.closes_at, 'HH24:MI'),
           'next_day', h.closes_next_day)
         ORDER BY h.iso_day_of_week, h.opens_at), '[]'::jsonb)
  FROM public.place_hours h
  WHERE h.place_id = p_place_id AND h.tenant_id = public.current_tenant_id()
$$;
--> statement-breakpoint

-- Staff put a revision's `from` values back, in one transaction with its
-- moderation_actions row. Content fields only: status and ownership have
-- their own flows. A field changed again since that revision (current value
-- <> its `to`) refuses the whole revert (AE222, the fields in DETAIL): revert
-- the newer revision first. Recorded as a `reverted` revision.
-- SQLSTATEs: no_data_found (no such revision of that place here), AE221
-- (nothing revertable in it), AE222 (superseded), insufficient_privilege.
CREATE OR REPLACE FUNCTION public.revert_place_revision(
  p_place_id uuid,
  p_revision_id uuid,
  p_reason_code text,
  p_reason_text text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := public.current_user_id();
  revertable constant text[] := ARRAY[
    'name_bn', 'name_en', 'description', 'category_id', 'phones', 'address_text', 'website_url',
    'facebook_url', 'fields', 'location', 'geo_area_id', 'outside_boundary', 'is_landmark',
    'landmark_radius_km', 'street_photo_media_id', 'hours'];
  rev public.place_revisions%ROWTYPE;
  pl public.places%ROWTYPE;
  current_fields jsonb;
  wanted jsonb;
  superseded text[];
  patched public.places%ROWTYPE;
  new_revision uuid;
BEGIN
  IF v_tenant IS NULL OR v_user IS NULL OR NOT public.app_is_staff() THEN
    RAISE EXCEPTION 'revert_place_revision: staff only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO pl FROM public.places WHERE id = p_place_id AND tenant_id = v_tenant FOR UPDATE;
  SELECT * INTO rev FROM public.place_revisions
  WHERE id = p_revision_id AND place_id = p_place_id AND tenant_id = v_tenant;
  IF pl.id IS NULL OR rev.id IS NULL THEN
    RAISE EXCEPTION 'revert_place_revision: no revision % of place %', p_revision_id, p_place_id
      USING ERRCODE = 'no_data_found';
  END IF;

  SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb) INTO wanted
  FROM jsonb_each(rev.changed_fields) WHERE key = ANY (revertable);
  IF wanted = '{}'::jsonb THEN
    RAISE EXCEPTION 'revert_place_revision: nothing revertable in %', p_revision_id USING ERRCODE = 'AE221';
  END IF;

  current_fields := public.place_revision_fields(pl)
    || jsonb_build_object('hours', public.place_hours_json(p_place_id));
  SELECT array_agg(key ORDER BY key) INTO superseded
  FROM jsonb_each(wanted)
  WHERE (current_fields -> key) IS DISTINCT FROM (value -> 'to');
  IF superseded IS NOT NULL THEN
    RAISE EXCEPTION 'revert_place_revision: changed again since %', p_revision_id
      USING ERRCODE = 'AE222', DETAIL = array_to_string(superseded, ',');
  END IF;

  PERFORM set_config('app.place_revision_reverts', p_revision_id::text, true);

  patched := jsonb_populate_record(pl, (
    SELECT coalesce(jsonb_object_agg(key, value -> 'from'), '{}'::jsonb)
    FROM jsonb_each(wanted) WHERE key NOT IN ('location', 'hours')));
  IF wanted ? 'location' THEN
    patched.location := public.geo_point(
      (wanted -> 'location' -> 'from' ->> 'lat')::double precision,
      (wanted -> 'location' -> 'from' ->> 'lng')::double precision);
  END IF;
  UPDATE public.places SET
    name_bn = patched.name_bn, name_en = patched.name_en, description = patched.description,
    category_id = patched.category_id, phones = patched.phones, address_text = patched.address_text,
    website_url = patched.website_url, facebook_url = patched.facebook_url, fields = patched.fields,
    location = patched.location, geo_area_id = patched.geo_area_id,
    outside_boundary = patched.outside_boundary, is_landmark = patched.is_landmark,
    landmark_radius_km = patched.landmark_radius_km,
    street_photo_media_id = patched.street_photo_media_id
  WHERE id = p_place_id;

  IF wanted ? 'hours' THEN
    DELETE FROM public.place_hours WHERE place_id = p_place_id AND tenant_id = v_tenant;
    INSERT INTO public.place_hours (tenant_id, place_id, iso_day_of_week, opens_at, closes_at, closes_next_day)
    SELECT v_tenant, p_place_id, (h ->> 'day')::smallint, (h ->> 'opens')::time, (h ->> 'closes')::time,
           (h ->> 'next_day')::boolean
    FROM jsonb_array_elements(wanted -> 'hours' -> 'from') h;
    PERFORM public.place_revision_upsert(
      v_tenant, p_place_id,
      jsonb_build_object('hours', jsonb_build_object('from', wanted -> 'hours' -> 'to',
                                                     'to', wanted -> 'hours' -> 'from')),
      'reverted', p_revision_id);
  END IF;

  PERFORM set_config('app.place_revision_reverts', '', true);

  INSERT INTO public.moderation_actions
    (tenant_id, place_id, actor_user_id, action_code, reason_code, reason_text, evidence_refs)
  VALUES (v_tenant, p_place_id, v_user, 'reverted', p_reason_code, p_reason_text,
          jsonb_build_array(jsonb_build_object('place_revision_id', p_revision_id)));

  SELECT id INTO new_revision FROM public.place_revisions
  WHERE place_id = p_place_id AND xact_id = pg_current_xact_id();
  RETURN new_revision;
END
$$;
--> statement-breakpoint

-- ============================================================================
-- approve_place_claim
-- ============================================================================

-- One transaction (the caller's): claim and place locked; the claimant's store
-- created (or p_store_id, theirs, linked); the place becomes that store's map
-- pin; saves and reviews carried over to the store; competing pending claims
-- rejected; every decision in moderation_actions.
--
-- p_auto = false: a moderator's decision (staff, never their own claim).
-- p_auto = true:  the claimant's own OTP-verified claim, only when the tenant
--                 offers otp_to_listed_phone AND place_claim_otp_auto_approve.
--
-- Status and ownership columns are protected by triggers that let only staff
-- or the system write them; for the auto path the writes below run with
-- app.role = 'system' for their duration, then the caller's role is restored.
--
-- SQLSTATEs: no_data_found (no such claim here), insufficient_privilege,
-- AE210 (claim not pending), AE211 (place already claimed), AE212 (place not
-- claimable: unpublished or deleted), AE213 (p_store_id isn't the claimant's
-- or is another place's pin), AE214 (auto-approval not allowed).
CREATE OR REPLACE FUNCTION public.approve_place_claim(p_claim_id uuid, p_store_id uuid, p_auto boolean)
RETURNS TABLE (
  place_id uuid,
  store_id uuid,
  created_store boolean,
  claimant_user_id uuid,
  superseded_claim_ids uuid[],
  superseded_user_ids uuid[]
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := public.current_user_id();
  v_member uuid := public.current_member_id();
  v_role text := public.app_role();
  c public.place_claims%ROWTYPE;
  pl public.places%ROWTYPE;
  st public.stores%ROWTYPE;
  v_store uuid;
  v_created boolean := false;
  v_slug text;
  v_methods jsonb;
  v_auto jsonb;
  v_superseded uuid[];
  v_superseded_users uuid[];
BEGIN
  IF v_tenant IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'approve_place_claim: no caller' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO c FROM public.place_claims WHERE id = p_claim_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approve_place_claim: no claim %', p_claim_id USING ERRCODE = 'no_data_found';
  END IF;

  IF p_auto THEN
    IF c.claimant_member_id IS DISTINCT FROM v_member THEN
      RAISE EXCEPTION 'approve_place_claim: not your claim' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT coalesce(ts.setting_overrides -> 'place_claim_evidence_methods', ps_m.value),
           coalesce(ts.setting_overrides -> 'place_claim_otp_auto_approve', ps_a.value)
      INTO v_methods, v_auto
    FROM public.platform_settings ps_m
    JOIN public.platform_settings ps_a ON ps_a.key = 'place_claim_otp_auto_approve'
    LEFT JOIN public.tenant_settings ts ON ts.tenant_id = v_tenant
    WHERE ps_m.key = 'place_claim_evidence_methods';
    IF c.otp_verified_at IS NULL OR v_auto IS DISTINCT FROM 'true'::jsonb
       OR NOT (v_methods ? 'otp_to_listed_phone') THEN
      RAISE EXCEPTION 'approve_place_claim: auto-approval not allowed' USING ERRCODE = 'AE214';
    END IF;
  ELSIF NOT public.app_is_staff() THEN
    RAISE EXCEPTION 'approve_place_claim: staff only' USING ERRCODE = 'insufficient_privilege';
  ELSIF c.claimant_member_id = v_member THEN
    RAISE EXCEPTION 'approve_place_claim: own claim' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF c.status_code <> 'pending' THEN
    RAISE EXCEPTION 'approve_place_claim: claim % is %', c.id, c.status_code USING ERRCODE = 'AE210';
  END IF;
  SELECT * INTO pl FROM public.places WHERE id = c.place_id AND tenant_id = v_tenant FOR UPDATE;
  IF pl.claimed_by_member_id IS NOT NULL OR pl.claim_store_id IS NOT NULL THEN
    RAISE EXCEPTION 'approve_place_claim: place % already claimed', pl.id USING ERRCODE = 'AE211';
  END IF;
  IF pl.deleted_at IS NOT NULL
     OR pl.status_code NOT IN ('published', 'temporarily_closed', 'permanently_closed') THEN
    RAISE EXCEPTION 'approve_place_claim: place % is not claimable', pl.id USING ERRCODE = 'AE212';
  END IF;

  PERFORM set_config('app.role', 'system', true);

  -- The store.
  IF p_store_id IS NOT NULL THEN
    SELECT * INTO st FROM public.stores
    WHERE id = p_store_id AND tenant_id = v_tenant AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND OR st.owner_member_id <> c.claimant_member_id
       OR (st.place_id IS NOT NULL AND st.place_id <> pl.id) THEN
      RAISE EXCEPTION 'approve_place_claim: store % not linkable', p_store_id USING ERRCODE = 'AE213';
    END IF;
    v_store := st.id;
    UPDATE public.stores
    SET place_id = pl.id,
        location = pl.location,
        address_text = coalesce(st.address_text, pl.address_text),
        locality_id = coalesce(st.locality_id, pl.locality_id)
    WHERE id = v_store;
  ELSE
    v_slug := pl.slug;
    IF EXISTS (SELECT 1 FROM public.stores s
               WHERE s.tenant_id = v_tenant AND s.slug = v_slug AND s.deleted_at IS NULL) THEN
      v_slug := v_slug || '-' || left(replace(gen_random_uuid()::text, '-', ''), 8);
    END IF;
    INSERT INTO public.stores
      (tenant_id, owner_member_id, place_id, slug, name_bn, name_en, phone_e164, address_text,
       locality_id, location, status_code)
    VALUES
      (v_tenant, c.claimant_member_id, pl.id, v_slug, pl.name_bn, pl.name_en,
       coalesce(c.otp_verified_phone_e164, pl.phones[1]), pl.address_text, pl.locality_id,
       pl.location, 'active')
    RETURNING id INTO v_store;
    v_created := true;
  END IF;

  -- The place becomes the store's pin.
  UPDATE public.places
  SET claimed_by_member_id = c.claimant_member_id, claim_store_id = v_store
  WHERE id = pl.id;

  UPDATE public.place_claims
  SET status_code = 'approved',
      store_id = v_store,
      reviewed_by_user_id = CASE WHEN p_auto THEN NULL ELSE v_user END,
      reviewed_at = now()
  WHERE id = c.id;

  -- Competing pending claims lose.
  WITH lost AS (
    UPDATE public.place_claims pc
    SET status_code = 'rejected', rejection_reason_code = 'place_already_claimed',
        reviewed_by_user_id = v_user, reviewed_at = now()
    WHERE pc.tenant_id = v_tenant AND pc.place_id = pl.id AND pc.status_code = 'pending' AND pc.id <> c.id
    RETURNING pc.id, pc.claimant_member_id
  )
  SELECT array_agg(lost.id ORDER BY lost.id), array_agg(tm.user_id ORDER BY lost.id)
    INTO v_superseded, v_superseded_users
  FROM lost JOIN public.tenant_members tm ON tm.tenant_id = v_tenant AND tm.id = lost.claimant_member_id;

  -- Carry-over: saves of the place become saves of the store; reviews of the
  -- place move to the store unless the reviewer already reviewed the store.
  INSERT INTO public.saved_stores (tenant_id, user_id, store_id)
  SELECT sp.tenant_id, sp.user_id, v_store FROM public.saved_places sp
  WHERE sp.tenant_id = v_tenant AND sp.place_id = pl.id
  ON CONFLICT (tenant_id, user_id, store_id) DO NOTHING;
  DELETE FROM public.saved_places sp WHERE sp.tenant_id = v_tenant AND sp.place_id = pl.id;

  UPDATE public.reviews r
  SET store_id = v_store, place_id = NULL
  WHERE r.tenant_id = v_tenant AND r.place_id = pl.id
    AND NOT EXISTS (
      SELECT 1 FROM public.reviews r2
      WHERE r2.tenant_id = v_tenant AND r2.store_id = v_store
        AND r2.reviewer_member_id = r.reviewer_member_id AND r2.deleted_at IS NULL);

  UPDATE public.stores s
  SET rating_avg = agg.avg_rating, rating_count = agg.n
  FROM (
    SELECT round(avg(r.rating)::numeric, 2) AS avg_rating, count(*)::integer AS n
    FROM public.reviews r
    WHERE r.tenant_id = v_tenant AND r.store_id = v_store
      AND r.status_code = 'published' AND r.deleted_at IS NULL
  ) agg
  WHERE s.id = v_store;
  UPDATE public.places p
  SET rating_avg = agg.avg_rating, rating_count = agg.n
  FROM (
    SELECT round(avg(r.rating)::numeric, 2) AS avg_rating, count(*)::integer AS n
    FROM public.reviews r
    WHERE r.tenant_id = v_tenant AND r.place_id = pl.id
      AND r.status_code = 'published' AND r.deleted_at IS NULL
  ) agg
  WHERE p.id = pl.id;

  -- The audit trail (rule 13): the approval, and each claim it displaced.
  INSERT INTO public.moderation_actions
    (tenant_id, place_claim_id, actor_user_id, action_code, reason_code, evidence_refs)
  VALUES (v_tenant, c.id, v_user, 'claim_approved',
          CASE WHEN p_auto THEN 'otp_verified' ELSE 'meets_guidelines' END,
          jsonb_build_array(jsonb_build_object('store_id', v_store, 'created_store', v_created,
                                               'evidence', to_jsonb(c.evidence_codes))));
  INSERT INTO public.moderation_actions
    (tenant_id, place_claim_id, actor_user_id, action_code, reason_code, evidence_refs)
  SELECT v_tenant, lost_id, v_user, 'claim_rejected', 'place_already_claimed',
         jsonb_build_array(jsonb_build_object('approved_claim_id', c.id))
  FROM unnest(coalesce(v_superseded, '{}'::uuid[])) AS lost_id;

  PERFORM set_config('app.role', v_role, true);

  RETURN QUERY
  SELECT pl.id, v_store, v_created,
         (SELECT tm.user_id FROM public.tenant_members tm
          WHERE tm.tenant_id = v_tenant AND tm.id = c.claimant_member_id),
         coalesce(v_superseded, '{}'::uuid[]), coalesce(v_superseded_users, '{}'::uuid[]);
END
$$;
--> statement-breakpoint

RESET ROLE;
--> statement-breakpoint

-- Last among the AFTER triggers (zz): records what the BEFORE triggers let through.
CREATE TRIGGER places_zz_record_revision AFTER INSERT OR UPDATE ON public.places
  FOR EACH ROW EXECUTE FUNCTION public.places_record_revision();
--> statement-breakpoint

ALTER FUNCTION public.place_revision_upsert(uuid, uuid, jsonb, text, uuid) OWNER TO ae_rls_bypass;
--> statement-breakpoint
ALTER FUNCTION public.places_record_revision() OWNER TO ae_rls_bypass;
--> statement-breakpoint
ALTER FUNCTION public.record_place_hours_revision(uuid, jsonb, jsonb) OWNER TO ae_rls_bypass;
--> statement-breakpoint
ALTER FUNCTION public.place_hours_json(uuid) OWNER TO ae_rls_bypass;
--> statement-breakpoint
ALTER FUNCTION public.revert_place_revision(uuid, uuid, text, text) OWNER TO ae_rls_bypass;
--> statement-breakpoint
ALTER FUNCTION public.approve_place_claim(uuid, uuid, boolean) OWNER TO ae_rls_bypass;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.record_place_hours_revision(uuid, jsonb, jsonb) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.place_hours_json(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.revert_place_revision(uuid, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.approve_place_claim(uuid, uuid, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.place_revision_fields(public.places) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_place_hours_revision(uuid, jsonb, jsonb) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.place_hours_json(uuid) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.revert_place_revision(uuid, uuid, text, text) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.approve_place_claim(uuid, uuid, boolean) TO ae_app;
--> statement-breakpoint
-- What the definer functions read and write beyond place_revisions.
GRANT SELECT, UPDATE ON public.places TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.place_hours TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.place_claims TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.stores TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.saved_places, public.saved_stores TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.reviews TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.tenant_members, public.platform_settings, public.tenant_settings TO ae_rls_bypass;
