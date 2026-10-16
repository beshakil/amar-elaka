-- 0061_info_services
--
-- The remaining local information services (ADR 065) on the info engine:
-- one card contract, one expiry job, one moderation path, one stale rule per
-- type (apps/api/src/info-engine). There is no `info_posts` table: each type
-- keeps its own (0011's notices, transport and lost & found; new ones here),
-- and the engine is the shared rules over them.
--
--   NEW utility_types              lookup: electricity | gas | water.
--   NEW utility_outages            TENANT-SCOPED: scheduled outages the partner enters.
--   NEW outage_reports             TENANT-SCOPED: "no power here now" from members;
--                                  shown only once outage_report_min_reports
--                                  distinct people in one area agree
--                                  (outage_report_clusters()).
--   transport_modes                + cng_stand.
--   transport_next_departures()    "next departure" in the area's own time.
--   notice_types                   + pourashava; + category_code (local |
--                                  community | advisory) and member_allowed.
--   notices                        + template_code / template_fields (the
--                                  respectful janaza/condolence template),
--                                  valid_from (the validity window's start).
--                                  Members may only post member_allowed types.
--   lost_found_items               + last_seen_at. EVERY member submission is
--                                  moderated; a member's later edit goes back
--                                  to review; a member may only mark their own
--                                  open item resolved. (0011 let a reporter set
--                                  their own item 'open' — fixed here.)
--   NEW gov_service_categories     lookup.
--   NEW gov_services               TENANT-SCOPED: the area's guide entries.
--   NEW gov_service_versions       TENANT-SCOPED, append-only: every edit is a
--                                  new version (gov_service_publish()).
--   commodity_groups               + board_code (bazar | agri) and the agri
--                                  input groups and commodities; the catalogue
--                                  and the fast entry take a board.
--   directory_places_near()        hospitals, clinics, pharmacies, schools… —
--                                  places by category, with the 24-hour flag.
--   expire_info_items()            the engine's one expiry job.
--   decide_info_item()             the engine's one moderation decision
--                                  (moderation_actions + notice_id /
--                                  lost_found_item_id targets).
--
-- Error codes: AE910 notice refused, AE911 lost & found refused, AE912
-- outage refused, AE913 gov service refused, AE914 moderation decision refused.
-- The DETAIL names the reason.

-- ============================================================================
-- Lookups
-- ============================================================================

CREATE TABLE public.utility_types (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT utility_types_pk PRIMARY KEY (code),
  CONSTRAINT utility_types_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER utility_types_set_updated_at BEFORE UPDATE ON public.utility_types
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.utility_types (code, label_key, sort_order) VALUES
  ('electricity', 'enum.utility_types.electricity', 10),
  ('gas', 'enum.utility_types.gas', 20),
  ('water', 'enum.utility_types.water', 30);
--> statement-breakpoint

CREATE TABLE public.gov_service_categories (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gov_service_categories_pk PRIMARY KEY (code),
  CONSTRAINT gov_service_categories_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER gov_service_categories_set_updated_at BEFORE UPDATE ON public.gov_service_categories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.gov_service_categories (code, label_key, sort_order) VALUES
  ('identity', 'enum.gov_service_categories.identity', 10),
  ('certificate', 'enum.gov_service_categories.certificate', 20),
  ('land', 'enum.gov_service_categories.land', 30),
  ('license', 'enum.gov_service_categories.license', 40),
  ('social_safety', 'enum.gov_service_categories.social_safety', 50),
  ('agriculture', 'enum.gov_service_categories.agriculture', 60),
  ('education', 'enum.gov_service_categories.education', 70),
  ('health', 'enum.gov_service_categories.health', 80),
  ('utility', 'enum.gov_service_categories.utility', 90),
  ('other', 'enum.gov_service_categories.other', 100);
--> statement-breakpoint

INSERT INTO public.transport_modes (code, label_key, sort_order) VALUES
  ('cng_stand', 'enum.transport_modes.cng_stand', 45)
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

-- What a notice type is for: an area's own board (local), what members may
-- post and moderators approve (community), or the partner's advisories.
ALTER TABLE public.notice_types
  ADD COLUMN category_code text NOT NULL DEFAULT 'local',
  ADD COLUMN member_allowed boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT notice_types_category_code_ck CHECK (category_code IN ('local', 'community', 'advisory'));
--> statement-breakpoint
INSERT INTO public.notice_types (code, label_key, sort_order) VALUES
  ('pourashava', 'enum.notice_types.pourashava', 25)
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint
UPDATE public.notice_types SET category_code = 'community', member_allowed = true
WHERE code IN ('community_event', 'obituary');
--> statement-breakpoint
UPDATE public.notice_types SET category_code = 'advisory' WHERE code = 'weather_alert';
--> statement-breakpoint

INSERT INTO public.lead_sources (code, label_key, sort_order) VALUES
  ('lost_found', 'enum.lead_sources.lost_found', 90);
--> statement-breakpoint

INSERT INTO public.moderation_action_types (code, label_key, sort_order) VALUES
  ('info_approved', 'enum.moderation_action_types.info_approved', 510),
  ('info_rejected', 'enum.moderation_action_types.info_rejected', 520),
  ('info_removed', 'enum.moderation_action_types.info_removed', 530);
--> statement-breakpoint
INSERT INTO public.moderation_reasons (code, label_key, sort_order) VALUES
  ('false_information', 'enum.moderation_reasons.false_information', 450),
  ('privacy_risk', 'enum.moderation_reasons.privacy_risk', 460),
  ('disrespectful', 'enum.moderation_reasons.disrespectful', 470)
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

INSERT INTO public.report_reasons (code, label_key, sort_order) VALUES
  ('false_information', 'enum.report_reasons.false_information', 100),
  ('privacy_risk', 'enum.report_reasons.privacy_risk', 110)
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

-- ============================================================================
-- Outages
-- ============================================================================

CREATE TABLE public.utility_outages (
  id                  uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id           uuid        NOT NULL DEFAULT public.current_tenant_id(),
  utility_code        text        NOT NULL,
  -- The area: a locality of the tenant, or the whole tenant (NULL), named for people.
  locality_id         uuid,
  area_text           text,
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NOT NULL,
  reason_text         text,
  -- scheduled → ended (by the expiry job) | cancelled (by the partner).
  status_code         text        NOT NULL DEFAULT 'scheduled',
  created_by_user_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CONSTRAINT utility_outages_pk PRIMARY KEY (id),
  CONSTRAINT utility_outages_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT utility_outages_utility_code_fk FOREIGN KEY (utility_code)
    REFERENCES public.utility_types (code) ON DELETE RESTRICT,
  CONSTRAINT utility_outages_tenant_id_locality_id_fk FOREIGN KEY (tenant_id, locality_id)
    REFERENCES public.localities (tenant_id, id) ON DELETE SET NULL (locality_id),
  CONSTRAINT utility_outages_created_by_user_id_fk FOREIGN KEY (created_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT utility_outages_window_ck CHECK (ends_at > starts_at),
  CONSTRAINT utility_outages_status_ck CHECK (status_code IN ('scheduled', 'ended', 'cancelled')),
  CONSTRAINT utility_outages_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
CREATE INDEX utility_outages_board_idx ON public.utility_outages (tenant_id, starts_at)
  WHERE status_code = 'scheduled' AND deleted_at IS NULL;
--> statement-breakpoint
-- Cross-tenant expiry.
CREATE INDEX utility_outages_expiry_idx ON public.utility_outages (ends_at) WHERE status_code = 'scheduled';
--> statement-breakpoint
CREATE TRIGGER utility_outages_set_updated_at BEFORE UPDATE ON public.utility_outages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE TABLE public.outage_reports (
  id                  uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id           uuid        NOT NULL DEFAULT public.current_tenant_id(),
  utility_code        text        NOT NULL,
  -- The nearest locality to where the member was (NULL: none near; the tenant).
  locality_id         uuid,
  reporter_user_id    uuid        NOT NULL,
  -- A report counts until then (outage_report_window_minutes).
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outage_reports_pk PRIMARY KEY (id),
  CONSTRAINT outage_reports_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT outage_reports_utility_code_fk FOREIGN KEY (utility_code)
    REFERENCES public.utility_types (code) ON DELETE RESTRICT,
  CONSTRAINT outage_reports_tenant_id_locality_id_fk FOREIGN KEY (tenant_id, locality_id)
    REFERENCES public.localities (tenant_id, id) ON DELETE SET NULL (locality_id),
  CONSTRAINT outage_reports_reporter_user_id_fk FOREIGN KEY (reporter_user_id)
    REFERENCES public.users (id) ON DELETE CASCADE
);
--> statement-breakpoint
-- The live clusters: unexpired reports per area and utility.
CREATE INDEX outage_reports_live_idx ON public.outage_reports (tenant_id, utility_code, locality_id, expires_at);
--> statement-breakpoint
-- One live report per person, utility and area (report_outage() refreshes it).
CREATE INDEX outage_reports_reporter_idx ON public.outage_reports (reporter_user_id, utility_code, expires_at);
--> statement-breakpoint
CREATE TRIGGER outage_reports_set_updated_at BEFORE UPDATE ON public.outage_reports
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- Notices: templates, validity, member limits by type
-- ============================================================================

ALTER TABLE public.notices
  ADD COLUMN template_code text,
  ADD COLUMN template_fields jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN valid_from timestamptz,
  ADD CONSTRAINT notices_template_code_ck CHECK (template_code IS NULL OR template_code IN ('janaza', 'condolence')),
  ADD CONSTRAINT notices_template_fields_ck CHECK (jsonb_typeof(template_fields) = 'object'),
  ADD CONSTRAINT notices_validity_ck CHECK (valid_from IS NULL OR expires_at IS NULL OR expires_at > valid_from);
--> statement-breakpoint

-- 0011's member limits, plus: a member may only post a member_allowed type.
CREATE OR REPLACE FUNCTION public.notices_enforce_member_limits()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT (public.app_is_staff() OR public.app_is_system()) THEN
    IF NOT EXISTS (SELECT 1 FROM public.notice_types t WHERE t.code = NEW.notice_type_code AND t.member_allowed)
       AND public.app_role() <> 'agent' THEN
      RAISE EXCEPTION 'notices: type not open to members' USING ERRCODE = 'AE910', DETAIL = 'type';
    END IF;
    IF public.app_role() <> 'agent' THEN
      NEW.status_code := 'pending_review';
      NEW.published_at := NULL;
    END IF;
    NEW.is_official := false;
    NEW.is_pinned := false;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- An author sees their own notices (waiting for review included); 0011 had
-- no such policy, so a member's INSERT … RETURNING could not read its row.
CREATE POLICY notices_author_read ON public.notices
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND published_by_member_id = (SELECT public.current_member_id()));
--> statement-breakpoint

-- Field agents enter the area's notices and advisories (partner-maintained).
CREATE POLICY notices_agent_write ON public.notices
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_role()) = 'agent')
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_role()) = 'agent');
--> statement-breakpoint
CREATE INDEX notices_pending_idx ON public.notices (tenant_id, id) WHERE status_code = 'pending_review' AND deleted_at IS NULL;
--> statement-breakpoint

-- ============================================================================
-- Lost & found: moderation for every member submission
-- ============================================================================

ALTER TABLE public.lost_found_items ADD COLUMN last_seen_at timestamptz;
--> statement-breakpoint

-- Replaces 0011's "sensitive only" rule (a reporter could set their own item
-- 'open'): a member's insert is always reviewed; a member's later edit goes
-- back to review; the one status a member sets is resolved (their own open item).
CREATE OR REPLACE FUNCTION public.lost_found_items_force_sensitive_review()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF public.app_is_staff() OR public.app_is_system() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.status_code := 'pending_review';
    NEW.resolved_at := NULL;
    RETURN NEW;
  END IF;
  IF NEW.status_code IS DISTINCT FROM OLD.status_code THEN
    IF NOT (OLD.status_code = 'open' AND NEW.status_code = 'resolved') THEN
      RAISE EXCEPTION 'lost_found: status' USING ERRCODE = 'AE911', DETAIL = 'status';
    END IF;
    NEW.resolved_at := now();
    RETURN NEW;
  END IF;
  IF (NEW.title, NEW.description, NEW.location_text, NEW.location, NEW.contact_phone_e164, NEW.item_type_code)
     IS DISTINCT FROM
     (OLD.title, OLD.description, OLD.location_text, OLD.location, OLD.contact_phone_e164, OLD.item_type_code)
     AND OLD.status_code IN ('open', 'pending_review') THEN
    NEW.status_code := 'pending_review';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE INDEX lost_found_items_pending_idx ON public.lost_found_items (tenant_id, id)
  WHERE status_code = 'pending_review' AND deleted_at IS NULL;
--> statement-breakpoint

-- ============================================================================
-- moderation_actions: notices and lost & found are takedown targets (rule 13)
-- ============================================================================

ALTER TABLE public.moderation_actions
  ADD COLUMN notice_id uuid,
  ADD COLUMN lost_found_item_id uuid,
  ADD CONSTRAINT moderation_actions_tenant_id_notice_id_fk FOREIGN KEY (tenant_id, notice_id)
    REFERENCES public.notices (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT moderation_actions_tenant_id_lost_found_item_id_fk FOREIGN KEY (tenant_id, lost_found_item_id)
    REFERENCES public.lost_found_items (tenant_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE public.moderation_actions DROP CONSTRAINT moderation_actions_one_target_ck;
--> statement-breakpoint
ALTER TABLE public.moderation_actions
  ADD CONSTRAINT moderation_actions_one_target_ck
    CHECK (num_nonnulls(post_id, place_id, place_claim_id, store_id, conversation_id, review_id, verification_id,
                        ban_id, blacklist_entry_id, blood_request_id, notice_id, lost_found_item_id) = 1);
--> statement-breakpoint
CREATE INDEX moderation_actions_tenant_notice_idx ON public.moderation_actions (tenant_id, notice_id, id DESC)
  WHERE notice_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX moderation_actions_tenant_lost_found_idx ON public.moderation_actions (tenant_id, lost_found_item_id, id DESC)
  WHERE lost_found_item_id IS NOT NULL;
--> statement-breakpoint

-- ============================================================================
-- Government service guide (versioned)
-- ============================================================================

CREATE TABLE public.gov_services (
  id                   uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id            uuid        NOT NULL DEFAULT public.current_tenant_id(),
  slug                 text        NOT NULL,
  category_code        text        NOT NULL,
  current_version_id   uuid,
  last_verified_on     date        NOT NULL,
  verified_by_user_id  uuid,
  is_active            boolean     NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,
  CONSTRAINT gov_services_pk PRIMARY KEY (id),
  CONSTRAINT gov_services_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT gov_services_category_code_fk FOREIGN KEY (category_code)
    REFERENCES public.gov_service_categories (code) ON DELETE RESTRICT,
  CONSTRAINT gov_services_verified_by_user_id_fk FOREIGN KEY (verified_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT gov_services_slug_ck CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT gov_services_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX gov_services_tenant_slug_uq ON public.gov_services (tenant_id, slug) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX gov_services_board_idx ON public.gov_services (tenant_id, category_code) WHERE is_active AND deleted_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER gov_services_set_updated_at BEFORE UPDATE ON public.gov_services
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE TABLE public.gov_service_versions (
  id                  uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id           uuid        NOT NULL DEFAULT public.current_tenant_id(),
  gov_service_id      uuid        NOT NULL,
  version_no          integer     NOT NULL,
  name_bn             text        NOT NULL,
  name_en             text,
  summary_bn          text,
  office_name         text        NOT NULL,
  office_place_id     uuid,
  address_text        text,
  location            geography(Point,4326),
  hours_text          text,
  -- ["জাতীয় পরিচয়পত্রের কপি", …]
  documents           jsonb       NOT NULL DEFAULT '[]',
  -- [{"label": "আবেদন ফি", "amount": "50.00"}, …] — money as strings.
  fees                jsonb       NOT NULL DEFAULT '[]',
  steps               jsonb       NOT NULL DEFAULT '[]',
  -- [{"label": "…", "url": "https://…"}]
  links               jsonb       NOT NULL DEFAULT '[]',
  change_note         text,
  created_by_user_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gov_service_versions_pk PRIMARY KEY (id),
  CONSTRAINT gov_service_versions_tenant_id_gov_service_id_fk FOREIGN KEY (tenant_id, gov_service_id)
    REFERENCES public.gov_services (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT gov_service_versions_tenant_id_office_place_id_fk FOREIGN KEY (tenant_id, office_place_id)
    REFERENCES public.places (tenant_id, id) ON DELETE SET NULL (office_place_id),
  CONSTRAINT gov_service_versions_created_by_user_id_fk FOREIGN KEY (created_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT gov_service_versions_service_version_uq UNIQUE (gov_service_id, version_no),
  CONSTRAINT gov_service_versions_arrays_ck CHECK (
    jsonb_typeof(documents) = 'array' AND jsonb_typeof(fees) = 'array'
    AND jsonb_typeof(steps) = 'array' AND jsonb_typeof(links) = 'array'
  ),
  CONSTRAINT gov_service_versions_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
CREATE TRIGGER gov_service_versions_set_updated_at BEFORE UPDATE ON public.gov_service_versions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
-- The office on the map (map_features' info layer).
CREATE INDEX gov_service_versions_location_gix ON public.gov_service_versions USING gist (location)
  WHERE location IS NOT NULL;
--> statement-breakpoint
ALTER TABLE public.gov_services
  ADD CONSTRAINT gov_services_tenant_id_current_version_id_fk FOREIGN KEY (tenant_id, current_version_id)
    REFERENCES public.gov_service_versions (tenant_id, id) ON DELETE SET NULL (current_version_id);
--> statement-breakpoint

-- ============================================================================
-- Agriculture: input prices on the bazar engine
-- ============================================================================

ALTER TABLE public.commodity_groups
  ADD COLUMN board_code text NOT NULL DEFAULT 'bazar',
  ADD CONSTRAINT commodity_groups_board_code_ck CHECK (board_code IN ('bazar', 'agri'));
--> statement-breakpoint
INSERT INTO public.commodity_groups (code, label_key, sort_order, board_code) VALUES
  ('fertilizer', 'enum.commodity_groups.fertilizer', 110, 'agri'),
  ('seed', 'enum.commodity_groups.seed', 120, 'agri'),
  ('pesticide', 'enum.commodity_groups.pesticide', 130, 'agri');
--> statement-breakpoint
INSERT INTO public.measurement_units (code, label_key, sort_order) VALUES
  ('bag_50kg', 'enum.measurement_units.bag_50kg', 70),
  ('packet', 'enum.measurement_units.packet', 80)
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint
INSERT INTO public.bazar_commodities (code, name_bn, name_en, group_code, default_unit_code, sort_order) VALUES
  ('urea', 'ইউরিয়া সার', 'Urea', 'fertilizer', 'kg', 1010),
  ('tsp', 'টিএসপি সার', 'TSP', 'fertilizer', 'kg', 1020),
  ('mop', 'এমওপি (পটাশ) সার', 'MoP (potash)', 'fertilizer', 'kg', 1030),
  ('dap', 'ডিএপি সার', 'DAP', 'fertilizer', 'kg', 1040),
  ('gypsum', 'জিপসাম সার', 'Gypsum', 'fertilizer', 'kg', 1050),
  ('seed-paddy-brri', 'ধানের বীজ (ব্রি)', 'Paddy seed (BRRI)', 'seed', 'kg', 1110),
  ('seed-paddy-hybrid', 'হাইব্রিড ধানের বীজ', 'Hybrid paddy seed', 'seed', 'kg', 1120),
  ('seed-potato', 'আলুর বীজ', 'Seed potato', 'seed', 'kg', 1130),
  ('seed-jute', 'পাটের বীজ', 'Jute seed', 'seed', 'kg', 1140),
  ('pesticide-insecticide', 'কীটনাশক', 'Insecticide', 'pesticide', 'litre', 1210),
  ('pesticide-fungicide', 'ছত্রাকনাশক', 'Fungicide', 'pesticide', 'kg', 1220),
  ('pesticide-herbicide', 'আগাছানাশক', 'Herbicide', 'pesticide', 'litre', 1230)
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

-- The board of one kind: the area's own items of that board, else every
-- active commodity of that board. THE catalogue rule (ADR 064), per board;
-- p_board NULL = both boards (what the fast entry accepts).
CREATE OR REPLACE FUNCTION public.bazar_catalogue_for(p_tenant_id uuid, p_board text)
RETURNS TABLE (commodity_id uuid, code text, name_bn text, name_en text, group_code text, unit_code text,
               sort_order integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH boards AS (
    SELECT b FROM unnest(CASE WHEN p_board IS NULL THEN ARRAY['bazar', 'agri'] ELSE ARRAY[p_board] END) b
  )
  SELECT c.id, c.code, c.name_bn, c.name_en, c.group_code, i.unit_code, i.sort_order
  FROM boards bd
  JOIN public.commodity_groups g ON g.board_code = bd.b
  JOIN public.bazar_commodities c ON c.group_code = g.code AND c.is_active
  JOIN public.tenant_bazar_items i ON i.commodity_id = c.id AND i.tenant_id = p_tenant_id AND i.is_active
  UNION ALL
  SELECT c.id, c.code, c.name_bn, c.name_en, c.group_code, c.default_unit_code, c.sort_order
  FROM boards bd
  JOIN public.commodity_groups g ON g.board_code = bd.b
  JOIN public.bazar_commodities c ON c.group_code = g.code AND c.is_active
  WHERE NOT EXISTS (
    SELECT 1 FROM public.tenant_bazar_items i
    JOIN public.bazar_commodities ic ON ic.id = i.commodity_id
    JOIN public.commodity_groups ig ON ig.code = ic.group_code
    WHERE i.tenant_id = p_tenant_id AND i.is_active AND ig.board_code = bd.b
  )
$$;
--> statement-breakpoint
-- 0060's functions are owned by ae_rls_bypass: replaced as their owner.
SET LOCAL ROLE ae_rls_bypass;
--> statement-breakpoint

-- 0060's name: the bazar board.
CREATE OR REPLACE FUNCTION public.bazar_catalogue(p_tenant_id uuid)
RETURNS TABLE (commodity_id uuid, code text, name_bn text, name_en text, group_code text, unit_code text,
               sort_order integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT c.commodity_id, c.code, c.name_bn, c.name_en, c.group_code, c.unit_code, c.sort_order
  FROM public.bazar_catalogue_for(p_tenant_id, 'bazar') c
$$;
--> statement-breakpoint

-- 0060's fast entry, accepting items of either board.
CREATE OR REPLACE FUNCTION public.bazar_enter_prices(p_date date, p_items jsonb)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_staff boolean := public.app_is_staff();
  v_today date;
  v_backdate integer;
  v_item jsonb;
  v_commodity uuid;
  v_unit text;
  v_min numeric(12,2);
  v_max numeric(12,2);
  v_count integer := 0;
BEGIN
  IF v_tenant IS NULL OR NOT public.app_is_active_user()
     OR NOT (v_staff OR public.app_role() = 'agent') THEN
    RAISE EXCEPTION 'bazar_enter_prices: staff or agents only' USING ERRCODE = 'AE903', DETAIL = 'role';
  END IF;
  v_today := public.tenant_local_today(v_tenant);
  v_backdate := (public.setting_value_for('bazar_entry_backdate_days', v_tenant) #>> '{}')::integer;
  IF p_date IS NULL OR p_date > v_today OR p_date < v_today - coalesce(v_backdate, 0) THEN
    RAISE EXCEPTION 'bazar_enter_prices: date' USING ERRCODE = 'AE903', DETAIL = 'date';
  END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'bazar_enter_prices: items' USING ERRCODE = 'AE903', DETAIL = 'item';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('bazar_enter_prices:' || v_tenant::text || ':' || p_date::text, 0));

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_commodity := (v_item ->> 'commodity_id')::uuid;
    v_unit := v_item ->> 'unit_code';
    v_min := (v_item ->> 'min_price')::numeric(12,2);
    v_max := (v_item ->> 'max_price')::numeric(12,2);
    IF NOT EXISTS (SELECT 1 FROM public.bazar_catalogue_for(v_tenant, NULL) c
                   WHERE c.commodity_id = v_commodity AND c.unit_code = v_unit) THEN
      RAISE EXCEPTION 'bazar_enter_prices: item not on the board' USING ERRCODE = 'AE903', DETAIL = 'item';
    END IF;
    IF v_min IS NULL OR v_max IS NULL OR v_min <= 0 OR v_max < v_min THEN
      RAISE EXCEPTION 'bazar_enter_prices: price' USING ERRCODE = 'AE903', DETAIL = 'price';
    END IF;

    UPDATE public.bazar_prices bp
    SET min_price = v_min, max_price = v_max,
        source_code = CASE WHEN v_staff THEN 'staff' ELSE 'agent' END,
        reported_by_member_id = public.current_member_id(),
        published_by_user_id = public.current_user_id()
    WHERE bp.tenant_id = v_tenant AND bp.commodity_id = v_commodity AND bp.unit_code = v_unit
      AND bp.price_date = p_date AND bp.bazar_market_id IS NULL AND bp.quality_note IS NULL
      AND bp.status_code = 'published';
    IF NOT FOUND THEN
      INSERT INTO public.bazar_prices
        (tenant_id, commodity_id, bazar_market_id, price_date, unit_code, min_price, max_price, source_code,
         reported_by_member_id, status_code, published_by_user_id)
      VALUES
        (v_tenant, v_commodity, NULL, p_date, v_unit, v_min, v_max, CASE WHEN v_staff THEN 'staff' ELSE 'agent' END,
         public.current_member_id(), 'published', public.current_user_id());
    END IF;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END
$$;
--> statement-breakpoint

RESET ROLE;
--> statement-breakpoint

-- ============================================================================
-- Settings (registry: apps/api/src/settings/settings.registry.ts)
-- ============================================================================

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('info_search_radius_km', '10', 'decimal', 'km', 1, 100, 'tenant_admin',
   'Local information lists (outages, notices, lost & found, transport, directories) cover this distance from the viewer, across areas.'),
  ('info_page_size_max', '50', 'integer', 'count', 5, 200, 'none',
   'Largest page of a local information list.'),
  ('info_job_batch_size', '500', 'integer', 'count', 10, 10000, 'none',
   'Most rows the local information expiry job handles per run and table.'),
  ('info_stale_days_transport', '90', 'integer', 'days', 1, 3650, 'tenant_admin',
   'A transport route not verified for this many days shows as possibly out of date.'),
  ('info_stale_days_gov_service', '180', 'integer', 'days', 1, 3650, 'tenant_admin',
   'A government service guide entry not verified for this many days shows as possibly out of date.'),
  ('info_stale_days_directory', '365', 'integer', 'days', 1, 3650, 'tenant_admin',
   'A directory place not field-verified or updated for this many days shows as possibly out of date.'),
  ('outage_report_min_reports', '3', 'integer', 'count', 1, 100, 'tenant_admin',
   'An area shows "reported outage" only once this many different people report it within the window.'),
  ('outage_report_window_minutes', '90', 'integer', 'minutes', 10, 1440, 'tenant_admin',
   'How long one "no power here now" report counts.'),
  ('outage_report_locality_km', '3', 'decimal', 'km', 0.2, 50, 'none',
   'A report is filed under the nearest locality within this distance; further away it counts for the whole area.'),
  ('outage_upcoming_hours', '48', 'integer', 'hours', 1, 720, 'tenant_admin',
   'Scheduled outages starting within this many hours are listed as upcoming.'),
  ('outage_end_grace_minutes', '30', 'integer', 'minutes', 0, 1440, 'none',
   'A scheduled outage is marked ended this long after its end time.'),
  ('notice_local_expiry_days', '30', 'integer', 'days', 1, 365, 'tenant_admin',
   'A local notice without its own end date stops showing after this many days.'),
  ('notice_community_expiry_days', '7', 'integer', 'days', 1, 90, 'tenant_admin',
   'A community notice stops showing after this many days.'),
  ('notice_obituary_expiry_days', '3', 'integer', 'days', 1, 30, 'tenant_admin',
   'A janaza or condolence notice stops showing after this many days.'),
  ('notice_attachments_max', '5', 'integer', 'count', 0, 20, 'none',
   'Most attachments (PDF or image) on one notice.'),
  ('notice_attachment_url_ttl_seconds', '600', 'integer', 'seconds', 60, 86400, 'none',
   'How long a notice attachment''s download link works.'),
  ('lost_found_expiry_days', '30', 'integer', 'days', 1, 365, 'tenant_admin',
   'An open lost & found report is archived after this many days.'),
  ('lost_found_photos_max', '4', 'integer', 'count', 0, 10, 'none',
   'Most photos on one lost & found report.'),
  ('transport_next_departures_max', '5', 'integer', 'count', 1, 50, 'none',
   'How many next departures a route shows.'),
  ('agri_services_enabled', 'false', 'boolean', NULL, NULL, NULL, 'platform',
   'Agriculture services (input prices, advisories, equipment rental) are shown in this area (rural tenants).'),
  ('prayer_calc_method', '"karachi"', 'text', NULL, NULL, NULL, 'tenant_admin',
   'Prayer time calculation method: karachi | mwl | isna | egypt | umm_al_qura (calculated on the device).'),
  ('prayer_asr_school', '"hanafi"', 'text', NULL, NULL, NULL, 'tenant_admin',
   'Asr shadow rule: hanafi | standard.'),
  ('prayer_hijri_adjust_days', '0', 'integer', 'days', -3, 3, 'tenant_admin',
   'Days added to the computed Hijri date (local moon sighting), which places Ramadan.'),
  ('prayer_sehri_caution_minutes', '0', 'integer', 'minutes', 0, 30, 'tenant_admin',
   'Sehri ends this many minutes before Fajr.'),
  ('prayer_iftar_caution_minutes', '0', 'integer', 'minutes', 0, 30, 'tenant_admin',
   'Iftar is this many minutes after Maghrib.'),
  ('feed_info_card_position', '5', 'integer', 'count', 0, 100, 'tenant_admin',
   'Slot on the first feed page where local information cards start (outages, notices, lost & found, departures); 0 = off.'),
  ('feed_info_cards_max', '2', 'integer', 'count', 1, 10, 'tenant_admin',
   'Most local information cards on the first feed page.'),
  ('feed_prayer_card_position', '2', 'integer', 'count', 0, 100, 'tenant_admin',
   'Slot on the first feed page for the prayer times card (the app calculates the times); 0 = off.');
--> statement-breakpoint

-- The Map tab: schools, colleges and madrasas join hospitals and pharmacies.
UPDATE public.platform_settings
SET value = value || '[{"code": "education", "icon": "school", "label_bn": "শিক্ষাপ্রতিষ্ঠান", "label_en": "Schools & colleges",
                        "sources": [{"table": "places", "categories": ["schools-colleges"]}]}]'::jsonb
WHERE key = 'map_kinds' AND NOT value @> '[{"code": "education"}]'::jsonb;
--> statement-breakpoint

-- ============================================================================
-- The map (ADR 045/046): the info layer also shows open lost & found reports,
-- government offices and outages on now (map_kinds below names them). Same
-- function as 0050 otherwise.
-- ============================================================================

SET LOCAL ROLE ae_rls_bypass;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.map_features(p_min_lng double precision, p_min_lat double precision, p_max_lng double precision, p_max_lat double precision, p_zoom integer, p_layers text[], p_category_slug text, p_open_now boolean, p_center_lat double precision, p_center_lng double precision, p_limit integer, p_kinds text[])
 RETURNS TABLE(layer text, point_count integer, lng double precision, lat double precision, id uuid, tenant_id uuid, name_bn text, name_en text, category_slug text, price text, slug text, info_kind text, open_now boolean, kind text, open_state text, open_changes_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
#variable_conflict use_column
DECLARE
  max_radius_km double precision;
  cell_px_setting integer;
  until_zoom integer;
  max_items integer;
  center geography;
  center_lng double precision;
  center_lat double precision;
  lng_scale double precision;
  box_fits boolean;
  radius_m double precision;
  envelope geometry;
  cell_px double precision;
  world_px double precision;
  cluster boolean;
  category_ids uuid[];
  info_place_categories text[];
  info_category_ids uuid[];
  envelope_g geography;
  kind_rules jsonb;
  open_only boolean := coalesce(p_open_now, false);
BEGIN
  IF p_min_lng IS NULL OR p_min_lat IS NULL OR p_max_lng IS NULL OR p_max_lat IS NULL
     OR p_min_lng >= p_max_lng OR p_min_lat >= p_max_lat
     OR p_min_lat < -90 OR p_max_lat > 90 OR p_min_lng < -180 OR p_max_lng > 180 THEN
    RAISE EXCEPTION 'map_features needs a bbox minLng < maxLng, minLat < maxLat'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_zoom IS NULL OR p_zoom < 0 OR p_zoom > 24 OR p_limit IS NULL OR p_limit <= 0 THEN
    RAISE EXCEPTION 'map_features needs a zoom 0-24 and a positive limit'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (p_center_lat IS NULL) <> (p_center_lng IS NULL) THEN
    RAISE EXCEPTION 'map_features needs both centre coordinates or neither'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT (ps.value #>> '{}')::double precision INTO max_radius_km
  FROM public.platform_settings ps WHERE ps.key = 'map_viewport_max_radius_km';
  SELECT (ps.value #>> '{}')::integer INTO cell_px_setting
  FROM public.platform_settings ps WHERE ps.key = 'map_cluster_cell_px';
  SELECT (ps.value #>> '{}')::integer INTO until_zoom
  FROM public.platform_settings ps WHERE ps.key = 'map_cluster_until_zoom';
  SELECT (ps.value #>> '{}')::integer INTO max_items
  FROM public.platform_settings ps WHERE ps.key = 'map_features_max';
  SELECT coalesce(array(SELECT jsonb_array_elements_text(ps.value)), '{}') INTO info_place_categories
  FROM public.platform_settings ps WHERE ps.key = 'map_info_place_categories';
  IF max_radius_km IS NULL OR cell_px_setting IS NULL OR until_zoom IS NULL OR max_items IS NULL THEN
    RAISE EXCEPTION 'platform settings map_viewport_max_radius_km / map_cluster_cell_px / map_cluster_until_zoom / map_features_max are missing';
  END IF;

  radius_m := max_radius_km * 1000;
  envelope := st_makeenvelope(p_min_lng, p_min_lat, p_max_lng, p_max_lat, 4326);
  envelope_g := envelope::geography;
  IF p_center_lat IS NOT NULL THEN
    center := st_setsrid(st_makepoint(p_center_lng, p_center_lat), 4326)::geography;
    box_fits := false;
  ELSE
    center := st_setsrid(st_makepoint((p_min_lng + p_max_lng) / 2, (p_min_lat + p_max_lat) / 2), 4326)::geography;
    IF st_distance(center, st_setsrid(st_makepoint(p_max_lng, p_max_lat), 4326)::geography) > radius_m THEN
      RAISE EXCEPTION 'map_features: a box wider than map_viewport_max_radius_km needs a centre'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    box_fits := true;
  END IF;

  center_lng := st_x(center::geometry);
  center_lat := st_y(center::geometry);
  lng_scale := cos(radians(center_lat)) ^ 2;

  cluster := p_zoom < until_zoom;
  cell_px := 256.0 / greatest(1, round(256.0 / cell_px_setting));
  world_px := 256 * power(2, p_zoom);

  IF p_category_slug IS NOT NULL THEN
    WITH RECURSIVE tree AS (
      SELECT c.id FROM public.categories c
      WHERE c.slug = p_category_slug AND c.deleted_at IS NULL AND c.is_active
      UNION ALL
      SELECT c.id FROM public.categories c JOIN tree t ON c.parent_id = t.id
      WHERE c.deleted_at IS NULL AND c.is_active
    )
    SELECT coalesce(array_agg(tree.id), '{}') INTO category_ids FROM tree;
  END IF;

  WITH RECURSIVE tree AS (
    SELECT c.id FROM public.categories c
    WHERE c.slug = ANY (coalesce(info_place_categories, '{}')) AND c.kind_code = 'place'
      AND c.deleted_at IS NULL AND c.is_active
    UNION ALL
    SELECT c.id FROM public.categories c JOIN tree t ON c.parent_id = t.id
    WHERE c.deleted_at IS NULL AND c.is_active
  )
  SELECT coalesce(array_agg(tree.id), '{}') INTO info_category_ids FROM tree;

  WITH RECURSIVE src AS (
    SELECT k.ord, k.def ->> 'code' AS code, s.src ->> 'table' AS tbl,
           s.src -> 'categories' AS cats, s.src -> 'service_types' AS types, s.idx
    FROM jsonb_array_elements(
           coalesce((SELECT ps.value FROM public.platform_settings ps WHERE ps.key = 'map_kinds'), '[]'))
         WITH ORDINALITY AS k(def, ord),
         jsonb_array_elements(k.def -> 'sources') WITH ORDINALITY AS s(src, idx)
  ),
  roots AS (
    SELECT src.ord, src.idx, c.id
    FROM src
    CROSS JOIN LATERAL jsonb_array_elements_text(src.cats) AS slug(value)
    JOIN public.categories c ON c.slug = slug.value AND c.deleted_at IS NULL AND c.is_active
  ),
  tree AS (
    SELECT * FROM roots
    UNION ALL
    SELECT t.ord, t.idx, c.id FROM tree t
    JOIN public.categories c ON c.parent_id = t.id AND c.deleted_at IS NULL AND c.is_active
  )
  SELECT coalesce(jsonb_agg(
           jsonb_build_object('ord', src.ord * 1000 + src.idx, 'code', src.code, 'table', src.tbl)
           || CASE WHEN src.cats IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('category_ids',
                coalesce((SELECT jsonb_agg(t.id) FROM tree t WHERE t.ord = src.ord AND t.idx = src.idx), '[]'))
              END
           || CASE WHEN src.types IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('service_types', src.types) END),
         '[]')
  INTO kind_rules
  FROM src;

  RETURN QUERY
    -- Phase 1, light: which features are in the box. The open state is only
    -- computed here when open_now filters on it; otherwise for the picked
    -- single features in phase 2.
    WITH rules AS (
      SELECT (r ->> 'ord')::integer AS ord, r ->> 'code' AS code, r ->> 'table' AS tbl,
             CASE WHEN r ? 'category_ids'
                  THEN ARRAY(SELECT jsonb_array_elements_text(r -> 'category_ids'))::uuid[] END AS cats,
             CASE WHEN r ? 'service_types'
                  THEN ARRAY(SELECT jsonb_array_elements_text(r -> 'service_types')) END AS types
      FROM jsonb_array_elements(kind_rules) AS r
    ),
    base AS (
      SELECT 'posts'::text AS layer, p.id, p.tenant_id, p.location::geometry AS g,
             'posts'::text AS src, p.category_id, NULL::text AS service_type
      FROM public.posts p
      WHERE 'posts' = ANY (p_layers)
        AND NOT open_only
        -- Like feed_posts: past expires_at counts as gone before the expiry job runs.
        AND public.post_is_listed(p.status_code, p.deleted_at, p.scrubbed_at, p.hidden_by_owner, p.store_hidden, p.expires_at, now())
        AND p.location && envelope_g AND p.location::geometry && envelope
        AND (box_fits OR st_dwithin(p.location, center, radius_m))
        AND (category_ids IS NULL OR p.category_id = ANY (category_ids))
      UNION ALL
      SELECT 'stores'::text, s.id, s.tenant_id, s.location::geometry, 'stores'::text, s.category_id, NULL::text
      FROM public.stores s
      WHERE 'stores' = ANY (p_layers)
        -- 0050: stores have a category now, so they follow the category filter.
        AND (category_ids IS NULL OR s.category_id = ANY (category_ids))
        AND s.status_code = 'active' AND s.deleted_at IS NULL AND s.location IS NOT NULL
        AND s.location && envelope_g AND s.location::geometry && envelope
        AND (box_fits OR st_dwithin(s.location, center, radius_m))
      UNION ALL
      SELECT pk.layer, pl.id, pl.tenant_id, pl.location::geometry, 'places'::text, pl.category_id, NULL::text
      FROM public.places pl
      CROSS JOIN LATERAL (
        SELECT CASE
                 WHEN pl.category_id = ANY (info_category_ids) THEN 'info'
                 WHEN pl.is_landmark THEN 'landmarks'
                 ELSE 'places'
               END::text AS layer
      ) pk
      WHERE pk.layer = ANY (p_layers)
        AND pl.status_code IN ('published', 'temporarily_closed') AND pl.deleted_at IS NULL
        -- 0050: a store's pin is drawn once, as the store (and not at all while
        -- the store is suspended or closed).
        AND pl.claim_store_id IS NULL
        AND pl.location && envelope_g AND pl.location::geometry && envelope
        AND (box_fits OR st_dwithin(pl.location, center, radius_m))
        AND (category_ids IS NULL OR pl.category_id = ANY (category_ids))
      UNION ALL
      SELECT 'info'::text, e.id, e.tenant_id, e.location::geometry, 'emergency'::text, NULL::uuid, e.service_type_code
      FROM public.emergency_contacts e
      WHERE 'info' = ANY (p_layers)
        AND p_category_slug IS NULL
        AND e.is_active AND e.deleted_at IS NULL AND e.location IS NOT NULL
        AND e.location && envelope_g AND e.location::geometry && envelope
        AND (box_fits OR st_dwithin(e.location, center, radius_m))
      UNION ALL
      SELECT 'info'::text, st.id, st.tenant_id, st.location::geometry, 'bus_stops'::text, NULL::uuid, NULL::text
      FROM public.transport_route_stops st
      JOIN public.transport_routes r ON r.tenant_id = st.tenant_id AND r.id = st.transport_route_id
      WHERE 'info' = ANY (p_layers)
        AND p_category_slug IS NULL
        AND r.is_active AND r.deleted_at IS NULL AND st.location IS NOT NULL
        AND st.location && envelope_g AND st.location::geometry && envelope
        AND (box_fits OR st_dwithin(st.location, center, radius_m))
      UNION ALL
      -- 0061, the info engine: open lost & found reports, where last seen.
      SELECT 'info'::text, i.id, i.tenant_id, i.location::geometry, 'lost_found'::text, NULL::uuid, i.kind_code
      FROM public.lost_found_items i
      WHERE 'info' = ANY (p_layers)
        AND p_category_slug IS NULL AND NOT open_only
        AND i.status_code = 'open' AND i.deleted_at IS NULL AND i.location IS NOT NULL
        AND (i.expires_at IS NULL OR i.expires_at > now())
        AND i.location && envelope_g AND i.location::geometry && envelope
        AND (box_fits OR st_dwithin(i.location, center, radius_m))
      UNION ALL
      -- Government offices: the current version's office.
      SELECT 'info'::text, g.id, g.tenant_id, v.location::geometry, 'gov_services'::text, NULL::uuid, g.category_code
      FROM public.gov_services g
      JOIN public.gov_service_versions v ON v.tenant_id = g.tenant_id AND v.id = g.current_version_id
      WHERE 'info' = ANY (p_layers)
        AND p_category_slug IS NULL AND NOT open_only
        AND g.is_active AND g.deleted_at IS NULL AND v.location IS NOT NULL
        AND v.location && envelope_g AND v.location::geometry && envelope
        AND (box_fits OR st_dwithin(v.location, center, radius_m))
      UNION ALL
      -- Outages on now, at their locality's centre (a whole-area one has no single point).
      SELECT 'info'::text, o.id, o.tenant_id, l.center::geometry, 'outages'::text, NULL::uuid, o.utility_code
      FROM public.utility_outages o
      JOIN public.localities l ON l.tenant_id = o.tenant_id AND l.id = o.locality_id
      WHERE 'info' = ANY (p_layers)
        AND p_category_slug IS NULL AND NOT open_only
        AND o.status_code = 'scheduled' AND o.deleted_at IS NULL
        AND o.starts_at <= now() AND o.ends_at > now()
        AND l.center IS NOT NULL AND l.deleted_at IS NULL
        AND l.center && envelope_g AND l.center::geometry && envelope
        AND (box_fits OR st_dwithin(l.center, center, radius_m))
    ),
    raw AS (
      SELECT b.*, o.state AS ostate, o.changes_at AS ochanges
      FROM base b
      -- is_open_at only when the condition holds: CASE guarantees the call is
      -- skipped, and OFFSET 0 keeps the planner from flattening this lateral
      -- back into a join filter applied after the call (0048).
      CROSS JOIN LATERAL (
        SELECT CASE WHEN open_only AND b.src IN ('stores', 'places', 'emergency')
                 THEN public.is_open_at(
                        CASE b.src WHEN 'stores' THEN 'store' WHEN 'places' THEN 'place' ELSE 'emergency' END,
                        b.id, now())
               END AS x
        OFFSET 0
      ) o0
      CROSS JOIN LATERAL (SELECT (o0.x).state, (o0.x).changes_at) o
      -- Bus stops are always "open"; everything else by is_open_at.
      WHERE NOT open_only OR b.src = 'bus_stops' OR o.state IN ('open', 'closes_soon')
    ),
    pts AS (
      SELECT raw.layer, raw.id, raw.tenant_id, raw.g, raw.src, raw.ostate, raw.ochanges, kk.code AS kind
      FROM raw
      LEFT JOIN LATERAL (
        SELECT ru.code FROM rules ru
        WHERE ru.tbl = raw.src
          AND (ru.cats IS NULL OR raw.category_id = ANY (ru.cats))
          AND (ru.types IS NULL OR raw.service_type = ANY (ru.types))
        ORDER BY ru.ord
        LIMIT 1
      ) kk ON true
      WHERE p_kinds IS NULL OR kk.code = ANY (p_kinds)
    ),
    keyed AS (
      SELECT pts.*,
             floor((st_x(pts.g) + 180) / 360 * world_px / cell_px) AS cx,
             floor((0.5 - ln(tan(pi() / 4 + radians(least(85.0511287798066, greatest(-85.0511287798066, st_y(pts.g)))) / 2)) / (2 * pi()))
                   * world_px / cell_px) AS cy
      FROM pts
      WHERE cluster
    ),
    cells AS (
      SELECT k.layer, k.kind, count(*)::integer AS n, avg(st_x(k.g)) AS lng, avg(st_y(k.g)) AS lat,
             CASE WHEN count(*) = 1 THEN max(k.id::text)::uuid END AS id,
             CASE WHEN count(*) = 1 THEN max(k.tenant_id::text)::uuid END AS tenant_id,
             CASE WHEN count(*) = 1 THEN max(k.src) END AS src,
             CASE WHEN count(*) = 1 THEN max(k.ostate) END AS ostate,
             CASE WHEN count(*) = 1 THEN max(k.ochanges) END AS ochanges
      FROM keyed k
      GROUP BY k.layer, k.kind, k.cx, k.cy
    ),
    candidates AS (
      SELECT * FROM cells
      UNION ALL
      SELECT pts.layer, pts.kind, 1, st_x(pts.g), st_y(pts.g), pts.id, pts.tenant_id, pts.src,
             pts.ostate, pts.ochanges
      FROM pts
      WHERE NOT cluster
    ),
    picked AS (
      SELECT c.*, (c.lng - center_lng) ^ 2 * lng_scale + (c.lat - center_lat) ^ 2 AS dist
      FROM candidates c
      ORDER BY c.n DESC, dist, c.layer, c.kind, c.id
      LIMIT least(p_limit, max_items + 1)
    ),
    -- Phase 2: the open state of each picked single feature (is_open_at,
    -- unless phase 1 already has it). Bus stops are always "open".
    stated AS (
      SELECT pk.*,
             CASE
               WHEN pk.n <> 1 THEN NULL
               WHEN pk.src = 'bus_stops' THEN 'open'
               WHEN pk.ostate IS NOT NULL THEN pk.ostate
               WHEN pk.src IN ('stores', 'places', 'emergency') THEN (os.x).state
             END AS st,
             CASE WHEN pk.n = 1 THEN coalesce(pk.ochanges, (os.x).changes_at) END AS chg
      FROM picked pk
      -- Same fix as phase 1: a post, a bus stop or a cluster never calls
      -- is_open_at (0048).
      CROSS JOIN LATERAL (
        SELECT CASE WHEN pk.n = 1 AND pk.ostate IS NULL AND pk.src IN ('stores', 'places', 'emergency')
                 THEN public.is_open_at(
                        CASE pk.src WHEN 'stores' THEN 'store' WHEN 'places' THEN 'place' ELSE 'emergency' END,
                        pk.id, now())
               END AS x
        OFFSET 0
      ) os
    )
    SELECT pk.layer, pk.n, pk.lng, pk.lat, pk.id, pk.tenant_id,
           CASE
             WHEN p.id IS NOT NULL THEN CASE WHEN p.title ~ '[ঀ-৿]' THEN p.title END
             ELSE coalesce(s.name_bn, pl.name_bn, e.name_bn, st.name_bn, lf.title, gsv.name_bn, ul.name_bn)
           END,
           CASE
             WHEN p.id IS NOT NULL THEN CASE WHEN p.title ~ '[ঀ-৿]' THEN NULL ELSE p.title END
             ELSE coalesce(s.name_en, pl.name_en, e.name_en, st.name_en, gsv.name_en, ul.name_en)
           END,
           CASE WHEN pk.layer = 'info' THEN NULL ELSE coalesce(pc.slug, plc.slug, sc.slug) END,
           p.price::text,
           coalesce(s.slug, pl.slug),
           CASE
             WHEN pk.layer <> 'info' THEN NULL
             WHEN e.id IS NOT NULL THEN e.service_type_code
             WHEN st.id IS NOT NULL THEN 'bus_stop'
             WHEN lf.id IS NOT NULL THEN 'lost_found'
             WHEN gs.id IS NOT NULL THEN 'gov_office'
             WHEN uo.id IS NOT NULL THEN 'outage'
             ELSE plc.slug
           END,
           CASE WHEN pk.st IN ('open', 'closes_soon') THEN true
                WHEN pk.st IN ('closed', 'opens_soon') THEN false END,
           pk.kind,
           pk.st,
           pk.chg
    FROM stated pk
    LEFT JOIN public.posts p ON pk.n = 1 AND pk.src = 'posts' AND p.id = pk.id
    LEFT JOIN public.categories pc ON pc.id = p.category_id
    LEFT JOIN public.stores s ON pk.n = 1 AND pk.src = 'stores' AND s.id = pk.id
    LEFT JOIN public.categories sc ON sc.id = s.category_id
    LEFT JOIN public.places pl ON pk.n = 1 AND pk.src = 'places' AND pl.id = pk.id
    LEFT JOIN public.categories plc ON plc.id = pl.category_id
    LEFT JOIN public.emergency_contacts e ON pk.n = 1 AND pk.src = 'emergency' AND e.id = pk.id
    LEFT JOIN public.transport_route_stops st ON pk.n = 1 AND pk.src = 'bus_stops' AND st.id = pk.id
    LEFT JOIN public.lost_found_items lf ON pk.n = 1 AND pk.src = 'lost_found' AND lf.id = pk.id
    LEFT JOIN public.gov_services gs ON pk.n = 1 AND pk.src = 'gov_services' AND gs.id = pk.id
    LEFT JOIN public.gov_service_versions gsv ON gsv.tenant_id = gs.tenant_id AND gsv.id = gs.current_version_id
    LEFT JOIN public.utility_outages uo ON pk.n = 1 AND pk.src = 'outages' AND uo.id = pk.id
    LEFT JOIN public.localities ul ON ul.tenant_id = uo.tenant_id AND ul.id = uo.locality_id
    ORDER BY pk.n DESC, pk.dist, pk.layer, pk.kind, pk.id;
END
$function$;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
UPDATE public.platform_settings
SET value = value || '[{"code": "lost_found", "icon": "lost", "label_bn": "হারানো-প্রাপ্তি", "label_en": "Lost & found",
                        "sources": [{"table": "lost_found"}]},
                       {"code": "gov_offices", "icon": "office", "label_bn": "সরকারি অফিস", "label_en": "Government offices",
                        "sources": [{"table": "gov_services"}]},
                       {"code": "outages", "icon": "power", "label_bn": "সংযোগ বন্ধ", "label_en": "Outages",
                        "sources": [{"table": "outages"}]}]'::jsonb
WHERE key = 'map_kinds' AND NOT value @> '[{"code": "lost_found"}]'::jsonb;
--> statement-breakpoint

-- ============================================================================
-- Notifications: the author hears the moderator's decision; a lost & found
-- reporter hears that someone contacted them (as a blood donor does, 0060)
-- ============================================================================

INSERT INTO public.notification_types (code, label_key, sort_order, default_channels) VALUES
  ('info_item_decided', 'enum.notification_types.info_item_decided', 430, '{in_app,push}'),
  ('lost_found_contacted', 'enum.notification_types.lost_found_contacted', 440, '{in_app,push}');
--> statement-breakpoint
INSERT INTO public.notification_templates
  (type_code, channel_code, locale, variant, title_template, body_template, variables)
VALUES
  ('info_item_decided', 'in_app', 'bn', 'single',
   '{{#approved}}আপনার পোস্ট প্রকাশিত হয়েছে{{/approved}}{{^approved}}আপনার পোস্ট প্রকাশ করা হয়নি{{/approved}}',
   '«{{title}}»{{#approved}} এখন সবাই দেখতে পাচ্ছেন।{{/approved}}{{^approved}} প্রকাশ করা হয়নি{{#reason}}: {{reason}}{{/reason}}।{{/approved}}',
   '{title,approved,reason}'),
  ('info_item_decided', 'in_app', 'en', 'single',
   '{{#approved}}Your post is live{{/approved}}{{^approved}}Your post was not published{{/approved}}',
   '"{{title}}"{{#approved}} is now visible to everyone.{{/approved}}{{^approved}} was not published{{#reason}}: {{reason}}{{/reason}}.{{/approved}}',
   '{title,approved,reason}'),
  ('lost_found_contacted', 'in_app', 'bn', 'single', 'হারানো-প্রাপ্তি: কেউ যোগাযোগ করেছেন',
   '«{{title}}» নিয়ে একজন আপনার সাথে যোগাযোগ করতে চেয়েছেন। ফোন বা এসএমএস খেয়াল রাখুন।',
   '{title}'),
  ('lost_found_contacted', 'in_app', 'en', 'single', 'Lost & found: someone got in touch',
   'Someone asked to contact you about "{{title}}". Watch for a call or SMS.',
   '{title}');
--> statement-breakpoint

-- ============================================================================
-- Scheduled job
-- ============================================================================

INSERT INTO public.scheduled_jobs (code, label_key, sort_order) VALUES
  ('expire-info-items', 'enum.scheduled_jobs.expire-info-items', 240);
--> statement-breakpoint

-- ============================================================================
-- Functions
-- ============================================================================

-- Nearby tenants' content: an item's own point, else its area's centre.
-- The radius readers below share this distance rule.
CREATE OR REPLACE FUNCTION public.info_point(p_location geography, p_tenant_id uuid)
RETURNS geography
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(p_location, (SELECT t.map_center FROM public.tenants t WHERE t.id = p_tenant_id))
$$;
--> statement-breakpoint

-- The locality a point belongs to: the nearest within outage_report_locality_km.
CREATE OR REPLACE FUNCTION public.nearest_locality(p_tenant_id uuid, p_point geography)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT l.id FROM public.localities l
  WHERE l.tenant_id = p_tenant_id AND l.is_active AND l.deleted_at IS NULL AND l.center IS NOT NULL
    AND st_dwithin(l.center, p_point,
                   (public.setting_value_for('outage_report_locality_km', NULL) #>> '{}')::double precision * 1000, false)
  ORDER BY st_distance(l.center, p_point, false), l.id
  LIMIT 1
$$;
--> statement-breakpoint

-- A member's "no power / gas / water here now": filed under the nearest
-- locality; one live report per person, utility and area (a repeat
-- refreshes it). Returns the area's live distinct-reporter count.
CREATE OR REPLACE FUNCTION public.report_outage(p_utility text, p_point geography)
RETURNS TABLE (locality_id uuid, reporters integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := public.current_user_id();
  v_locality uuid;
  v_window integer;
  v_id uuid;
BEGIN
  IF v_tenant IS NULL OR NOT public.app_is_active_user() THEN
    RAISE EXCEPTION 'report_outage: sign in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.utility_types u WHERE u.code = p_utility AND u.is_active) THEN
    RAISE EXCEPTION 'report_outage: utility' USING ERRCODE = 'AE912', DETAIL = 'utility';
  END IF;
  v_locality := CASE WHEN p_point IS NULL THEN NULL ELSE public.nearest_locality(v_tenant, p_point) END;
  v_window := (public.setting_value_for('outage_report_window_minutes', v_tenant) #>> '{}')::integer;

  SELECT r.id INTO v_id FROM public.outage_reports r
  WHERE r.tenant_id = v_tenant AND r.reporter_user_id = v_user AND r.utility_code = p_utility
    AND r.locality_id IS NOT DISTINCT FROM v_locality AND r.expires_at > now()
  FOR UPDATE;
  IF FOUND THEN
    UPDATE public.outage_reports r SET expires_at = now() + make_interval(mins => v_window) WHERE r.id = v_id;
  ELSE
    INSERT INTO public.outage_reports (tenant_id, utility_code, locality_id, reporter_user_id, expires_at)
    VALUES (v_tenant, p_utility, v_locality, v_user, now() + make_interval(mins => v_window));
  END IF;

  RETURN QUERY
    SELECT v_locality, count(DISTINCT r.reporter_user_id)::integer
    FROM public.outage_reports r
    WHERE r.tenant_id = v_tenant AND r.utility_code = p_utility
      AND r.locality_id IS NOT DISTINCT FROM v_locality AND r.expires_at > now();
END
$$;
--> statement-breakpoint

-- Reported outages near a point, from every area (rule 10): one row per
-- area and utility with at least outage_report_min_reports distinct live
-- reporters (the area's own setting). Counts only — never who.
CREATE OR REPLACE FUNCTION public.outage_report_clusters(p_origin geography, p_radius_km double precision)
RETURNS TABLE (tenant_id uuid, utility_code text, locality_id uuid, area_bn text, area_en text,
               reporters integer, first_at timestamptz, last_at timestamptz, distance_m double precision)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT r.tenant_id, r.utility_code, r.locality_id,
         coalesce(l.name_bn, t.name_bn), coalesce(l.name_en, t.name_en),
         count(DISTINCT r.reporter_user_id)::integer, min(r.created_at), max(r.updated_at),
         st_distance(coalesce(l.center, t.map_center), p_origin, false)
  FROM public.outage_reports r
  JOIN public.tenants t ON t.id = r.tenant_id
  LEFT JOIN public.localities l ON l.tenant_id = r.tenant_id AND l.id = r.locality_id
  WHERE r.expires_at > now()
    AND st_dwithin(coalesce(l.center, t.map_center), p_origin, p_radius_km * 1000, false)
  GROUP BY r.tenant_id, r.utility_code, r.locality_id, l.name_bn, l.name_en, t.name_bn, t.name_en, l.center, t.map_center
  HAVING count(DISTINCT r.reporter_user_id)
         >= (public.setting_value_for('outage_report_min_reports', r.tenant_id) #>> '{}')::integer
  ORDER BY 9, 2
$$;
--> statement-breakpoint

-- Scheduled outages near a point (any area): ongoing, and upcoming within
-- outage_upcoming_hours (the area's setting).
CREATE OR REPLACE FUNCTION public.utility_outages_near(p_origin geography, p_radius_km double precision, p_limit integer)
RETURNS TABLE (id uuid, tenant_id uuid, utility_code text, area_bn text, area_en text, area_text text,
               starts_at timestamptz, ends_at timestamptz, reason_text text, updated_at timestamptz,
               distance_m double precision)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT o.id, o.tenant_id, o.utility_code, coalesce(l.name_bn, t.name_bn), coalesce(l.name_en, t.name_en),
         o.area_text, o.starts_at, o.ends_at, o.reason_text, o.updated_at,
         st_distance(coalesce(l.center, t.map_center), p_origin, false)
  FROM public.utility_outages o
  JOIN public.tenants t ON t.id = o.tenant_id
  LEFT JOIN public.localities l ON l.tenant_id = o.tenant_id AND l.id = o.locality_id
  WHERE o.status_code = 'scheduled' AND o.deleted_at IS NULL AND o.ends_at > now()
    AND o.starts_at < now() + make_interval(hours => (public.setting_value_for('outage_upcoming_hours', o.tenant_id) #>> '{}')::integer)
    AND st_dwithin(coalesce(l.center, t.map_center), p_origin, p_radius_km * 1000, false)
  ORDER BY o.starts_at, o.id
  LIMIT p_limit
$$;
--> statement-breakpoint

-- Published notices near a point (any area within the radius of its centre),
-- pinned first, then newest; the validity window applies.
CREATE OR REPLACE FUNCTION public.notices_near(p_origin geography, p_radius_km double precision, p_category text,
                                              p_limit integer)
RETURNS TABLE (id uuid, tenant_id uuid, notice_type_code text, category_code text, title text, body text,
               issuer_name text, is_official boolean, is_pinned boolean, template_code text, template_fields jsonb,
               event_starts_at timestamptz, event_ends_at timestamptz, valid_from timestamptz,
               expires_at timestamptz, published_at timestamptz, updated_at timestamptz, area_bn text,
               distance_m double precision, attachments integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT n.id, n.tenant_id, n.notice_type_code, nt.category_code, n.title, n.body, n.issuer_name, n.is_official,
         n.is_pinned, n.template_code, n.template_fields, n.event_starts_at, n.event_ends_at, n.valid_from,
         n.expires_at, n.published_at, n.updated_at, t.name_bn, st_distance(t.map_center, p_origin, false),
         (SELECT count(*)::integer FROM public.media_attachments a WHERE a.tenant_id = n.tenant_id AND a.notice_id = n.id)
  FROM public.notices n
  JOIN public.notice_types nt ON nt.code = n.notice_type_code
  JOIN public.tenants t ON t.id = n.tenant_id
  WHERE n.status_code = 'published' AND n.deleted_at IS NULL
    AND (n.valid_from IS NULL OR n.valid_from <= now()) AND (n.expires_at IS NULL OR n.expires_at > now())
    AND (p_category IS NULL OR nt.category_code = p_category)
    AND st_dwithin(t.map_center, p_origin, p_radius_km * 1000, false)
  ORDER BY n.is_pinned DESC, n.published_at DESC NULLS LAST, n.id DESC
  LIMIT p_limit
$$;
--> statement-breakpoint

-- Open lost & found reports near a point (any area). Never a phone number.
CREATE OR REPLACE FUNCTION public.lost_found_near(p_origin geography, p_radius_km double precision, p_kind text,
                                                 p_item_type text, p_limit integer)
RETURNS TABLE (id uuid, tenant_id uuid, kind_code text, item_type_code text, title text, description text,
               location_text text, last_seen_at timestamptz, occurred_on date, reward_amount text,
               updated_at timestamptz, created_at timestamptz, lat double precision, lng double precision,
               distance_m double precision, photo_variants jsonb, photo_thumbhash text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT i.id, i.tenant_id, i.kind_code, i.item_type_code, i.title, i.description, i.location_text,
         i.last_seen_at, i.occurred_on, i.reward_amount::text, i.updated_at, i.created_at,
         st_y(i.location::geometry), st_x(i.location::geometry),
         st_distance(public.info_point(i.location, i.tenant_id), p_origin, false),
         p.variants, p.thumbhash
  FROM public.lost_found_items i
  LEFT JOIN LATERAL (
    SELECT m.variants, m.thumbhash FROM public.media_attachments a
    JOIN public.media_assets m ON m.tenant_id = a.tenant_id AND m.id = a.media_asset_id
    WHERE a.tenant_id = i.tenant_id AND a.lost_found_item_id = i.id
      AND m.status_code = 'ready' AND m.visibility_code = 'public' AND m.deleted_at IS NULL
    ORDER BY a.sort_order, a.id LIMIT 1
  ) p ON true
  WHERE i.status_code = 'open' AND i.deleted_at IS NULL
    AND (p_kind IS NULL OR i.kind_code = p_kind)
    AND (p_item_type IS NULL OR i.item_type_code = p_item_type)
    AND st_dwithin(public.info_point(i.location, i.tenant_id), p_origin, p_radius_km * 1000, false)
  ORDER BY i.id DESC
  LIMIT p_limit
$$;
--> statement-breakpoint

-- Active routes near a point (any area): a stop, the origin or the
-- destination within the radius, else the area's centre.
CREATE OR REPLACE FUNCTION public.transport_routes_near(p_origin geography, p_radius_km double precision,
                                                       p_mode text, p_limit integer)
RETURNS TABLE (id uuid, tenant_id uuid, mode_code text, name_bn text, name_en text, operator_name text,
               origin_name text, destination_name text, fare_min text, fare_max text, fare_updated_on date,
               last_verified_at timestamptz, updated_at timestamptz, distance_m double precision)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT r.id, r.tenant_id, r.mode_code, r.name_bn, r.name_en, r.operator_name, r.origin_name, r.destination_name,
         r.fare_min::text, r.fare_max::text, r.fare_updated_on, r.last_verified_at, r.updated_at, d.dist
  FROM public.transport_routes r
  JOIN public.tenants t ON t.id = r.tenant_id
  CROSS JOIN LATERAL (
    SELECT least(
      st_distance(coalesce(r.origin_location, t.map_center), p_origin, false),
      coalesce(st_distance(r.destination_location, p_origin, false), 'infinity'::double precision),
      coalesce((SELECT min(st_distance(s.location, p_origin, false)) FROM public.transport_route_stops s
                WHERE s.tenant_id = r.tenant_id AND s.transport_route_id = r.id AND s.location IS NOT NULL),
               'infinity'::double precision)
    ) AS dist
  ) d
  WHERE r.is_active AND r.deleted_at IS NULL
    AND (p_mode IS NULL OR r.mode_code = p_mode)
    AND d.dist <= p_radius_km * 1000
  ORDER BY d.dist, r.id
  LIMIT p_limit
$$;
--> statement-breakpoint

-- The next departures of a route from p_at, in the route area's own time:
-- today's later departures, then tomorrow's — each on a day of its
-- iso_days_of_week, inside its validity dates.
CREATE OR REPLACE FUNCTION public.transport_next_departures(p_route_id uuid, p_at timestamptz, p_limit integer)
RETURNS TABLE (schedule_id uuid, direction_code text, departs_at timestamptz, service_class text, fare text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH r AS (
    SELECT tr.id, tr.tenant_id, t.timezone, (p_at AT TIME ZONE t.timezone) AS local_now
    FROM public.transport_routes tr JOIN public.tenants t ON t.id = tr.tenant_id
    WHERE tr.id = p_route_id AND tr.is_active AND tr.deleted_at IS NULL
  ), days AS (
    SELECT r.*, (r.local_now::date + d) AS day FROM r CROSS JOIN generate_series(0, 1) d
  )
  SELECT s.id, s.direction_code, ((days.day + s.departure_time) AT TIME ZONE days.timezone),
         s.service_class, s.fare::text
  FROM days
  JOIN public.transport_schedules s ON s.tenant_id = days.tenant_id AND s.transport_route_id = days.id
  WHERE extract(isodow FROM days.day)::smallint = ANY (s.iso_days_of_week)
    AND (s.valid_from IS NULL OR s.valid_from <= days.day)
    AND (s.valid_to IS NULL OR s.valid_to >= days.day)
    AND (days.day + s.departure_time) > days.local_now
  ORDER BY 3, 1
  LIMIT p_limit
$$;
--> statement-breakpoint

-- A place open around the clock: all seven days 00:00 → 00:00 next day.
CREATE OR REPLACE FUNCTION public.place_is_24h(p_place_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT count(DISTINCT h.iso_day_of_week) = 7
  FROM public.place_hours h
  WHERE h.place_id = p_place_id AND h.opens_at = '00:00' AND h.closes_at = '00:00' AND h.closes_next_day
$$;
--> statement-breakpoint

-- Directory places near a point (any area): active places of the given
-- categories, optionally of given values of one select field (hospital vs
-- clinic vs diagnostic), optionally open around the clock. Nearest first.
CREATE OR REPLACE FUNCTION public.directory_places_near(
  p_origin geography, p_radius_km double precision, p_category_slugs text[], p_field_key text,
  p_field_values text[], p_only_24h boolean, p_after_distance double precision, p_after_id uuid, p_limit integer
)
RETURNS TABLE (id uuid, tenant_id uuid, slug text, name_bn text, name_en text, category_slug text, subtype text,
               address text, lat double precision, lng double precision, is_24h boolean,
               verified_at timestamptz, updated_at timestamptz, distance_m double precision)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET plan_cache_mode = force_custom_plan
AS $$
  SELECT x.id, x.tenant_id, x.slug, x.name_bn, x.name_en, x.category_slug, x.subtype, x.address, x.lat, x.lng,
         x.is_24h, x.verified_at, x.updated_at, x.distance_m
  FROM (
    SELECT p.id, p.tenant_id, p.slug, p.name_bn, p.name_en, c.slug AS category_slug,
           CASE WHEN p_field_key IS NULL THEN NULL ELSE p.fields ->> p_field_key END AS subtype,
           p.address_text AS address, st_y(p.location::geometry) AS lat, st_x(p.location::geometry) AS lng,
           public.place_is_24h(p.id) AS is_24h, p.field_verified_at AS verified_at, p.updated_at,
           st_distance(p.location, p_origin, false) AS distance_m
    FROM public.places p
    JOIN public.categories c ON c.id = p.category_id
    WHERE p.status_code = 'published' AND p.deleted_at IS NULL
      AND c.slug = ANY (p_category_slugs)
      AND (p_field_key IS NULL OR p_field_values IS NULL OR (p.fields ->> p_field_key) = ANY (p_field_values))
      AND st_dwithin(p.location, p_origin, p_radius_km * 1000, false)
  ) x
  WHERE (NOT coalesce(p_only_24h, false) OR x.is_24h)
    AND (p_after_distance IS NULL OR (x.distance_m, x.id) > (p_after_distance, p_after_id))
  ORDER BY x.distance_m, x.id
  LIMIT p_limit
$$;
--> statement-breakpoint

-- The guide entry as published: a new immutable version for every save
-- (staff or field agents of the area); a new entry when p_service_id is NULL.
-- p: {"name_bn","name_en","summary_bn","office_name","office_place_id","address_text","lat","lng",
--     "hours_text","documents":[],"fees":[],"steps":[],"links":[],"change_note"}
CREATE OR REPLACE FUNCTION public.gov_service_publish(p_service_id uuid, p_slug text, p_category text, p jsonb)
RETURNS TABLE (service_id uuid, version_no integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_service uuid := p_service_id;
  v_no integer;
  v_version uuid;
BEGIN
  IF v_tenant IS NULL OR NOT public.app_is_active_user()
     OR NOT (public.app_is_staff() OR public.app_role() = 'agent') THEN
    RAISE EXCEPTION 'gov_service_publish: staff or agents only' USING ERRCODE = 'AE913', DETAIL = 'role';
  END IF;
  IF coalesce(btrim(p ->> 'name_bn'), '') = '' OR coalesce(btrim(p ->> 'office_name'), '') = '' THEN
    RAISE EXCEPTION 'gov_service_publish: name' USING ERRCODE = 'AE913', DETAIL = 'name';
  END IF;
  IF v_service IS NULL THEN
    INSERT INTO public.gov_services (tenant_id, slug, category_code, last_verified_on, verified_by_user_id)
    VALUES (v_tenant, p_slug, p_category, public.tenant_local_today(v_tenant), public.current_user_id())
    RETURNING gov_services.id INTO v_service;
  ELSE
    UPDATE public.gov_services s
    SET category_code = coalesce(p_category, s.category_code),
        last_verified_on = public.tenant_local_today(v_tenant), verified_by_user_id = public.current_user_id()
    WHERE s.tenant_id = v_tenant AND s.id = v_service AND s.deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'gov_service_publish: not found' USING ERRCODE = 'AE913', DETAIL = 'not_found';
    END IF;
  END IF;
  PERFORM 1 FROM public.gov_services s WHERE s.id = v_service FOR UPDATE;
  SELECT coalesce(max(v.version_no), 0) + 1 INTO v_no FROM public.gov_service_versions v WHERE v.gov_service_id = v_service;
  INSERT INTO public.gov_service_versions
    (tenant_id, gov_service_id, version_no, name_bn, name_en, summary_bn, office_name, office_place_id, address_text,
     location, hours_text, documents, fees, steps, links, change_note, created_by_user_id)
  VALUES
    (v_tenant, v_service, v_no, btrim(p ->> 'name_bn'), nullif(btrim(p ->> 'name_en'), ''), p ->> 'summary_bn',
     btrim(p ->> 'office_name'), (p ->> 'office_place_id')::uuid, p ->> 'address_text',
     CASE WHEN p ? 'lat' AND p ? 'lng' AND p ->> 'lat' IS NOT NULL
          THEN st_setsrid(st_makepoint((p ->> 'lng')::double precision, (p ->> 'lat')::double precision), 4326)::geography END,
     p ->> 'hours_text', coalesce(p -> 'documents', '[]'), coalesce(p -> 'fees', '[]'),
     coalesce(p -> 'steps', '[]'), coalesce(p -> 'links', '[]'), p ->> 'change_note', public.current_user_id())
  RETURNING gov_service_versions.id INTO v_version;
  UPDATE public.gov_services s SET current_version_id = v_version WHERE s.id = v_service;
  RETURN QUERY SELECT v_service, v_no;
END
$$;
--> statement-breakpoint

-- "Checked, still right": the last-verified date without a new version.
CREATE OR REPLACE FUNCTION public.gov_service_verify(p_service_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tenant uuid := public.current_tenant_id();
BEGIN
  IF v_tenant IS NULL OR NOT (public.app_is_staff() OR public.app_role() = 'agent') THEN
    RAISE EXCEPTION 'gov_service_verify: staff or agents only' USING ERRCODE = 'AE913', DETAIL = 'role';
  END IF;
  UPDATE public.gov_services s
  SET last_verified_on = public.tenant_local_today(v_tenant), verified_by_user_id = public.current_user_id()
  WHERE s.tenant_id = v_tenant AND s.id = p_service_id AND s.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gov_service_verify: not found' USING ERRCODE = 'AE913', DETAIL = 'not_found';
  END IF;
END
$$;
--> statement-breakpoint

-- The engine's one moderation decision for member content (staff only):
-- approve → published / open (with the type's expiry), reject or remove →
-- removed; the moderation_actions row in the same transaction (rule 13).
CREATE OR REPLACE FUNCTION public.decide_info_item(p_kind text, p_id uuid, p_decision text, p_reason_code text,
                                                  p_reason_text text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_status text;
  v_new text;
  v_days integer;
  v_type text;
  v_action text := CASE p_decision WHEN 'approve' THEN 'info_approved' WHEN 'reject' THEN 'info_rejected'
                                   WHEN 'remove' THEN 'info_removed' END;
BEGIN
  IF v_tenant IS NULL OR NOT (public.app_is_staff() OR public.is_platform_admin()) THEN
    RAISE EXCEPTION 'decide_info_item: staff only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_action IS NULL OR p_kind NOT IN ('notice', 'lost_found') THEN
    RAISE EXCEPTION 'decide_info_item: decision' USING ERRCODE = 'AE914', DETAIL = 'decision';
  END IF;
  IF p_decision <> 'approve' AND coalesce(btrim(p_reason_text), '') = '' THEN
    RAISE EXCEPTION 'decide_info_item: reason' USING ERRCODE = 'AE914', DETAIL = 'reason';
  END IF;

  IF p_kind = 'notice' THEN
    SELECT n.status_code, n.notice_type_code INTO v_status, v_type FROM public.notices n
    WHERE n.tenant_id = v_tenant AND n.id = p_id AND n.deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'decide_info_item: not found' USING ERRCODE = 'AE914', DETAIL = 'not_found';
    END IF;
    -- 'approve' on a live, reported notice = keep it: no change, the review recorded.
    IF (p_decision = 'approve' AND v_status NOT IN ('pending_review', 'published'))
       OR (p_decision = 'reject' AND v_status <> 'pending_review')
       OR (p_decision = 'remove' AND v_status NOT IN ('published', 'pending_review')) THEN
      RAISE EXCEPTION 'decide_info_item: state' USING ERRCODE = 'AE914', DETAIL = 'state';
    END IF;
    v_new := CASE p_decision WHEN 'approve' THEN 'published' ELSE 'removed' END;
    v_days := (public.setting_value_for(
                 CASE WHEN v_type = 'obituary' THEN 'notice_obituary_expiry_days'
                      WHEN v_type IN (SELECT code FROM public.notice_types WHERE category_code = 'community')
                        THEN 'notice_community_expiry_days'
                      ELSE 'notice_local_expiry_days' END, v_tenant) #>> '{}')::integer;
    UPDATE public.notices n
    SET status_code = v_new,
        published_at = CASE WHEN v_status = 'pending_review' AND v_new = 'published' THEN now()
                            ELSE n.published_at END,
        expires_at = CASE WHEN v_status = 'pending_review' AND v_new = 'published' AND n.expires_at IS NULL
                          THEN now() + make_interval(days => v_days) ELSE n.expires_at END
    WHERE n.tenant_id = v_tenant AND n.id = p_id;
    INSERT INTO public.moderation_actions (tenant_id, notice_id, actor_user_id, action_code, reason_code, reason_text)
    VALUES (v_tenant, p_id, public.current_user_id(), v_action, p_reason_code, p_reason_text);
  ELSE
    SELECT i.status_code INTO v_status FROM public.lost_found_items i
    WHERE i.tenant_id = v_tenant AND i.id = p_id AND i.deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'decide_info_item: not found' USING ERRCODE = 'AE914', DETAIL = 'not_found';
    END IF;
    -- 'approve' on an open or resolved, reported item = keep it as it is.
    IF (p_decision = 'approve' AND v_status NOT IN ('pending_review', 'open', 'resolved'))
       OR (p_decision = 'reject' AND v_status <> 'pending_review')
       OR (p_decision = 'remove' AND v_status NOT IN ('open', 'pending_review', 'resolved')) THEN
      RAISE EXCEPTION 'decide_info_item: state' USING ERRCODE = 'AE914', DETAIL = 'state';
    END IF;
    v_new := CASE WHEN p_decision = 'approve' AND v_status <> 'pending_review' THEN v_status
                  WHEN p_decision = 'approve' THEN 'open' ELSE 'removed' END;
    v_days := (public.setting_value_for('lost_found_expiry_days', v_tenant) #>> '{}')::integer;
    UPDATE public.lost_found_items i
    SET status_code = v_new,
        expires_at = CASE WHEN v_status = 'pending_review' AND v_new = 'open'
                          THEN now() + make_interval(days => v_days) ELSE i.expires_at END
    WHERE i.tenant_id = v_tenant AND i.id = p_id;
    INSERT INTO public.moderation_actions (tenant_id, lost_found_item_id, actor_user_id, action_code, reason_code, reason_text)
    VALUES (v_tenant, p_id, public.current_user_id(), v_action, p_reason_code, p_reason_text);
  END IF;
  RETURN v_new;
END
$$;
--> statement-breakpoint

-- The engine's one expiry job (the system only): notices past their end,
-- lost & found past theirs (archived as expired), scheduled outages past
-- their end + outage_end_grace_minutes. Nothing is deleted here.
CREATE OR REPLACE FUNCTION public.expire_info_items(p_limit integer)
RETURNS TABLE (notices integer, lost_found integer, outages integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_notices integer;
  v_items integer;
  v_outages integer;
  v_grace integer := (public.setting_value_for('outage_end_grace_minutes', NULL) #>> '{}')::integer;
BEGIN
  IF NOT public.app_is_system() THEN
    RAISE EXCEPTION 'expire_info_items: system only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  WITH due AS (
    SELECT n.id FROM public.notices n
    WHERE n.status_code = 'published' AND n.expires_at IS NOT NULL AND n.expires_at < now()
    ORDER BY n.expires_at LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  UPDATE public.notices n SET status_code = 'expired' FROM due WHERE n.id = due.id;
  GET DIAGNOSTICS v_notices = ROW_COUNT;

  WITH due AS (
    SELECT i.id FROM public.lost_found_items i
    WHERE i.status_code = 'open' AND i.expires_at IS NOT NULL AND i.expires_at < now()
    ORDER BY i.expires_at LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  UPDATE public.lost_found_items i SET status_code = 'expired' FROM due WHERE i.id = due.id;
  GET DIAGNOSTICS v_items = ROW_COUNT;

  WITH due AS (
    SELECT o.id FROM public.utility_outages o
    WHERE o.status_code = 'scheduled' AND o.ends_at < now() - make_interval(mins => v_grace)
    ORDER BY o.ends_at LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  UPDATE public.utility_outages o SET status_code = 'ended' FROM due WHERE o.id = due.id;
  GET DIAGNOSTICS v_outages = ROW_COUNT;

  RETURN QUERY SELECT v_notices, v_items, v_outages;
END
$$;
--> statement-breakpoint

-- ============================================================================
-- RLS
-- ============================================================================

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['utility_types', 'gov_service_categories', 'utility_outages', 'outage_reports',
                           'gov_services', 'gov_service_versions']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;
--> statement-breakpoint

CREATE POLICY utility_types_read_all ON public.utility_types FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY utility_types_platform_admin ON public.utility_types
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint
CREATE POLICY gov_service_categories_read_all ON public.gov_service_categories FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY gov_service_categories_platform_admin ON public.gov_service_categories
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- utility_outages: T-PUBLIC-READ; staff + field agents write
CREATE POLICY utility_outages_public_read ON public.utility_outages
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND deleted_at IS NULL);
--> statement-breakpoint
CREATE POLICY utility_outages_team_write ON public.utility_outages
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND ((SELECT public.app_is_staff()) OR (SELECT public.app_role()) = 'agent'))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND ((SELECT public.app_is_staff()) OR (SELECT public.app_role()) = 'agent'));
--> statement-breakpoint
CREATE POLICY utility_outages_platform_admin ON public.utility_outages
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- outage_reports: a reporter sees their own; staff read; written by report_outage() only
CREATE POLICY outage_reports_reporter_read ON public.outage_reports
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND reporter_user_id = (SELECT public.current_user_id()));
--> statement-breakpoint
CREATE POLICY outage_reports_staff_read ON public.outage_reports
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY outage_reports_platform_admin ON public.outage_reports
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- gov_services / versions: T-PUBLIC-READ (active); written by gov_service_publish() only
CREATE POLICY gov_services_public_read ON public.gov_services
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND is_active AND deleted_at IS NULL);
--> statement-breakpoint
CREATE POLICY gov_services_team_manage ON public.gov_services
  FOR UPDATE
  USING (tenant_id = (SELECT public.current_tenant_id()) AND ((SELECT public.app_is_staff()) OR (SELECT public.app_role()) = 'agent'))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND ((SELECT public.app_is_staff()) OR (SELECT public.app_role()) = 'agent'));
--> statement-breakpoint
CREATE POLICY gov_services_team_read ON public.gov_services
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND ((SELECT public.app_is_staff()) OR (SELECT public.app_role()) = 'agent'));
--> statement-breakpoint
CREATE POLICY gov_services_platform_admin ON public.gov_services
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint
CREATE POLICY gov_service_versions_public_read ON public.gov_service_versions
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND EXISTS (SELECT 1 FROM public.gov_services s
                WHERE s.tenant_id = gov_service_versions.tenant_id AND s.id = gov_service_versions.gov_service_id
                  AND s.deleted_at IS NULL
                  AND (s.is_active OR (SELECT public.app_is_staff()) OR (SELECT public.app_role()) = 'agent'))
  );
--> statement-breakpoint
CREATE POLICY gov_service_versions_platform_admin ON public.gov_service_versions
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- transport: field agents already write (0011); nothing to add.

-- ============================================================================
-- Grants and function ownership
-- ============================================================================

GRANT SELECT ON public.utility_types, public.gov_service_categories TO ae_app;
--> statement-breakpoint
GRANT INSERT, UPDATE ON public.utility_types, public.gov_service_categories TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.utility_outages TO ae_app;
--> statement-breakpoint
GRANT SELECT ON public.outage_reports, public.gov_service_versions TO ae_app;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.gov_services TO ae_app;
--> statement-breakpoint
GRANT DELETE ON public.transport_route_stops, public.transport_schedules TO ae_app;
--> statement-breakpoint

GRANT SELECT ON public.utility_types, public.gov_service_categories, public.utility_outages, public.notices,
  public.notice_types, public.lost_found_items, public.transport_routes, public.transport_route_stops,
  public.transport_schedules, public.places, public.place_hours, public.categories, public.media_attachments,
  public.media_assets, public.commodity_groups
TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.outage_reports, public.gov_services, public.gov_service_versions TO ae_rls_bypass;
--> statement-breakpoint
GRANT UPDATE ON public.notices, public.lost_found_items, public.utility_outages TO ae_rls_bypass;
--> statement-breakpoint

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.bazar_catalogue_for(uuid, text)', 'public.info_point(geography, uuid)',
    'public.nearest_locality(uuid, geography)', 'public.report_outage(text, geography)',
    'public.outage_report_clusters(geography, double precision)',
    'public.utility_outages_near(geography, double precision, integer)',
    'public.notices_near(geography, double precision, text, integer)',
    'public.lost_found_near(geography, double precision, text, text, integer)',
    'public.transport_routes_near(geography, double precision, text, integer)',
    'public.transport_next_departures(uuid, timestamptz, integer)', 'public.place_is_24h(uuid)',
    'public.directory_places_near(geography, double precision, text[], text, text[], boolean, double precision, uuid, integer)',
    'public.gov_service_publish(uuid, text, text, jsonb)', 'public.gov_service_verify(uuid)',
    'public.decide_info_item(text, uuid, text, text, text)', 'public.expire_info_items(integer)'
  ]
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO ae_rls_bypass', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.bazar_catalogue_for(uuid, text), public.report_outage(text, geography),
  public.outage_report_clusters(geography, double precision),
  public.utility_outages_near(geography, double precision, integer),
  public.notices_near(geography, double precision, text, integer),
  public.lost_found_near(geography, double precision, text, text, integer),
  public.transport_routes_near(geography, double precision, text, integer),
  public.transport_next_departures(uuid, timestamptz, integer), public.place_is_24h(uuid),
  public.directory_places_near(geography, double precision, text[], text, text[], boolean, double precision, uuid, integer),
  public.gov_service_publish(uuid, text, text, jsonb), public.gov_service_verify(uuid),
  public.decide_info_item(text, uuid, text, text, text), public.expire_info_items(integer)
TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.info_point(geography, uuid), public.nearest_locality(uuid, geography),
  public.bazar_catalogue_for(uuid, text), public.place_is_24h(uuid)
TO ae_rls_bypass;
