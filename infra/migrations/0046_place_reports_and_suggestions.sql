-- 0046_place_reports_and_suggestions
--
-- Map-specific reporting and moderation (ADR 051).
--
--   reports               places were already a report target (0010); new
--                           reasons wrong_location, closed_permanently and
--                           inappropriate (duplicate and wrong_information
--                           exist).
--   report_place()        SECURITY DEFINER, as the reporter: one open report
--                           per reporter per place (0010's unique index), never
--                           on a place one owns, a moderation_actions row for
--                           the report (CLAUDE.md rule 13). When DISTINCT open
--                           closed_permanently reporters reach
--                           place_closed_report_threshold, the place gets
--                           possibly_closed_at (it stays visible) and a
--                           system moderation_actions row, in the same
--                           transaction; a moderator confirms or clears it.
--   places                + possibly_closed_at; staff/system only, as are
--                           merged_into_place_id (closes a gap: a claimed owner
--                           could set it with a plain UPDATE) and the 0042
--                           columns.
--   place_edit_suggestions  TENANT-SCOPED. A member's proposed location /
--                           phones / weekly hours for a place. Pending until a
--                           moderator approves (applied through the normal
--                           edit path, so place_revisions records it) or
--                           rejects it. Approved suggestions feed the
--                           suggester's trust score (trust_points_per_approved_edit).
--   suggest_place_edit()  SECURITY DEFINER: files a suggestion and its
--                           moderation_actions row in one transaction.
--   duplicate_candidates  source 'report': a duplicate report that names the
--                           other place lands in the duplicates queue, scored
--                           by place_pair_signals() (SECURITY DEFINER: the
--                           other place may be a neighbour tenant's).
--
-- Lookups, settings and notification types below. Seeds: lookups and
-- settings here; demo rows in the places seed. Tests:
-- apps/api/test/place-reports.db-spec.ts, apps/api/test/place-reports.e2e-spec.ts.

SELECT set_config('app.is_platform_admin', 'true', true);
--> statement-breakpoint

-- ============================================================================
-- Lookup codes
-- ============================================================================

INSERT INTO public.report_reasons (code, label_key, sort_order) VALUES
  ('wrong_location',     'enum.report_reasons.wrong_location',     62),
  ('closed_permanently', 'enum.report_reasons.closed_permanently', 64),
  ('inappropriate',      'enum.report_reasons.inappropriate',      75);
--> statement-breakpoint
INSERT INTO public.report_resolutions (code, label_key, sort_order) VALUES
  ('place_updated', 'enum.report_resolutions.place_updated', 60),
  ('place_closed',  'enum.report_resolutions.place_closed',  70);
--> statement-breakpoint
INSERT INTO public.moderation_action_types (code, label_key, sort_order) VALUES
  ('place_reported',          'enum.moderation_action_types.place_reported',          160),
  ('flagged_possibly_closed', 'enum.moderation_action_types.flagged_possibly_closed', 170),
  ('closed_confirmed',        'enum.moderation_action_types.closed_confirmed',        180),
  ('closed_flag_cleared',     'enum.moderation_action_types.closed_flag_cleared',     190),
  ('reports_dismissed',       'enum.moderation_action_types.reports_dismissed',       200),
  ('reports_resolved',        'enum.moderation_action_types.reports_resolved',        210),
  ('unpublished',             'enum.moderation_action_types.unpublished',             220),
  ('suggestion_submitted',    'enum.moderation_action_types.suggestion_submitted',    230),
  ('suggestion_approved',     'enum.moderation_action_types.suggestion_approved',     240),
  ('suggestion_rejected',     'enum.moderation_action_types.suggestion_rejected',     250);
--> statement-breakpoint
INSERT INTO public.moderation_reasons (code, label_key, sort_order) VALUES
  ('member_report',        'enum.moderation_reasons.member_report',        230),
  ('member_suggestion',    'enum.moderation_reasons.member_suggestion',    240),
  ('confirmed_closed',     'enum.moderation_reasons.confirmed_closed',     250),
  ('still_open',           'enum.moderation_reasons.still_open',           260),
  ('report_unfounded',     'enum.moderation_reasons.report_unfounded',     270),
  ('info_corrected',       'enum.moderation_reasons.info_corrected',       280),
  ('suggestion_incorrect', 'enum.moderation_reasons.suggestion_incorrect', 290);
--> statement-breakpoint
INSERT INTO public.notification_types (code, label_key, sort_order) VALUES
  ('place_edit_approved', 'enum.notification_types.place_edit_approved', 260),
  ('place_edit_rejected', 'enum.notification_types.place_edit_rejected', 270);
--> statement-breakpoint

-- The system flags a place as possibly closed without a user, as for an auto-hide.
ALTER TABLE public.moderation_actions DROP CONSTRAINT moderation_actions_actor_required_ck;
--> statement-breakpoint
ALTER TABLE public.moderation_actions ADD CONSTRAINT moderation_actions_actor_required_ck
  CHECK (actor_user_id IS NOT NULL
         OR action_code IN ('spam_auto_deleted', 'auto_hidden', 'flagged_possibly_closed'));
--> statement-breakpoint

ALTER TABLE public.duplicate_candidates DROP CONSTRAINT duplicate_candidates_source_ck;
--> statement-breakpoint
ALTER TABLE public.duplicate_candidates ADD CONSTRAINT duplicate_candidates_source_ck
  CHECK (source_code IN ('create', 'batch', 'report'));
--> statement-breakpoint

-- ============================================================================
-- places.possibly_closed_at
-- ============================================================================

ALTER TABLE public.places ADD COLUMN possibly_closed_at timestamptz;
--> statement-breakpoint
-- The "possibly closed" part of the reports queue.
CREATE INDEX places_possibly_closed_idx ON public.places (tenant_id, possibly_closed_at)
  WHERE possibly_closed_at IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint

-- 0042's guard, plus possibly_closed_at and merged_into_place_id: staff and
-- the system decide those, never a member or a claimed owner.
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
    NEW.possibly_closed_at := NULL;
    NEW.merged_into_place_id := NULL;
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
    NEW.merged_into_place_id := OLD.merged_into_place_id;
    -- Only report_place() (SECURITY DEFINER, owned by ae_rls_bypass) flags a
    -- place for its reporters; nobody's plain UPDATE does.
    IF current_user <> 'ae_rls_bypass' THEN
      NEW.possibly_closed_at := OLD.possibly_closed_at;
    END IF;
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

-- ============================================================================
-- place_edit_suggestions
-- ============================================================================

CREATE TABLE public.place_edit_suggestions (
  id                    uuid         NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id             uuid         NOT NULL DEFAULT public.current_tenant_id(),
  place_id              uuid         NOT NULL,
  suggester_member_id   uuid         NOT NULL,
  -- What to change: any of {location: {lat, lng}, phones: [E.164],
  -- hours: [{day, opens, closes}]}, validated by the API.
  changes               jsonb        NOT NULL,
  -- The place's values for those fields when suggested (what the moderator compares).
  current_values        jsonb        NOT NULL DEFAULT '{}',
  note                  text,
  status_code           text         NOT NULL DEFAULT 'pending',
  decided_by_user_id    uuid,
  decided_at            timestamptz,
  decision_reason_code  text,
  decision_note         text,
  created_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT place_edit_suggestions_pk PRIMARY KEY (id),
  CONSTRAINT place_edit_suggestions_tenant_id_place_id_fk FOREIGN KEY (tenant_id, place_id)
    REFERENCES public.places (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT place_edit_suggestions_tenant_id_suggester_member_id_fk FOREIGN KEY (tenant_id, suggester_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT place_edit_suggestions_decided_by_user_id_fk FOREIGN KEY (decided_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT place_edit_suggestions_decision_reason_code_fk FOREIGN KEY (decision_reason_code)
    REFERENCES public.moderation_reasons (code) ON DELETE RESTRICT,
  CONSTRAINT place_edit_suggestions_status_ck
    CHECK (status_code IN ('pending', 'approved', 'rejected', 'withdrawn')),
  CONSTRAINT place_edit_suggestions_decided_ck
    CHECK ((status_code IN ('approved', 'rejected')) = (decided_at IS NOT NULL)),
  CONSTRAINT place_edit_suggestions_changes_ck CHECK (
    jsonb_typeof(changes) = 'object'
    AND changes <> '{}'::jsonb
    AND changes - ARRAY['location', 'phones', 'hours'] = '{}'::jsonb
  ),
  CONSTRAINT place_edit_suggestions_current_values_ck CHECK (jsonb_typeof(current_values) = 'object'),
  CONSTRAINT place_edit_suggestions_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- One pending suggestion per member per place: a new one replaces nothing, it's refused.
CREATE UNIQUE INDEX place_edit_suggestions_pending_uq
  ON public.place_edit_suggestions (tenant_id, place_id, suggester_member_id)
  WHERE status_code = 'pending';
--> statement-breakpoint
-- The review queue, oldest first.
CREATE INDEX place_edit_suggestions_queue_idx ON public.place_edit_suggestions (tenant_id, id)
  WHERE status_code = 'pending';
--> statement-breakpoint
-- Trust: a member's approved suggestions; also the composite FK index.
CREATE INDEX place_edit_suggestions_suggester_idx
  ON public.place_edit_suggestions (tenant_id, suggester_member_id, status_code);
--> statement-breakpoint
-- FK index (§0.4).
CREATE INDEX place_edit_suggestions_place_idx ON public.place_edit_suggestions (tenant_id, place_id);
--> statement-breakpoint
CREATE INDEX place_edit_suggestions_decided_by_idx ON public.place_edit_suggestions (decided_by_user_id)
  WHERE decided_by_user_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER place_edit_suggestions_set_updated_at BEFORE UPDATE ON public.place_edit_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
ALTER TABLE public.place_edit_suggestions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.place_edit_suggestions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The suggester reads their own; nobody inserts directly (suggest_place_edit()).
CREATE POLICY place_edit_suggestions_suggester_read ON public.place_edit_suggestions
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND suggester_member_id = (SELECT public.current_member_id())
  );
--> statement-breakpoint
-- Staff review and decide, in their own tenant.
CREATE POLICY place_edit_suggestions_staff_read ON public.place_edit_suggestions
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY place_edit_suggestions_staff_update ON public.place_edit_suggestions
  FOR UPDATE
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
-- The system (trust inputs) reads across members.
CREATE POLICY place_edit_suggestions_system_read ON public.place_edit_suggestions
  FOR SELECT
  USING ((SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY place_edit_suggestions_platform_admin ON public.place_edit_suggestions
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.place_edit_suggestions TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.place_edit_suggestions TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.reports TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.places TO ae_rls_bypass;
--> statement-breakpoint

-- ============================================================================
-- report_place
-- ============================================================================

-- Files the caller's report on a public place (a repeat returns the open
-- one), with its moderation_actions row. On closed_permanently it counts the
-- DISTINCT open closed_permanently reporters; at place_closed_report_threshold
-- (tenant override, else platform; 0 = off) a place not yet flagged gets
-- possibly_closed_at and a system moderation_actions row listing the
-- reports. The place row is locked first, so two last reports can't both
-- miss or both cross the threshold.
--
-- SQLSTATEs: no_data_found = no such public place here; AE201 = the caller
-- owns it; insufficient_privilege = no member context.
CREATE OR REPLACE FUNCTION public.report_place(p_place_id uuid, p_reason_code text, p_details text)
RETURNS TABLE (report_id uuid, created boolean, flagged boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_member uuid := public.current_member_id();
  v_user uuid := public.current_user_id();
  v_place record;
  v_report uuid;
  v_created boolean := false;
  v_count integer;
  v_threshold integer;
  v_flagged boolean := false;
BEGIN
  IF v_tenant IS NULL OR v_member IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'report_place: a member context is required' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT p.id, p.claimed_by_member_id, p.created_by_user_id, p.possibly_closed_at, p.status_code
    INTO v_place
  FROM public.places p
  WHERE p.id = p_place_id
    AND p.tenant_id = v_tenant
    AND p.status_code IN ('published', 'temporarily_closed')
    AND p.deleted_at IS NULL
    AND p.merged_into_place_id IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'report_place: no public place % here', p_place_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_place.claimed_by_member_id = v_member THEN
    RAISE EXCEPTION 'report_place: own place' USING ERRCODE = 'AE201';
  END IF;

  INSERT INTO public.reports (tenant_id, reporter_member_id, place_id, reason_code, details)
  VALUES (v_tenant, v_member, p_place_id, p_reason_code, nullif(btrim(p_details), ''))
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_report;
  v_created := v_report IS NOT NULL;
  IF NOT v_created THEN
    SELECT r.id INTO v_report FROM public.reports r
    WHERE r.tenant_id = v_tenant AND r.reporter_member_id = v_member AND r.place_id = p_place_id
      AND r.status_code IN ('open', 'in_review');
    RETURN QUERY SELECT v_report, false, false;
    RETURN;
  END IF;

  INSERT INTO public.moderation_actions
    (tenant_id, place_id, actor_user_id, action_code, reason_code, reason_text, evidence_refs)
  VALUES (v_tenant, p_place_id, v_user, 'place_reported', 'member_report', p_reason_code,
          jsonb_build_array(v_report));

  IF p_reason_code = 'closed_permanently' AND v_place.possibly_closed_at IS NULL THEN
    SELECT count(DISTINCT r.reporter_member_id)::integer INTO v_count
    FROM public.reports r
    WHERE r.tenant_id = v_tenant AND r.place_id = p_place_id
      AND r.reason_code = 'closed_permanently' AND r.status_code IN ('open', 'in_review');

    SELECT coalesce((ts.setting_overrides ->> 'place_closed_report_threshold')::integer,
                    (ps.value #>> '{}')::integer)
      INTO v_threshold
    FROM public.platform_settings ps
    LEFT JOIN public.tenant_settings ts ON ts.tenant_id = v_tenant
    WHERE ps.key = 'place_closed_report_threshold';
    IF v_threshold IS NULL THEN
      RAISE EXCEPTION 'platform setting place_closed_report_threshold is missing';
    END IF;

    IF v_threshold > 0 AND v_count >= v_threshold THEN
      UPDATE public.places SET possibly_closed_at = now() WHERE id = p_place_id;
      INSERT INTO public.moderation_actions
        (tenant_id, place_id, actor_user_id, action_code, reason_code, reason_text, evidence_refs)
      SELECT v_tenant, p_place_id, NULL, 'flagged_possibly_closed', 'community_reports',
             format('%s distinct reporters (threshold %s)', v_count, v_threshold),
             coalesce(jsonb_agg(r.id ORDER BY r.id), '[]'::jsonb)
      FROM public.reports r
      WHERE r.tenant_id = v_tenant AND r.place_id = p_place_id
        AND r.reason_code = 'closed_permanently' AND r.status_code IN ('open', 'in_review');
      v_flagged := true;
    END IF;
  END IF;

  RETURN QUERY SELECT v_report, v_created, v_flagged;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.report_place(uuid, text, text) OWNER TO ae_rls_bypass;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.report_place(uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.report_place(uuid, text, text) TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- place_pair_signals
-- ============================================================================

-- The duplicate signals (0043) between a place of the caller's tenant and the
-- one a member's duplicate report names, which may be in a neighbouring
-- tenant (radius, never tenant: rule 10). No row when either is gone, merged
-- or rejected.
CREATE OR REPLACE FUNCTION public.place_pair_signals(p_place_id uuid, p_other_id uuid, p_stopwords text[])
RETURNS TABLE (
  other_tenant_id uuid,
  distance_m double precision,
  name_similarity real,
  phone_match boolean,
  same_category boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT b.tenant_id,
         st_distance(a.location, b.location),
         public.duplicate_name_similarity(a.name_bn, a.name_en, a.name_translit,
                                          b.name_bn, b.name_en, b.name_translit, p_stopwords),
         a.phones && b.phones,
         a.category_id = b.category_id
  FROM public.places a, public.places b
  WHERE a.id = p_place_id
    AND a.tenant_id = public.current_tenant_id()
    AND b.id = p_other_id
    AND a.id <> b.id
    AND a.deleted_at IS NULL AND b.deleted_at IS NULL
    AND a.merged_into_place_id IS NULL AND b.merged_into_place_id IS NULL
    AND b.status_code <> 'rejected'
$$;
--> statement-breakpoint
ALTER FUNCTION public.place_pair_signals(uuid, uuid, text[]) OWNER TO ae_rls_bypass;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.place_pair_signals(uuid, uuid, text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.place_pair_signals(uuid, uuid, text[]) TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- suggest_place_edit
-- ============================================================================

-- Files the caller's suggestion for a public place, with its
-- moderation_actions row. The API has validated and normalised p_changes.
--
-- SQLSTATEs: no_data_found = no such public place here; AE202 = a pending
-- suggestion by the caller for this place already exists;
-- insufficient_privilege = no member context.
CREATE OR REPLACE FUNCTION public.suggest_place_edit(
  p_place_id uuid,
  p_changes jsonb,
  p_current jsonb,
  p_note text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_member uuid := public.current_member_id();
  v_user uuid := public.current_user_id();
  v_id uuid;
BEGIN
  IF v_tenant IS NULL OR v_member IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'suggest_place_edit: a member context is required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1 FROM public.places p
  WHERE p.id = p_place_id
    AND p.tenant_id = v_tenant
    AND p.status_code IN ('published', 'temporarily_closed', 'permanently_closed')
    AND p.deleted_at IS NULL
    AND p.merged_into_place_id IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'suggest_place_edit: no public place % here', p_place_id USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO public.place_edit_suggestions
    (tenant_id, place_id, suggester_member_id, changes, current_values, note)
  VALUES (v_tenant, p_place_id, v_member, p_changes, coalesce(p_current, '{}'::jsonb),
          nullif(btrim(p_note), ''))
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'suggest_place_edit: a pending suggestion exists' USING ERRCODE = 'AE202';
  END IF;

  INSERT INTO public.moderation_actions
    (tenant_id, place_id, actor_user_id, action_code, reason_code, reason_text, evidence_refs)
  VALUES (v_tenant, p_place_id, v_user, 'suggestion_submitted', 'member_suggestion',
          (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(p_changes) AS k),
          jsonb_build_array(v_id));
  RETURN v_id;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.suggest_place_edit(uuid, jsonb, jsonb, text) OWNER TO ae_rls_bypass;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.suggest_place_edit(uuid, jsonb, jsonb, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.suggest_place_edit(uuid, jsonb, jsonb, text) TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- Settings (CLAUDE.md rule 9)
-- ============================================================================

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('place_closed_report_threshold', '3', 'integer', 'count', 0, 50, 'tenant_admin',
   'Distinct members reporting a place as closed permanently before it is flagged "possibly closed" for a moderator; 0 = never flag.'),
  ('place_suggestions_per_user_per_day', '10', 'integer', 'count', 1, 200, 'platform',
   'Edit suggestions one member may file per rolling 24 hours.'),
  ('place_suggestion_note_max_length', '300', 'integer', 'characters', 20, 2000, 'platform',
   'Longest note an edit suggestion may carry.'),
  ('place_report_queue_notes_max', '3', 'integer', 'count', 0, 20, 'none',
   'Reporters'' notes shown per place in the moderators'' reports queue (latest first).'),
  ('duplicate_report_radius_m', '1000', 'integer', 'meters', 50, 10000, 'platform',
   'A duplicate report may name another place at most this far away.'),
  ('trust_points_per_approved_edit', '2', 'integer', 'points', 0, 50, 'platform',
   'Trust points per approved place edit suggestion.'),
  ('trust_max_approved_edit_points', '10', 'integer', 'points', 0, 100, 'platform',
   'Cap on trust points from approved place edit suggestions.');
