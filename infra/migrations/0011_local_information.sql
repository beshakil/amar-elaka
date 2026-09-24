-- 0011_local_information
--
-- Local information domain (docs/specs/schema.md §10): bazar commodity
-- price boards, blood donor registry & requests, national/local emergency
-- contacts, notices, transport routes/stops/schedules, and lost & found.
-- Runs as ae_migrator; RLS and grants are in this same file.
--
-- Closes three deferred FKs from 0010 (reports' target columns):
--   - reports.lost_found_item_id -> lost_found_items, composite
--   - reports.notice_id -> notices, composite
--   - reports.blood_request_id -> blood_requests, composite
--
-- "Writes: staff, agents" (spec, several tables here) reuses 0004's
-- localities precedent: 'agent' is a plain app_role() value, checked
-- directly (app_role() IN (...,'agent')) — no field_agents table needed.
--
-- ============================================================================
-- SCOPE — as with 0007-0010: full DDL/CHECKs/indexes/RLS for every table,
-- every self-contained trigger. NOT built here, and why:
--   - The cross-tenant system jobs the indexes are annotated for (expiring
--     blood requests/notices/lost_found_items, re-verification worklists):
--     scheduled jobs, not schema.
--   - blood_request_responses' "on donated, service updates blood_donors.
--     last_donated_on": a cross-table side effect tied to a real donation
--     confirmation workflow, not a structural safety net — left to the
--     service layer, same class of thing as 0007's credit_apply().
--   - Phone-reveal rate limiting and its lead_events logging (spec: "goes
--     through the service, logs a lead_events row, rate-limited"): service
--     layer + Redis, not a DB trigger.
-- ============================================================================

-- ============================================================================
-- Enum tables
-- ============================================================================

CREATE TABLE public.commodity_groups (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commodity_groups_pk PRIMARY KEY (code), CONSTRAINT commodity_groups_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER commodity_groups_set_updated_at BEFORE UPDATE ON public.commodity_groups FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.commodity_groups (code, label_key, sort_order) VALUES
  ('rice_grains', 'enum.commodity_groups.rice_grains', 10),
  ('vegetables', 'enum.commodity_groups.vegetables', 20),
  ('fish', 'enum.commodity_groups.fish', 30),
  ('meat_eggs', 'enum.commodity_groups.meat_eggs', 40),
  ('spices', 'enum.commodity_groups.spices', 50),
  ('oil', 'enum.commodity_groups.oil', 60),
  ('pulses', 'enum.commodity_groups.pulses', 70),
  ('fruits', 'enum.commodity_groups.fruits', 80);
--> statement-breakpoint

CREATE TABLE public.measurement_units (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT measurement_units_pk PRIMARY KEY (code), CONSTRAINT measurement_units_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER measurement_units_set_updated_at BEFORE UPDATE ON public.measurement_units FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.measurement_units (code, label_key, sort_order) VALUES
  ('kg', 'enum.measurement_units.kg', 10),
  ('litre', 'enum.measurement_units.litre', 20),
  ('piece', 'enum.measurement_units.piece', 30),
  ('dozen', 'enum.measurement_units.dozen', 40),
  ('hali', 'enum.measurement_units.hali', 50),
  ('hundred', 'enum.measurement_units.hundred', 60);
--> statement-breakpoint

CREATE TABLE public.market_types (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_types_pk PRIMARY KEY (code), CONSTRAINT market_types_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER market_types_set_updated_at BEFORE UPDATE ON public.market_types FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.market_types (code, label_key, sort_order) VALUES
  ('daily_bazar', 'enum.market_types.daily_bazar', 10),
  ('weekly_haat', 'enum.market_types.weekly_haat', 20),
  ('super_shop', 'enum.market_types.super_shop', 30),
  ('wholesale', 'enum.market_types.wholesale', 40);
--> statement-breakpoint

CREATE TABLE public.price_sources (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT price_sources_pk PRIMARY KEY (code), CONSTRAINT price_sources_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER price_sources_set_updated_at BEFORE UPDATE ON public.price_sources FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.price_sources (code, label_key, sort_order) VALUES
  ('agent', 'enum.price_sources.agent', 10),
  ('trader', 'enum.price_sources.trader', 20),
  ('staff', 'enum.price_sources.staff', 30),
  ('member', 'enum.price_sources.member', 40),
  ('govt_import', 'enum.price_sources.govt_import', 50);
--> statement-breakpoint

CREATE TABLE public.price_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT price_statuses_pk PRIMARY KEY (code), CONSTRAINT price_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER price_statuses_set_updated_at BEFORE UPDATE ON public.price_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.price_statuses (code, label_key, sort_order) VALUES
  ('submitted', 'enum.price_statuses.submitted', 10),
  ('published', 'enum.price_statuses.published', 20),
  ('rejected', 'enum.price_statuses.rejected', 30);
--> statement-breakpoint

CREATE TABLE public.blood_groups (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blood_groups_pk PRIMARY KEY (code), CONSTRAINT blood_groups_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER blood_groups_set_updated_at BEFORE UPDATE ON public.blood_groups FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.blood_groups (code, label_key, sort_order) VALUES
  ('a_pos', 'enum.blood_groups.a_pos', 10),
  ('a_neg', 'enum.blood_groups.a_neg', 20),
  ('b_pos', 'enum.blood_groups.b_pos', 30),
  ('b_neg', 'enum.blood_groups.b_neg', 40),
  ('ab_pos', 'enum.blood_groups.ab_pos', 50),
  ('ab_neg', 'enum.blood_groups.ab_neg', 60),
  ('o_pos', 'enum.blood_groups.o_pos', 70),
  ('o_neg', 'enum.blood_groups.o_neg', 80);
--> statement-breakpoint

CREATE TABLE public.donor_contact_preferences (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT donor_contact_preferences_pk PRIMARY KEY (code), CONSTRAINT donor_contact_preferences_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER donor_contact_preferences_set_updated_at BEFORE UPDATE ON public.donor_contact_preferences FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.donor_contact_preferences (code, label_key, sort_order) VALUES
  ('in_app_only', 'enum.donor_contact_preferences.in_app_only', 10),
  ('reveal_on_request', 'enum.donor_contact_preferences.reveal_on_request', 20);
--> statement-breakpoint

CREATE TABLE public.blood_request_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blood_request_statuses_pk PRIMARY KEY (code), CONSTRAINT blood_request_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER blood_request_statuses_set_updated_at BEFORE UPDATE ON public.blood_request_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.blood_request_statuses (code, label_key, sort_order) VALUES
  ('open', 'enum.blood_request_statuses.open', 10),
  ('fulfilled', 'enum.blood_request_statuses.fulfilled', 20),
  ('cancelled', 'enum.blood_request_statuses.cancelled', 30),
  ('expired', 'enum.blood_request_statuses.expired', 40),
  ('removed', 'enum.blood_request_statuses.removed', 50);
--> statement-breakpoint

CREATE TABLE public.urgency_levels (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT urgency_levels_pk PRIMARY KEY (code), CONSTRAINT urgency_levels_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER urgency_levels_set_updated_at BEFORE UPDATE ON public.urgency_levels FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.urgency_levels (code, label_key, sort_order) VALUES
  ('critical', 'enum.urgency_levels.critical', 10),
  ('urgent', 'enum.urgency_levels.urgent', 20),
  ('planned', 'enum.urgency_levels.planned', 30);
--> statement-breakpoint

CREATE TABLE public.donor_response_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT donor_response_statuses_pk PRIMARY KEY (code), CONSTRAINT donor_response_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER donor_response_statuses_set_updated_at BEFORE UPDATE ON public.donor_response_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.donor_response_statuses (code, label_key, sort_order) VALUES
  ('offered', 'enum.donor_response_statuses.offered', 10),
  ('accepted', 'enum.donor_response_statuses.accepted', 20),
  ('donated', 'enum.donor_response_statuses.donated', 30),
  ('withdrawn', 'enum.donor_response_statuses.withdrawn', 40),
  ('declined', 'enum.donor_response_statuses.declined', 50);
--> statement-breakpoint

CREATE TABLE public.emergency_service_types (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT emergency_service_types_pk PRIMARY KEY (code), CONSTRAINT emergency_service_types_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER emergency_service_types_set_updated_at BEFORE UPDATE ON public.emergency_service_types FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.emergency_service_types (code, label_key, sort_order) VALUES
  ('police', 'enum.emergency_service_types.police', 10),
  ('fire_service', 'enum.emergency_service_types.fire_service', 20),
  ('hospital', 'enum.emergency_service_types.hospital', 30),
  ('ambulance', 'enum.emergency_service_types.ambulance', 40),
  ('pharmacy_24h', 'enum.emergency_service_types.pharmacy_24h', 50),
  ('electricity', 'enum.emergency_service_types.electricity', 60),
  ('gas', 'enum.emergency_service_types.gas', 70),
  ('union_parishad', 'enum.emergency_service_types.union_parishad', 80),
  ('upazila_office', 'enum.emergency_service_types.upazila_office', 90),
  ('women_child_helpline', 'enum.emergency_service_types.women_child_helpline', 100);
--> statement-breakpoint

CREATE TABLE public.notice_types (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notice_types_pk PRIMARY KEY (code), CONSTRAINT notice_types_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER notice_types_set_updated_at BEFORE UPDATE ON public.notice_types FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.notice_types (code, label_key, sort_order) VALUES
  ('government', 'enum.notice_types.government', 10),
  ('union_parishad', 'enum.notice_types.union_parishad', 20),
  ('power_outage', 'enum.notice_types.power_outage', 30),
  ('water_supply', 'enum.notice_types.water_supply', 40),
  ('education', 'enum.notice_types.education', 50),
  ('religious', 'enum.notice_types.religious', 60),
  ('community_event', 'enum.notice_types.community_event', 70),
  ('obituary', 'enum.notice_types.obituary', 80),
  ('weather_alert', 'enum.notice_types.weather_alert', 90);
--> statement-breakpoint

CREATE TABLE public.notice_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notice_statuses_pk PRIMARY KEY (code), CONSTRAINT notice_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER notice_statuses_set_updated_at BEFORE UPDATE ON public.notice_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.notice_statuses (code, label_key, sort_order) VALUES
  ('draft', 'enum.notice_statuses.draft', 10),
  ('pending_review', 'enum.notice_statuses.pending_review', 20),
  ('published', 'enum.notice_statuses.published', 30),
  ('expired', 'enum.notice_statuses.expired', 40),
  ('removed', 'enum.notice_statuses.removed', 50);
--> statement-breakpoint

CREATE TABLE public.transport_modes (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transport_modes_pk PRIMARY KEY (code), CONSTRAINT transport_modes_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER transport_modes_set_updated_at BEFORE UPDATE ON public.transport_modes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.transport_modes (code, label_key, sort_order) VALUES
  ('bus', 'enum.transport_modes.bus', 10),
  ('launch', 'enum.transport_modes.launch', 20),
  ('train', 'enum.transport_modes.train', 30),
  ('cng', 'enum.transport_modes.cng', 40),
  ('auto_rickshaw', 'enum.transport_modes.auto_rickshaw', 50),
  ('leguna', 'enum.transport_modes.leguna', 60),
  ('microbus', 'enum.transport_modes.microbus', 70),
  ('ferry', 'enum.transport_modes.ferry', 80);
--> statement-breakpoint

CREATE TABLE public.route_directions (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT route_directions_pk PRIMARY KEY (code), CONSTRAINT route_directions_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER route_directions_set_updated_at BEFORE UPDATE ON public.route_directions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.route_directions (code, label_key, sort_order) VALUES
  ('outbound', 'enum.route_directions.outbound', 10),
  ('return', 'enum.route_directions.return', 20);
--> statement-breakpoint

CREATE TABLE public.lost_found_kinds (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lost_found_kinds_pk PRIMARY KEY (code), CONSTRAINT lost_found_kinds_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER lost_found_kinds_set_updated_at BEFORE UPDATE ON public.lost_found_kinds FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.lost_found_kinds (code, label_key, sort_order) VALUES
  ('lost', 'enum.lost_found_kinds.lost', 10),
  ('found', 'enum.lost_found_kinds.found', 20);
--> statement-breakpoint

CREATE TABLE public.lost_found_item_types (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lost_found_item_types_pk PRIMARY KEY (code), CONSTRAINT lost_found_item_types_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER lost_found_item_types_set_updated_at BEFORE UPDATE ON public.lost_found_item_types FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.lost_found_item_types (code, label_key, sort_order) VALUES
  ('phone', 'enum.lost_found_item_types.phone', 10),
  ('wallet', 'enum.lost_found_item_types.wallet', 20),
  ('documents', 'enum.lost_found_item_types.documents', 30),
  ('person', 'enum.lost_found_item_types.person', 40),
  ('pet', 'enum.lost_found_item_types.pet', 50),
  ('livestock', 'enum.lost_found_item_types.livestock', 60),
  ('vehicle', 'enum.lost_found_item_types.vehicle', 70),
  ('bag', 'enum.lost_found_item_types.bag', 80),
  ('jewellery', 'enum.lost_found_item_types.jewellery', 90),
  ('other', 'enum.lost_found_item_types.other', 100);
--> statement-breakpoint

CREATE TABLE public.contact_methods (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_methods_pk PRIMARY KEY (code), CONSTRAINT contact_methods_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER contact_methods_set_updated_at BEFORE UPDATE ON public.contact_methods FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.contact_methods (code, label_key, sort_order) VALUES
  ('chat', 'enum.contact_methods.chat', 10),
  ('phone', 'enum.contact_methods.phone', 20);
--> statement-breakpoint

CREATE TABLE public.lost_found_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lost_found_statuses_pk PRIMARY KEY (code), CONSTRAINT lost_found_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER lost_found_statuses_set_updated_at BEFORE UPDATE ON public.lost_found_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.lost_found_statuses (code, label_key, sort_order) VALUES
  ('pending_review', 'enum.lost_found_statuses.pending_review', 10),
  ('open', 'enum.lost_found_statuses.open', 20),
  ('resolved', 'enum.lost_found_statuses.resolved', 30),
  ('expired', 'enum.lost_found_statuses.expired', 40),
  ('removed', 'enum.lost_found_statuses.removed', 50);

-- ============================================================================
-- bazar_commodities (§10.1): GLOBAL
-- ============================================================================

CREATE TABLE public.bazar_commodities (
  id                    uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  code                  text        NOT NULL,
  name_bn               text        NOT NULL,
  name_en               text        NOT NULL,
  group_code            text        NOT NULL,
  default_unit_code     text        NOT NULL,
  aliases               text[]      NOT NULL DEFAULT '{}',
  icon_key              text,
  sort_order            integer     NOT NULL DEFAULT 0,
  is_active             boolean     NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bazar_commodities_pk PRIMARY KEY (id),
  CONSTRAINT bazar_commodities_group_code_fk FOREIGN KEY (group_code)
    REFERENCES public.commodity_groups (code) ON DELETE RESTRICT,
  CONSTRAINT bazar_commodities_default_unit_code_fk FOREIGN KEY (default_unit_code)
    REFERENCES public.measurement_units (code) ON DELETE RESTRICT,
  CONSTRAINT bazar_commodities_code_uq UNIQUE (code)
);
--> statement-breakpoint
-- Grouped price board.
CREATE INDEX bazar_commodities_group_sort_idx ON public.bazar_commodities (group_code, sort_order);
--> statement-breakpoint
CREATE TRIGGER bazar_commodities_set_updated_at BEFORE UPDATE ON public.bazar_commodities
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- bazar_markets (§10.2): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.bazar_markets (
  id                   uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id            uuid        NOT NULL DEFAULT public.current_tenant_id(),
  name_bn              text        NOT NULL,
  name_en              text,
  market_type_code     text        NOT NULL,
  haat_days            smallint[],
  locality_id          uuid,
  place_id             uuid,
  location             geography(Point,4326),
  is_active            boolean     NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,
  CONSTRAINT bazar_markets_pk PRIMARY KEY (id),
  CONSTRAINT bazar_markets_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT bazar_markets_market_type_code_fk FOREIGN KEY (market_type_code)
    REFERENCES public.market_types (code) ON DELETE RESTRICT,
  CONSTRAINT bazar_markets_tenant_id_locality_id_fk FOREIGN KEY (tenant_id, locality_id)
    REFERENCES public.localities (tenant_id, id) ON DELETE SET NULL (locality_id),
  CONSTRAINT bazar_markets_tenant_id_place_id_fk FOREIGN KEY (tenant_id, place_id)
    REFERENCES public.places (tenant_id, id) ON DELETE SET NULL (place_id),
  CONSTRAINT bazar_markets_haat_days_ck CHECK (haat_days IS NULL OR haat_days <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  -- Composite-FK target (§0.4).
  CONSTRAINT bazar_markets_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX bazar_markets_tenant_name_uq ON public.bazar_markets (tenant_id, name_bn) WHERE deleted_at IS NULL;
--> statement-breakpoint
-- Nearest market.
CREATE INDEX bazar_markets_location_gix ON public.bazar_markets USING gist (location);
--> statement-breakpoint
CREATE TRIGGER bazar_markets_set_updated_at BEFORE UPDATE ON public.bazar_markets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- bazar_prices (§10.3): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.bazar_prices (
  id                       uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                uuid          NOT NULL DEFAULT public.current_tenant_id(),
  commodity_id             uuid          NOT NULL,
  bazar_market_id          uuid,
  price_date               date          NOT NULL,
  unit_code                text          NOT NULL,
  min_price                numeric(12,2) NOT NULL,
  max_price                numeric(12,2) NOT NULL,
  quality_note             text,
  source_code              text          NOT NULL,
  reported_by_member_id    uuid,
  status_code              text          NOT NULL DEFAULT 'submitted',
  published_by_user_id     uuid,
  created_at               timestamptz   NOT NULL DEFAULT now(),
  updated_at               timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT bazar_prices_pk PRIMARY KEY (id),
  CONSTRAINT bazar_prices_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT bazar_prices_commodity_id_fk FOREIGN KEY (commodity_id)
    REFERENCES public.bazar_commodities (id) ON DELETE RESTRICT,
  CONSTRAINT bazar_prices_tenant_id_bazar_market_id_fk FOREIGN KEY (tenant_id, bazar_market_id)
    REFERENCES public.bazar_markets (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bazar_prices_unit_code_fk FOREIGN KEY (unit_code)
    REFERENCES public.measurement_units (code) ON DELETE RESTRICT,
  CONSTRAINT bazar_prices_source_code_fk FOREIGN KEY (source_code)
    REFERENCES public.price_sources (code) ON DELETE RESTRICT,
  CONSTRAINT bazar_prices_tenant_id_reported_by_member_id_fk FOREIGN KEY (tenant_id, reported_by_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE SET NULL (reported_by_member_id),
  CONSTRAINT bazar_prices_published_by_user_id_fk FOREIGN KEY (published_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT bazar_prices_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.price_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT bazar_prices_min_price_ck CHECK (min_price >= 0),
  CONSTRAINT bazar_prices_max_price_ck CHECK (max_price >= min_price)
);
--> statement-breakpoint
-- One published figure per commodity/market/unit/day/quality (PG15+ syntax).
CREATE UNIQUE INDEX bazar_prices_published_uq ON public.bazar_prices
  (tenant_id, commodity_id, bazar_market_id, unit_code, price_date, coalesce(quality_note, ''))
  NULLS NOT DISTINCT WHERE status_code = 'published';
--> statement-breakpoint
-- "Today's bazar prices".
CREATE INDEX bazar_prices_today_idx ON public.bazar_prices (tenant_id, price_date DESC, commodity_id)
  WHERE status_code = 'published';
--> statement-breakpoint
-- 30/90-day trend chart.
CREATE INDEX bazar_prices_trend_idx ON public.bazar_prices (tenant_id, commodity_id, price_date)
  WHERE status_code = 'published';
--> statement-breakpoint
-- Review queue.
CREATE INDEX bazar_prices_queue_idx ON public.bazar_prices (tenant_id, id) WHERE status_code = 'submitted';
--> statement-breakpoint
CREATE TRIGGER bazar_prices_set_updated_at BEFORE UPDATE ON public.bazar_prices
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- A plain member's submission is always forced to 'submitted', regardless
-- of what was requested (staff/agents may set other statuses directly).
CREATE OR REPLACE FUNCTION public.bazar_prices_force_member_submitted()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT (public.app_is_staff() OR public.app_role() = 'agent' OR public.app_is_system()) THEN
    NEW.status_code := 'submitted';
    NEW.published_by_user_id := NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER bazar_prices_a_force_member_submitted BEFORE INSERT ON public.bazar_prices
  FOR EACH ROW EXECUTE FUNCTION public.bazar_prices_force_member_submitted();
--> statement-breakpoint

-- ============================================================================
-- blood_donors (§10.4): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.blood_donors (
  id                          uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                   uuid        NOT NULL DEFAULT public.current_tenant_id(),
  member_id                   uuid        NOT NULL,
  blood_group_code            text        NOT NULL,
  last_donated_on             date,
  eligible_from               date,
  is_available                boolean     NOT NULL DEFAULT true,
  contact_preference_code     text        NOT NULL DEFAULT 'in_app_only',
  locality_id                 uuid,
  approx_location              geography(Point,4326),
  eligibility_confirmed_at     timestamptz NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  deleted_at                  timestamptz,
  CONSTRAINT blood_donors_pk PRIMARY KEY (id),
  CONSTRAINT blood_donors_tenant_id_member_id_fk FOREIGN KEY (tenant_id, member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT blood_donors_blood_group_code_fk FOREIGN KEY (blood_group_code)
    REFERENCES public.blood_groups (code) ON DELETE RESTRICT,
  CONSTRAINT blood_donors_contact_preference_code_fk FOREIGN KEY (contact_preference_code)
    REFERENCES public.donor_contact_preferences (code) ON DELETE RESTRICT,
  CONSTRAINT blood_donors_tenant_id_locality_id_fk FOREIGN KEY (tenant_id, locality_id)
    REFERENCES public.localities (tenant_id, id) ON DELETE SET NULL (locality_id),
  -- Composite-FK target (§0.4).
  CONSTRAINT blood_donors_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX blood_donors_tenant_member_uq ON public.blood_donors (tenant_id, member_id) WHERE deleted_at IS NULL;
--> statement-breakpoint
-- "Find O- donors eligible today".
CREATE INDEX blood_donors_search_idx ON public.blood_donors (tenant_id, blood_group_code, eligible_from)
  WHERE is_available AND deleted_at IS NULL;
--> statement-breakpoint
-- Nearest donors.
CREATE INDEX blood_donors_location_gix ON public.blood_donors USING gist (approx_location)
  WHERE is_available AND deleted_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER blood_donors_set_updated_at BEFORE UPDATE ON public.blood_donors
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- eligible_from = last_donated_on + blood_donation_interval_days (setting,
-- §2.16; default 120). Read directly from platform_settings, not hardcoded
-- (CLAUDE.md rule 9) — no tenant override exists for this setting.
CREATE OR REPLACE FUNCTION public.blood_donors_set_eligible_from()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  interval_days integer;
BEGIN
  IF NEW.last_donated_on IS NULL THEN
    NEW.eligible_from := NULL;
    RETURN NEW;
  END IF;
  SELECT (value #>> '{}')::integer INTO interval_days
  FROM public.platform_settings WHERE key = 'blood_donation_interval_days';
  NEW.eligible_from := NEW.last_donated_on + coalesce(interval_days, 120);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER blood_donors_a_set_eligible_from
  BEFORE INSERT OR UPDATE OF last_donated_on ON public.blood_donors
  FOR EACH ROW EXECUTE FUNCTION public.blood_donors_set_eligible_from();
--> statement-breakpoint

-- ============================================================================
-- blood_requests (§10.5): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.blood_requests (
  id                      uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id               uuid        NOT NULL DEFAULT public.current_tenant_id(),
  requester_member_id     uuid        NOT NULL,
  blood_group_code        text        NOT NULL,
  units_needed            smallint    NOT NULL DEFAULT 1,
  hospital_name           text        NOT NULL,
  hospital_place_id       uuid,
  patient_note            text,
  contact_phone_e164      text        NOT NULL,
  needed_by               timestamptz NOT NULL,
  urgency_code            text        NOT NULL,
  status_code             text        NOT NULL DEFAULT 'open',
  fulfilled_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz,
  CONSTRAINT blood_requests_pk PRIMARY KEY (id),
  CONSTRAINT blood_requests_tenant_id_requester_member_id_fk FOREIGN KEY (tenant_id, requester_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT blood_requests_blood_group_code_fk FOREIGN KEY (blood_group_code)
    REFERENCES public.blood_groups (code) ON DELETE RESTRICT,
  CONSTRAINT blood_requests_tenant_id_hospital_place_id_fk FOREIGN KEY (tenant_id, hospital_place_id)
    REFERENCES public.places (tenant_id, id) ON DELETE SET NULL (hospital_place_id),
  CONSTRAINT blood_requests_urgency_code_fk FOREIGN KEY (urgency_code)
    REFERENCES public.urgency_levels (code) ON DELETE RESTRICT,
  CONSTRAINT blood_requests_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.blood_request_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT blood_requests_units_needed_ck CHECK (units_needed BETWEEN 1 AND 10),
  -- Composite-FK target (§0.4).
  CONSTRAINT blood_requests_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- Open requests list and donor matching.
CREATE INDEX blood_requests_open_idx ON public.blood_requests (tenant_id, blood_group_code, needed_by)
  WHERE status_code = 'open';
--> statement-breakpoint
-- Cross-tenant system job: expire requests.
CREATE INDEX blood_requests_expiry_idx ON public.blood_requests (status_code, needed_by) WHERE status_code = 'open';
--> statement-breakpoint
-- "My requests".
CREATE INDEX blood_requests_tenant_requester_idx ON public.blood_requests (tenant_id, requester_member_id, id DESC);
--> statement-breakpoint
CREATE TRIGGER blood_requests_set_updated_at BEFORE UPDATE ON public.blood_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- blood_request_responses (§10.6): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.blood_request_responses (
  id                   uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id            uuid        NOT NULL DEFAULT public.current_tenant_id(),
  blood_request_id     uuid        NOT NULL,
  blood_donor_id       uuid        NOT NULL,
  status_code          text        NOT NULL DEFAULT 'offered',
  donated_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blood_request_responses_pk PRIMARY KEY (id),
  CONSTRAINT blood_request_responses_tenant_id_blood_request_id_fk FOREIGN KEY (tenant_id, blood_request_id)
    REFERENCES public.blood_requests (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT blood_request_responses_tenant_id_blood_donor_id_fk FOREIGN KEY (tenant_id, blood_donor_id)
    REFERENCES public.blood_donors (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT blood_request_responses_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.donor_response_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT blood_request_responses_tenant_request_donor_uq UNIQUE (tenant_id, blood_request_id, blood_donor_id)
);
--> statement-breakpoint
-- Donor history.
CREATE INDEX blood_request_responses_tenant_donor_idx ON public.blood_request_responses (tenant_id, blood_donor_id, id DESC);
--> statement-breakpoint
CREATE TRIGGER blood_request_responses_set_updated_at BEFORE UPDATE ON public.blood_request_responses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- national_hotlines (§10.7): GLOBAL
-- ============================================================================

CREATE TABLE public.national_hotlines (
  id                     uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  service_type_code      text        NOT NULL,
  name_bn                text        NOT NULL,
  name_en                text        NOT NULL,
  dial_string            text        NOT NULL,
  description_bn         text,
  description_en         text,
  sort_order             integer     NOT NULL DEFAULT 0,
  is_active              boolean     NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT national_hotlines_pk PRIMARY KEY (id),
  CONSTRAINT national_hotlines_service_type_code_fk FOREIGN KEY (service_type_code)
    REFERENCES public.emergency_service_types (code) ON DELETE RESTRICT,
  CONSTRAINT national_hotlines_dial_string_ck CHECK (dial_string ~ '^[0-9+]{3,15}$')
);
--> statement-breakpoint
CREATE INDEX national_hotlines_active_sort_idx ON public.national_hotlines (is_active, sort_order);
--> statement-breakpoint
CREATE TRIGGER national_hotlines_set_updated_at BEFORE UPDATE ON public.national_hotlines
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- emergency_contacts (§10.8): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.emergency_contacts (
  id                     uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id              uuid        NOT NULL DEFAULT public.current_tenant_id(),
  service_type_code      text        NOT NULL,
  name_bn                text        NOT NULL,
  name_en                text,
  phones                 text[]      NOT NULL,
  address_text           text,
  location               geography(Point,4326),
  place_id               uuid,
  is_24h                 boolean     NOT NULL DEFAULT false,
  availability_note      text,
  last_verified_at       timestamptz,
  verified_by_user_id    uuid,
  sort_order             integer     NOT NULL DEFAULT 0,
  is_active              boolean     NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,
  CONSTRAINT emergency_contacts_pk PRIMARY KEY (id),
  CONSTRAINT emergency_contacts_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT emergency_contacts_service_type_code_fk FOREIGN KEY (service_type_code)
    REFERENCES public.emergency_service_types (code) ON DELETE RESTRICT,
  CONSTRAINT emergency_contacts_tenant_id_place_id_fk FOREIGN KEY (tenant_id, place_id)
    REFERENCES public.places (tenant_id, id) ON DELETE SET NULL (place_id),
  CONSTRAINT emergency_contacts_verified_by_user_id_fk FOREIGN KEY (verified_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT emergency_contacts_phones_ck CHECK (cardinality(phones) >= 1)
);
--> statement-breakpoint
-- Emergency page.
CREATE INDEX emergency_contacts_page_idx ON public.emergency_contacts (tenant_id, service_type_code, sort_order)
  WHERE is_active AND deleted_at IS NULL;
--> statement-breakpoint
-- "Nearest ambulance".
CREATE INDEX emergency_contacts_location_gix ON public.emergency_contacts USING gist (location) WHERE is_active;
--> statement-breakpoint
-- Re-verification worklist for agents.
CREATE INDEX emergency_contacts_reverify_idx ON public.emergency_contacts (tenant_id, last_verified_at NULLS FIRST)
  WHERE is_active;
--> statement-breakpoint
CREATE TRIGGER emergency_contacts_set_updated_at BEFORE UPDATE ON public.emergency_contacts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- notices (§10.9): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.notices (
  id                          uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                   uuid        NOT NULL DEFAULT public.current_tenant_id(),
  notice_type_code            text        NOT NULL,
  title                       text        NOT NULL,
  body                        text        NOT NULL,
  content_locale              text        NOT NULL DEFAULT 'bn',
  issuer_name                 text,
  is_official                 boolean     NOT NULL DEFAULT false,
  published_by_member_id      uuid        NOT NULL,
  geo_area_id                 uuid,
  event_starts_at             timestamptz,
  event_ends_at               timestamptz,
  expires_at                  timestamptz,
  is_pinned                   boolean     NOT NULL DEFAULT false,
  status_code                 text        NOT NULL DEFAULT 'pending_review',
  published_at                timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  deleted_at                  timestamptz,
  CONSTRAINT notices_pk PRIMARY KEY (id),
  CONSTRAINT notices_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT notices_notice_type_code_fk FOREIGN KEY (notice_type_code)
    REFERENCES public.notice_types (code) ON DELETE RESTRICT,
  CONSTRAINT notices_tenant_id_published_by_member_id_fk FOREIGN KEY (tenant_id, published_by_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT notices_geo_area_id_fk FOREIGN KEY (geo_area_id)
    REFERENCES public.geo_areas (id) ON DELETE RESTRICT,
  CONSTRAINT notices_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.notice_statuses (code) ON DELETE RESTRICT,
  -- Composite-FK target (§0.4).
  CONSTRAINT notices_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- Notice board.
CREATE INDEX notices_board_idx ON public.notices (tenant_id, is_pinned DESC, published_at DESC)
  WHERE status_code = 'published' AND deleted_at IS NULL;
--> statement-breakpoint
-- Filtered board.
CREATE INDEX notices_type_board_idx ON public.notices (tenant_id, notice_type_code, published_at DESC)
  WHERE status_code = 'published';
--> statement-breakpoint
-- Cross-tenant system job: expire notices.
CREATE INDEX notices_expiry_idx ON public.notices (status_code, expires_at)
  WHERE status_code = 'published' AND expires_at IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER notices_set_updated_at BEFORE UPDATE ON public.notices
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- A plain member's submission is always forced to pending_review, and
-- is_official/is_pinned can only be set by staff (service + trigger).
CREATE OR REPLACE FUNCTION public.notices_enforce_member_limits()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT public.app_is_staff() THEN
    NEW.status_code := 'pending_review';
    NEW.is_official := false;
    NEW.is_pinned := false;
    NEW.published_at := NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER notices_a_enforce_member_limits BEFORE INSERT ON public.notices
  FOR EACH ROW EXECUTE FUNCTION public.notices_enforce_member_limits();
--> statement-breakpoint
CREATE TRIGGER notices_b_enforce_member_limits BEFORE UPDATE ON public.notices
  FOR EACH ROW EXECUTE FUNCTION public.notices_enforce_member_limits();
--> statement-breakpoint

-- ============================================================================
-- transport_routes (§10.10): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.transport_routes (
  id                          uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                   uuid          NOT NULL DEFAULT public.current_tenant_id(),
  mode_code                   text          NOT NULL,
  name_bn                     text          NOT NULL,
  name_en                     text,
  operator_name                text,
  origin_name                  text          NOT NULL,
  destination_name             text          NOT NULL,
  origin_location               geography(Point,4326),
  destination_location          geography(Point,4326),
  typical_duration_minutes      integer,
  fare_min                     numeric(12,2),
  fare_max                     numeric(12,2),
  fare_updated_on               date,
  contact_phones               text[]        NOT NULL DEFAULT '{}',
  notes                        text,
  last_verified_at              timestamptz,
  is_active                    boolean       NOT NULL DEFAULT true,
  created_at                   timestamptz   NOT NULL DEFAULT now(),
  updated_at                   timestamptz   NOT NULL DEFAULT now(),
  deleted_at                   timestamptz,
  CONSTRAINT transport_routes_pk PRIMARY KEY (id),
  CONSTRAINT transport_routes_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT transport_routes_mode_code_fk FOREIGN KEY (mode_code)
    REFERENCES public.transport_modes (code) ON DELETE RESTRICT,
  CONSTRAINT transport_routes_fare_max_ck CHECK (fare_max IS NULL OR fare_min IS NULL OR fare_max >= fare_min),
  -- Composite-FK target (§0.4).
  CONSTRAINT transport_routes_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- Browse by mode.
CREATE INDEX transport_routes_mode_idx ON public.transport_routes (tenant_id, mode_code)
  WHERE is_active AND deleted_at IS NULL;
--> statement-breakpoint
-- "Going to Dhaka" search.
CREATE INDEX transport_routes_destination_trgm_gix ON public.transport_routes USING gin (destination_name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX transport_routes_origin_location_gix ON public.transport_routes USING gist (origin_location)
  WHERE origin_location IS NOT NULL;
--> statement-breakpoint
CREATE INDEX transport_routes_destination_location_gix ON public.transport_routes USING gist (destination_location)
  WHERE destination_location IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER transport_routes_set_updated_at BEFORE UPDATE ON public.transport_routes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- transport_route_stops (§10.11): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.transport_route_stops (
  id                       uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                uuid          NOT NULL DEFAULT public.current_tenant_id(),
  transport_route_id       uuid          NOT NULL,
  seq                      smallint      NOT NULL,
  name_bn                  text          NOT NULL,
  name_en                  text,
  location                 geography(Point,4326),
  minutes_from_origin      integer,
  fare_from_origin         numeric(12,2),
  created_at               timestamptz   NOT NULL DEFAULT now(),
  updated_at               timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT transport_route_stops_pk PRIMARY KEY (id),
  CONSTRAINT transport_route_stops_tenant_id_route_id_fk FOREIGN KEY (tenant_id, transport_route_id)
    REFERENCES public.transport_routes (tenant_id, id) ON DELETE CASCADE,
  -- Reorderable within a transaction.
  CONSTRAINT transport_route_stops_tenant_route_seq_uq UNIQUE (tenant_id, transport_route_id, seq)
    DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
-- "Which routes stop near me".
CREATE INDEX transport_route_stops_location_gix ON public.transport_route_stops USING gist (location)
  WHERE location IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER transport_route_stops_set_updated_at BEFORE UPDATE ON public.transport_route_stops
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- transport_schedules (§10.12): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.transport_schedules (
  id                       uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                uuid          NOT NULL DEFAULT public.current_tenant_id(),
  transport_route_id       uuid          NOT NULL,
  direction_code           text          NOT NULL DEFAULT 'outbound',
  departure_time           time          NOT NULL,
  iso_days_of_week         smallint[]    NOT NULL DEFAULT '{1,2,3,4,5,6,7}',
  valid_from               date,
  valid_to                 date,
  service_class            text,
  fare                     numeric(12,2),
  notes                    text,
  created_at               timestamptz   NOT NULL DEFAULT now(),
  updated_at               timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT transport_schedules_pk PRIMARY KEY (id),
  CONSTRAINT transport_schedules_tenant_id_route_id_fk FOREIGN KEY (tenant_id, transport_route_id)
    REFERENCES public.transport_routes (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT transport_schedules_direction_code_fk FOREIGN KEY (direction_code)
    REFERENCES public.route_directions (code) ON DELETE RESTRICT,
  CONSTRAINT transport_schedules_days_ck CHECK (iso_days_of_week <@ ARRAY[1,2,3,4,5,6,7]::smallint[])
);
--> statement-breakpoint
-- Timetable, "next departure".
CREATE INDEX transport_schedules_timetable_idx
  ON public.transport_schedules (tenant_id, transport_route_id, direction_code, departure_time);
--> statement-breakpoint
CREATE TRIGGER transport_schedules_set_updated_at BEFORE UPDATE ON public.transport_schedules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- lost_found_items (§10.13): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.lost_found_items (
  id                       uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                uuid          NOT NULL DEFAULT public.current_tenant_id(),
  kind_code                text          NOT NULL,
  item_type_code           text          NOT NULL,
  title                    text          NOT NULL,
  description              text,
  occurred_on              date,
  location_text            text,
  locality_id              uuid,
  location                 geography(Point,4326),
  reporter_member_id       uuid          NOT NULL,
  contact_via_code         text          NOT NULL DEFAULT 'chat',
  contact_phone_e164       text,
  reward_amount            numeric(12,2),
  is_sensitive             boolean       NOT NULL DEFAULT false,
  status_code              text          NOT NULL DEFAULT 'pending_review',
  matched_item_id          uuid,
  resolved_at              timestamptz,
  resolution_note          text,
  expires_at               timestamptz,
  created_at               timestamptz   NOT NULL DEFAULT now(),
  updated_at               timestamptz   NOT NULL DEFAULT now(),
  deleted_at               timestamptz,
  CONSTRAINT lost_found_items_pk PRIMARY KEY (id),
  CONSTRAINT lost_found_items_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT lost_found_items_kind_code_fk FOREIGN KEY (kind_code)
    REFERENCES public.lost_found_kinds (code) ON DELETE RESTRICT,
  CONSTRAINT lost_found_items_item_type_code_fk FOREIGN KEY (item_type_code)
    REFERENCES public.lost_found_item_types (code) ON DELETE RESTRICT,
  CONSTRAINT lost_found_items_tenant_id_locality_id_fk FOREIGN KEY (tenant_id, locality_id)
    REFERENCES public.localities (tenant_id, id) ON DELETE SET NULL (locality_id),
  CONSTRAINT lost_found_items_tenant_id_reporter_member_id_fk FOREIGN KEY (tenant_id, reporter_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT lost_found_items_tenant_id_matched_item_id_fk FOREIGN KEY (tenant_id, matched_item_id)
    REFERENCES public.lost_found_items (tenant_id, id) ON DELETE SET NULL (matched_item_id),
  CONSTRAINT lost_found_items_contact_via_code_fk FOREIGN KEY (contact_via_code)
    REFERENCES public.contact_methods (code) ON DELETE RESTRICT,
  CONSTRAINT lost_found_items_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.lost_found_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT lost_found_items_reward_amount_ck CHECK (reward_amount IS NULL OR reward_amount >= 0),
  -- Composite-FK target (§0.4).
  CONSTRAINT lost_found_items_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- Board.
CREATE INDEX lost_found_items_board_idx ON public.lost_found_items (tenant_id, kind_code, id DESC)
  WHERE status_code = 'open' AND deleted_at IS NULL;
--> statement-breakpoint
-- "Found phones" filter, matching suggestions.
CREATE INDEX lost_found_items_type_idx ON public.lost_found_items (tenant_id, item_type_code) WHERE status_code = 'open';
--> statement-breakpoint
-- Nearby.
CREATE INDEX lost_found_items_location_gix ON public.lost_found_items USING gist (location) WHERE status_code = 'open';
--> statement-breakpoint
-- Cross-tenant system job: expire items.
CREATE INDEX lost_found_items_expiry_idx ON public.lost_found_items (status_code, expires_at) WHERE status_code = 'open';
--> statement-breakpoint
CREATE TRIGGER lost_found_items_set_updated_at BEFORE UPDATE ON public.lost_found_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- Sensitive items always enter pending_review, regardless of what was requested.
CREATE OR REPLACE FUNCTION public.lost_found_items_force_sensitive_review()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_sensitive AND NOT public.app_is_staff() THEN
    NEW.status_code := 'pending_review';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER lost_found_items_a_force_sensitive_review BEFORE INSERT OR UPDATE ON public.lost_found_items
  FOR EACH ROW EXECUTE FUNCTION public.lost_found_items_force_sensitive_review();


-- ============================================================================
-- Closing three deferred FKs from 0010 (reports' target columns).
-- ============================================================================

ALTER TABLE public.reports
  ADD CONSTRAINT reports_tenant_id_lost_found_item_id_fk FOREIGN KEY (tenant_id, lost_found_item_id)
    REFERENCES public.lost_found_items (tenant_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE public.reports
  ADD CONSTRAINT reports_tenant_id_notice_id_fk FOREIGN KEY (tenant_id, notice_id)
    REFERENCES public.notices (tenant_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE public.reports
  ADD CONSTRAINT reports_tenant_id_blood_request_id_fk FOREIGN KEY (tenant_id, blood_request_id)
    REFERENCES public.blood_requests (tenant_id, id) ON DELETE RESTRICT;


-- ============================================================================
-- RLS: enable + force on every table created in this migration
-- ============================================================================

DO $$
DECLARE
  obj record;
BEGIN
  FOR obj IN
    SELECT c.oid::regclass AS ident
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname IN (
        'commodity_groups', 'measurement_units', 'market_types', 'price_sources', 'price_statuses',
        'blood_groups', 'donor_contact_preferences', 'blood_request_statuses', 'urgency_levels',
        'donor_response_statuses', 'emergency_service_types', 'notice_types', 'notice_statuses',
        'transport_modes', 'route_directions', 'lost_found_kinds', 'lost_found_item_types', 'contact_methods',
        'lost_found_statuses',
        'bazar_commodities', 'bazar_markets', 'bazar_prices', 'blood_donors', 'blood_requests',
        'blood_request_responses', 'national_hotlines', 'emergency_contacts', 'notices', 'transport_routes',
        'transport_route_stops', 'transport_schedules', 'lost_found_items'
      )
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.ident);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', obj.ident);
  END LOOP;
END
$$;
--> statement-breakpoint

-- ---- enum tables: read by all, write by platform admin (as 0002-0010) ----

DO $$
DECLARE
  enum_table text;
BEGIN
  FOREACH enum_table IN ARRAY ARRAY[
    'commodity_groups', 'measurement_units', 'market_types', 'price_sources', 'price_statuses',
    'blood_groups', 'donor_contact_preferences', 'blood_request_statuses', 'urgency_levels',
    'donor_response_statuses', 'emergency_service_types', 'notice_types', 'notice_statuses',
    'transport_modes', 'route_directions', 'lost_found_kinds', 'lost_found_item_types', 'contact_methods',
    'lost_found_statuses'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT USING (true)',
      enum_table || '_read_all', enum_table
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()))',
      enum_table || '_platform_admin', enum_table
    );
  END LOOP;
END
$$;
--> statement-breakpoint

-- ---- bazar_commodities (§10.1): G-REFERENCE ------------------------------

CREATE POLICY bazar_commodities_read_all ON public.bazar_commodities FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY bazar_commodities_platform_admin ON public.bazar_commodities
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- bazar_markets (§10.2): T-PUBLIC-READ (active); staff+agent write ----

CREATE POLICY bazar_markets_public_read ON public.bazar_markets
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND is_active);
--> statement-breakpoint
CREATE POLICY bazar_markets_staff_agent_write ON public.bazar_markets
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND ((SELECT public.app_is_staff()) OR (SELECT public.app_role()) = 'agent'))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND ((SELECT public.app_is_staff()) OR (SELECT public.app_role()) = 'agent'));
--> statement-breakpoint
CREATE POLICY bazar_markets_platform_admin ON public.bazar_markets
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- bazar_prices (§10.3): T-PUBLIC-READ (published); agents/staff/members insert; staff publish

CREATE POLICY bazar_prices_public_read ON public.bazar_prices
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND status_code = 'published');
--> statement-breakpoint
CREATE POLICY bazar_prices_member_insert ON public.bazar_prices
  FOR INSERT
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_active_user()));
--> statement-breakpoint
CREATE POLICY bazar_prices_staff_publish ON public.bazar_prices
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY bazar_prices_platform_admin ON public.bazar_prices
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- blood_donors (§10.4): authenticated members only; owner; staff -----

CREATE POLICY blood_donors_authenticated_read ON public.blood_donors
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_active_user()) AND is_available);
--> statement-breakpoint
CREATE POLICY blood_donors_owner_write ON public.blood_donors
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND member_id = (SELECT public.current_member_id()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND member_id = (SELECT public.current_member_id()));
--> statement-breakpoint
CREATE POLICY blood_donors_staff_read ON public.blood_donors
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY blood_donors_platform_admin ON public.blood_donors
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- blood_requests (§10.5): authenticated members (open); requester; staff

CREATE POLICY blood_requests_authenticated_read ON public.blood_requests
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_active_user()) AND status_code = 'open');
--> statement-breakpoint
CREATE POLICY blood_requests_owner_write ON public.blood_requests
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND requester_member_id = (SELECT public.current_member_id()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND requester_member_id = (SELECT public.current_member_id()));
--> statement-breakpoint
CREATE POLICY blood_requests_staff_moderate ON public.blood_requests
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY blood_requests_platform_admin ON public.blood_requests
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- blood_request_responses (§10.6): T-ISOLATE; requester/donor/staff --

CREATE POLICY blood_request_responses_requester_read ON public.blood_request_responses
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND EXISTS (
      SELECT 1 FROM public.blood_requests br
      WHERE br.tenant_id = blood_request_responses.tenant_id AND br.id = blood_request_responses.blood_request_id
        AND br.requester_member_id = (SELECT public.current_member_id())
    )
  );
--> statement-breakpoint
CREATE POLICY blood_request_responses_donor_access ON public.blood_request_responses
  FOR ALL
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND EXISTS (
      SELECT 1 FROM public.blood_donors bd
      WHERE bd.tenant_id = blood_request_responses.tenant_id AND bd.id = blood_request_responses.blood_donor_id
        AND bd.member_id = (SELECT public.current_member_id())
    )
  )
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND EXISTS (
      SELECT 1 FROM public.blood_donors bd
      WHERE bd.tenant_id = blood_request_responses.tenant_id AND bd.id = blood_request_responses.blood_donor_id
        AND bd.member_id = (SELECT public.current_member_id())
    )
  );
--> statement-breakpoint
CREATE POLICY blood_request_responses_requester_update ON public.blood_request_responses
  FOR UPDATE
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND EXISTS (
      SELECT 1 FROM public.blood_requests br
      WHERE br.tenant_id = blood_request_responses.tenant_id AND br.id = blood_request_responses.blood_request_id
        AND br.requester_member_id = (SELECT public.current_member_id())
    )
  )
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND EXISTS (
      SELECT 1 FROM public.blood_requests br
      WHERE br.tenant_id = blood_request_responses.tenant_id AND br.id = blood_request_responses.blood_request_id
        AND br.requester_member_id = (SELECT public.current_member_id())
    )
  );
--> statement-breakpoint
CREATE POLICY blood_request_responses_staff_read ON public.blood_request_responses
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY blood_request_responses_platform_admin ON public.blood_request_responses
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- national_hotlines (§10.7): G-REFERENCE ------------------------------

CREATE POLICY national_hotlines_read_all ON public.national_hotlines FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY national_hotlines_platform_admin ON public.national_hotlines
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- emergency_contacts (§10.8): T-PUBLIC-READ incl. anonymous; staff+agent write

CREATE POLICY emergency_contacts_public_read ON public.emergency_contacts
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND is_active AND deleted_at IS NULL);
--> statement-breakpoint
CREATE POLICY emergency_contacts_staff_agent_write ON public.emergency_contacts
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND ((SELECT public.app_is_staff()) OR (SELECT public.app_role()) = 'agent'))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND ((SELECT public.app_is_staff()) OR (SELECT public.app_role()) = 'agent'));
--> statement-breakpoint
CREATE POLICY emergency_contacts_platform_admin ON public.emergency_contacts
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- notices (§10.9): T-PUBLIC-READ (published); member insert (forced); staff

CREATE POLICY notices_public_read ON public.notices
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND status_code = 'published' AND deleted_at IS NULL);
--> statement-breakpoint
CREATE POLICY notices_member_insert ON public.notices
  FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND published_by_member_id = (SELECT public.current_member_id())
    AND (SELECT public.app_is_active_user())
  );
--> statement-breakpoint
CREATE POLICY notices_staff_all ON public.notices
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY notices_platform_admin ON public.notices
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- transport_routes (§10.10): T-PUBLIC-READ (active); staff+agent write

CREATE POLICY transport_routes_public_read ON public.transport_routes
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND is_active AND deleted_at IS NULL);
--> statement-breakpoint
CREATE POLICY transport_routes_staff_agent_write ON public.transport_routes
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND ((SELECT public.app_is_staff()) OR (SELECT public.app_role()) = 'agent'))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND ((SELECT public.app_is_staff()) OR (SELECT public.app_role()) = 'agent'));
--> statement-breakpoint
CREATE POLICY transport_routes_platform_admin ON public.transport_routes
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- transport_route_stops / transport_schedules (§10.11-12): same as parent route

CREATE POLICY transport_route_stops_public_read ON public.transport_route_stops
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND EXISTS (
      SELECT 1 FROM public.transport_routes tr
      WHERE tr.tenant_id = transport_route_stops.tenant_id AND tr.id = transport_route_stops.transport_route_id
        AND tr.is_active AND tr.deleted_at IS NULL
    )
  );
--> statement-breakpoint
CREATE POLICY transport_route_stops_staff_agent_write ON public.transport_route_stops
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND ((SELECT public.app_is_staff()) OR (SELECT public.app_role()) = 'agent'))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND ((SELECT public.app_is_staff()) OR (SELECT public.app_role()) = 'agent'));
--> statement-breakpoint
CREATE POLICY transport_route_stops_platform_admin ON public.transport_route_stops
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

CREATE POLICY transport_schedules_public_read ON public.transport_schedules
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND EXISTS (
      SELECT 1 FROM public.transport_routes tr
      WHERE tr.tenant_id = transport_schedules.tenant_id AND tr.id = transport_schedules.transport_route_id
        AND tr.is_active AND tr.deleted_at IS NULL
    )
  );
--> statement-breakpoint
CREATE POLICY transport_schedules_staff_agent_write ON public.transport_schedules
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND ((SELECT public.app_is_staff()) OR (SELECT public.app_role()) = 'agent'))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND ((SELECT public.app_is_staff()) OR (SELECT public.app_role()) = 'agent'));
--> statement-breakpoint
CREATE POLICY transport_schedules_platform_admin ON public.transport_schedules
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- lost_found_items (§10.13): T-PUBLIC-READ (open, resolved); reporter; staff

CREATE POLICY lost_found_items_public_read ON public.lost_found_items
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND status_code IN ('open', 'resolved')
    AND deleted_at IS NULL
  );
--> statement-breakpoint
CREATE POLICY lost_found_items_owner_write ON public.lost_found_items
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND reporter_member_id = (SELECT public.current_member_id()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND reporter_member_id = (SELECT public.current_member_id()));
--> statement-breakpoint
CREATE POLICY lost_found_items_staff_moderate ON public.lost_found_items
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY lost_found_items_platform_admin ON public.lost_found_items
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));


-- ============================================================================
-- Grants
-- ============================================================================

GRANT SELECT ON
  public.commodity_groups, public.measurement_units, public.market_types, public.price_sources,
  public.price_statuses, public.blood_groups, public.donor_contact_preferences, public.blood_request_statuses,
  public.urgency_levels, public.donor_response_statuses, public.emergency_service_types, public.notice_types,
  public.notice_statuses, public.transport_modes, public.route_directions, public.lost_found_kinds,
  public.lost_found_item_types, public.contact_methods, public.lost_found_statuses
TO ae_app;
--> statement-breakpoint
GRANT INSERT, UPDATE ON
  public.commodity_groups, public.measurement_units, public.market_types, public.price_sources,
  public.price_statuses, public.blood_groups, public.donor_contact_preferences, public.blood_request_statuses,
  public.urgency_levels, public.donor_response_statuses, public.emergency_service_types, public.notice_types,
  public.notice_statuses, public.transport_modes, public.route_directions, public.lost_found_kinds,
  public.lost_found_item_types, public.contact_methods, public.lost_found_statuses
TO ae_app;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.bazar_commodities TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.bazar_markets TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.bazar_prices TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.blood_donors TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.blood_requests TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.blood_request_responses TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.national_hotlines TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.emergency_contacts TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.notices TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.transport_routes TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.transport_route_stops TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.transport_schedules TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.lost_found_items TO ae_app;
