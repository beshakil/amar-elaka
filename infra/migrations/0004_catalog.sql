-- 0004_catalog
--
-- Catalog domain (docs/specs/schema.md §3): administrative geography imported
-- from HDX COD-AB (ADR 003), tenant-curated informal localities, the global
-- category taxonomy with its versioned custom-field schemas, and each
-- tenant's enable/reorder/price override of that taxonomy. Runs as
-- ae_migrator; RLS and grants are in this same file, as in 0003.
--
-- Closes two deferred items, now that geo_areas/localities exist:
--   - tenants.geo_area_id -> geo_areas(id) ON DELETE RESTRICT, plus the
--     trigger rejecting a geo_area still awaiting manual review (§3.1's flag).
--   - tenant_members.home_locality_id -> localities(tenant_id, id)
--     ON DELETE SET NULL (home_locality_id), composite FK per §0.4, plus its
--     supporting index.
--
-- Triggers added here are all self-contained (no dependency on tables from
-- later migrations), unlike 0003's deferred tenant-lifecycle state machine:
--   - geo_areas: maintains the ancestor_ids materialised path on insert/
--     reparent. Known limitation, documented at the trigger: reparenting an
--     ancestor does not cascade to already-computed descendants — boundary
--     data is imported once and essentially static, so this is acceptable
--     for now; a full reimport rebuilds every path anyway.
--   - categories: maintains `depth`, and rejects a child whose kind_code
--     does not match its parent's.
--   - category_field_schemas: a published row is immutable — nobody,
--     including platform_admin, can rewrite a version that live posts
--     already pin to; publish a new version instead.
--   - localities: geo_area_id (when set) must be the tenant's own area or a
--     descendant of it.
--   - tenant_categories: a tenant may only make moderation stricter than the
--     category default, never looser, when the category is marked `pre`.
--
-- Still deferred:
--   - The HDX COD-AB data import itself (ogr2ogr, ADR 003) is an
--     operational script, not part of this migration. It runs as
--     ae_migrator with `app.is_platform_admin` set for the import
--     transaction (greppable, same escape hatch ADR 019 documents), because
--     FORCE ROW LEVEL SECURITY binds the owner too.

-- ============================================================================
-- Enum tables
-- ============================================================================

CREATE TABLE public.geo_area_levels (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT geo_area_levels_pk PRIMARY KEY (code),
  CONSTRAINT geo_area_levels_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER geo_area_levels_set_updated_at BEFORE UPDATE ON public.geo_area_levels
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.geo_area_levels (code, label_key, sort_order) VALUES
  ('country',          'enum.geo_area_levels.country',          10),
  ('division',         'enum.geo_area_levels.division',         20),
  ('district',         'enum.geo_area_levels.district',         30),
  ('upazila',          'enum.geo_area_levels.upazila',          40),
  ('metro_thana',      'enum.geo_area_levels.metro_thana',      50),
  ('city_corporation', 'enum.geo_area_levels.city_corporation', 60),
  ('pourashava',       'enum.geo_area_levels.pourashava',       70),
  ('union',            'enum.geo_area_levels.union',            80),
  ('ward',             'enum.geo_area_levels.ward',              90);
--> statement-breakpoint

CREATE TABLE public.category_kinds (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT category_kinds_pk PRIMARY KEY (code),
  CONSTRAINT category_kinds_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER category_kinds_set_updated_at BEFORE UPDATE ON public.category_kinds
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.category_kinds (code, label_key, sort_order) VALUES
  ('marketplace', 'enum.category_kinds.marketplace', 10),
  ('service',     'enum.category_kinds.service',     20),
  ('job',         'enum.category_kinds.job',         30),
  ('rental',      'enum.category_kinds.rental',      40),
  ('place',       'enum.category_kinds.place',       50);
--> statement-breakpoint

CREATE TABLE public.schema_statuses (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schema_statuses_pk PRIMARY KEY (code),
  CONSTRAINT schema_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER schema_statuses_set_updated_at BEFORE UPDATE ON public.schema_statuses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.schema_statuses (code, label_key, sort_order) VALUES
  ('draft',     'enum.schema_statuses.draft',     10),
  ('published', 'enum.schema_statuses.published', 20),
  ('retired',   'enum.schema_statuses.retired',   30);
--> statement-breakpoint

-- ============================================================================
-- geo_areas (§3.1): GLOBAL, Bangladesh administrative boundaries (ADR 003)
-- ============================================================================

CREATE TABLE public.geo_areas (
  id                            uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  parent_id                     uuid,
  adm_level                     smallint    NOT NULL,
  level_code                    text        NOT NULL,
  bbs_code_geocode11            text,
  bbs_code_geocode15            text,
  name_en                       text        NOT NULL,
  name_bn                       text,
  ancestor_ids                  uuid[]      NOT NULL DEFAULT '{}',
  centroid                      geography(Point, 4326),
  boundary                      geography(MultiPolygon, 4326),
  boundary_simplified           geography(MultiPolygon, 4326),
  needs_manual_review           boolean     NOT NULL DEFAULT false,
  manually_verified_at          timestamptz,
  manually_verified_by_user_id  uuid,
  source_release                text        NOT NULL,
  is_active                     boolean     NOT NULL DEFAULT true,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT geo_areas_pk PRIMARY KEY (id),
  CONSTRAINT geo_areas_parent_id_fk FOREIGN KEY (parent_id)
    REFERENCES public.geo_areas (id) ON DELETE RESTRICT,
  CONSTRAINT geo_areas_level_code_fk FOREIGN KEY (level_code)
    REFERENCES public.geo_area_levels (code) ON DELETE RESTRICT,
  CONSTRAINT geo_areas_manually_verified_by_user_id_fk FOREIGN KEY (manually_verified_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT geo_areas_adm_level_ck CHECK (adm_level BETWEEN 0 AND 4),
  -- ADM0 (the country row itself, parent_id NULL) has no BBS subdivision
  -- geocode; every real subdivision (ADM1-4) must carry at least one.
  CONSTRAINT geo_areas_bbs_code_ck
    CHECK (adm_level = 0 OR num_nonnulls(bbs_code_geocode11, bbs_code_geocode15) >= 1)
);
--> statement-breakpoint
-- Idempotent upsert by pcode on re-import.
CREATE UNIQUE INDEX geo_areas_adm_level_geocode11_uq ON public.geo_areas (adm_level, bbs_code_geocode11)
  WHERE bbs_code_geocode11 IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX geo_areas_adm_level_geocode15_uq ON public.geo_areas (adm_level, bbs_code_geocode15)
  WHERE bbs_code_geocode15 IS NOT NULL;
--> statement-breakpoint
-- Children pickers (district -> upazilas); also the FK index (§0.4).
CREATE INDEX geo_areas_parent_id_idx ON public.geo_areas (parent_id)
  WHERE parent_id IS NOT NULL;
--> statement-breakpoint
-- "Everything inside district X" without recursive CTEs.
CREATE INDEX geo_areas_ancestor_ids_gin_idx ON public.geo_areas USING gin (ancestor_ids);
--> statement-breakpoint
-- Point-in-polygon and buffer-distance queries (§13.26).
CREATE INDEX geo_areas_boundary_gist_idx ON public.geo_areas USING gist (boundary);
--> statement-breakpoint
-- Not queried spatially today, but every geography column carries a GiST
-- index (audit rule). Serves bbox fetches for map tiles.
CREATE INDEX geo_areas_boundary_simplified_gist_idx ON public.geo_areas USING gist (boundary_simplified);
--> statement-breakpoint
-- Nearest-area lookups for labels and pickers.
CREATE INDEX geo_areas_centroid_gist_idx ON public.geo_areas USING gist (centroid);
--> statement-breakpoint
-- Manual verification worklist.
CREATE INDEX geo_areas_manual_review_idx ON public.geo_areas (adm_level)
  WHERE needs_manual_review AND manually_verified_at IS NULL;
--> statement-breakpoint
-- Fuzzy area picker search in both scripts (display search only).
CREATE INDEX geo_areas_name_bn_trgm_idx ON public.geo_areas USING gin (name_bn gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX geo_areas_name_en_trgm_idx ON public.geo_areas USING gin (name_en gin_trgm_ops);
--> statement-breakpoint
CREATE TRIGGER geo_areas_set_updated_at BEFORE UPDATE ON public.geo_areas
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- Materialised path, root first. See the header note on reparenting.
CREATE OR REPLACE FUNCTION public.geo_areas_maintain_ancestor_ids()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent public.geo_areas%ROWTYPE;
BEGIN
  IF NEW.parent_id IS NULL THEN
    NEW.ancestor_ids := '{}';
    RETURN NEW;
  END IF;

  SELECT * INTO parent FROM public.geo_areas WHERE id = NEW.parent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'geo_areas.parent_id % does not exist', NEW.parent_id;
  END IF;

  NEW.ancestor_ids := parent.ancestor_ids || parent.id;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER geo_areas_a_maintain_ancestor_ids BEFORE INSERT OR UPDATE OF parent_id ON public.geo_areas
  FOR EACH ROW EXECUTE FUNCTION public.geo_areas_maintain_ancestor_ids();
--> statement-breakpoint

-- ============================================================================
-- localities (§3.2): TENANT-SCOPED, informal named places curated per tenant
-- ============================================================================

CREATE TABLE public.localities (
  id          uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id   uuid        NOT NULL DEFAULT public.current_tenant_id(),
  geo_area_id uuid,
  name_bn     text        NOT NULL,
  name_en     text,
  aliases     text[]      NOT NULL DEFAULT '{}',
  center      geography(Point, 4326),
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  CONSTRAINT localities_pk PRIMARY KEY (id),
  CONSTRAINT localities_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT localities_geo_area_id_fk FOREIGN KEY (geo_area_id)
    REFERENCES public.geo_areas (id) ON DELETE RESTRICT,
  -- Composite-FK target for tenant_members.home_locality_id etc. (§0.4).
  CONSTRAINT localities_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- No duplicate localities.
CREATE UNIQUE INDEX localities_tenant_id_name_bn_uq ON public.localities (tenant_id, name_bn)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
-- Locality picker.
CREATE INDEX localities_tenant_id_active_sort_idx ON public.localities (tenant_id, is_active, sort_order);
--> statement-breakpoint
-- Nearest-locality suggestion from GPS.
CREATE INDEX localities_center_gist_idx ON public.localities USING gist (center);
--> statement-breakpoint
-- FK index (§0.4).
CREATE INDEX localities_geo_area_id_idx ON public.localities (geo_area_id)
  WHERE geo_area_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER localities_set_updated_at BEFORE UPDATE ON public.localities
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- A locality's area, when set, must be the tenant's own area or descend
-- from it — a tenant can't curate a "neighbourhood" that sits in someone
-- else's territory.
CREATE OR REPLACE FUNCTION public.localities_validate_geo_area()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  tenant_area_id uuid;
  candidate public.geo_areas%ROWTYPE;
BEGIN
  IF NEW.geo_area_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT geo_area_id INTO tenant_area_id FROM public.tenants WHERE id = NEW.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'localities.tenant_id % does not exist', NEW.tenant_id;
  END IF;

  SELECT * INTO candidate FROM public.geo_areas WHERE id = NEW.geo_area_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'localities.geo_area_id % does not exist', NEW.geo_area_id;
  END IF;

  IF candidate.id <> tenant_area_id AND NOT (candidate.ancestor_ids @> ARRAY[tenant_area_id]) THEN
    RAISE EXCEPTION 'locality geo_area_id % is not the tenant''s area or a descendant of it', NEW.geo_area_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER localities_a_validate_geo_area BEFORE INSERT OR UPDATE OF geo_area_id, tenant_id
  ON public.localities
  FOR EACH ROW EXECUTE FUNCTION public.localities_validate_geo_area();
--> statement-breakpoint

-- ============================================================================
-- categories (§3.3): GLOBAL master taxonomy for posts and places
-- ============================================================================

CREATE TABLE public.categories (
  id                            uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  parent_id                     uuid,
  kind_code                     text        NOT NULL,
  slug                          text        NOT NULL,
  name_bn                       text        NOT NULL,
  name_en                       text        NOT NULL,
  description_bn                text,
  description_en                text,
  icon_key                      text,
  depth                         smallint    NOT NULL DEFAULT 0,
  default_sort_order            integer     NOT NULL DEFAULT 0,
  default_post_cost_credits     integer     NOT NULL DEFAULT 0,
  default_moderation_mode_code  text,
  is_active                     boolean     NOT NULL DEFAULT true,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  deleted_at                    timestamptz,
  CONSTRAINT categories_pk PRIMARY KEY (id),
  CONSTRAINT categories_parent_id_fk FOREIGN KEY (parent_id)
    REFERENCES public.categories (id) ON DELETE RESTRICT,
  CONSTRAINT categories_kind_code_fk FOREIGN KEY (kind_code)
    REFERENCES public.category_kinds (code) ON DELETE RESTRICT,
  CONSTRAINT categories_default_moderation_mode_code_fk FOREIGN KEY (default_moderation_mode_code)
    REFERENCES public.moderation_modes (code) ON DELETE RESTRICT,
  CONSTRAINT categories_slug_ck CHECK (slug = lower(slug)),
  CONSTRAINT categories_depth_ck CHECK (depth BETWEEN 0 AND 3),
  CONSTRAINT categories_default_post_cost_credits_ck CHECK (default_post_cost_credits >= 0)
);
--> statement-breakpoint
-- Flat category URLs.
CREATE UNIQUE INDEX categories_slug_uq ON public.categories (slug)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
-- Tree rendering; also the FK index (§0.4).
CREATE INDEX categories_parent_id_sort_idx ON public.categories (parent_id, default_sort_order);
--> statement-breakpoint
CREATE TRIGGER categories_set_updated_at BEFORE UPDATE ON public.categories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- Maintains depth and rejects a child whose kind_code diverges from its
-- parent's (a "vehicles" subtree can't gain a "jobs" child, etc).
CREATE OR REPLACE FUNCTION public.categories_validate_parent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent public.categories%ROWTYPE;
BEGIN
  IF NEW.parent_id IS NULL THEN
    NEW.depth := 0;
    RETURN NEW;
  END IF;

  SELECT * INTO parent FROM public.categories WHERE id = NEW.parent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'categories.parent_id % does not exist', NEW.parent_id;
  END IF;

  IF parent.kind_code <> NEW.kind_code THEN
    RAISE EXCEPTION 'category kind_code (%) must match its parent''s (%)', NEW.kind_code, parent.kind_code
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.depth := parent.depth + 1;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER categories_a_validate_parent BEFORE INSERT OR UPDATE OF parent_id, kind_code ON public.categories
  FOR EACH ROW EXECUTE FUNCTION public.categories_validate_parent();
--> statement-breakpoint

-- ============================================================================
-- category_field_schemas (§3.4): GLOBAL, versioned JSON Schema per category
-- ============================================================================

CREATE TABLE public.category_field_schemas (
  id                    uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  category_id           uuid        NOT NULL,
  version               integer     NOT NULL,
  json_schema           jsonb       NOT NULL,
  ui_schema             jsonb       NOT NULL DEFAULT '{}',
  filterable_fields     text[]      NOT NULL DEFAULT '{}',
  analytics_fields      text[]      NOT NULL DEFAULT '{}',
  status_code           text        NOT NULL DEFAULT 'draft',
  published_at          timestamptz,
  published_by_user_id  uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT category_field_schemas_pk PRIMARY KEY (id),
  CONSTRAINT category_field_schemas_category_id_fk FOREIGN KEY (category_id)
    REFERENCES public.categories (id) ON DELETE RESTRICT,
  CONSTRAINT category_field_schemas_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.schema_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT category_field_schemas_published_by_user_id_fk FOREIGN KEY (published_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT category_field_schemas_json_schema_ck CHECK (jsonb_typeof(json_schema) = 'object'),
  CONSTRAINT category_field_schemas_ui_schema_ck CHECK (jsonb_typeof(ui_schema) = 'object'),
  CONSTRAINT category_field_schemas_published_at_ck
    CHECK ((status_code = 'published') = (published_at IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX category_field_schemas_category_id_version_uq
  ON public.category_field_schemas (category_id, version);
--> statement-breakpoint
-- Exactly one live schema per category.
CREATE UNIQUE INDEX category_field_schemas_published_uq ON public.category_field_schemas (category_id)
  WHERE status_code = 'published';
--> statement-breakpoint
CREATE INDEX category_field_schemas_published_by_user_id_idx
  ON public.category_field_schemas (published_by_user_id)
  WHERE published_by_user_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER category_field_schemas_set_updated_at BEFORE UPDATE ON public.category_field_schemas
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- A published schema is immutable, for everyone including platform_admin:
-- posts pin to a specific version, so publish a new version instead of
-- editing this one.
CREATE OR REPLACE FUNCTION public.category_field_schemas_prevent_published_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status_code = 'published' THEN
    RAISE EXCEPTION 'category_field_schemas: a published schema is immutable (category %, version %)',
      OLD.category_id, OLD.version
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER category_field_schemas_a_prevent_published_mutation BEFORE UPDATE ON public.category_field_schemas
  FOR EACH ROW EXECUTE FUNCTION public.category_field_schemas_prevent_published_mutation();
--> statement-breakpoint

-- ============================================================================
-- tenant_categories (§3.5): TENANT-SCOPED enable/reorder/price of a category
-- ============================================================================

CREATE TABLE public.tenant_categories (
  id                     uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id              uuid        NOT NULL DEFAULT public.current_tenant_id(),
  category_id            uuid        NOT NULL,
  is_enabled             boolean     NOT NULL DEFAULT true,
  sort_order             integer     NOT NULL DEFAULT 0,
  post_cost_credits      integer,
  moderation_mode_code   text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_categories_pk PRIMARY KEY (id),
  CONSTRAINT tenant_categories_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_categories_category_id_fk FOREIGN KEY (category_id)
    REFERENCES public.categories (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_categories_moderation_mode_code_fk FOREIGN KEY (moderation_mode_code)
    REFERENCES public.moderation_modes (code) ON DELETE RESTRICT,
  CONSTRAINT tenant_categories_post_cost_credits_ck CHECK (post_cost_credits IS NULL OR post_cost_credits >= 0),
  CONSTRAINT tenant_categories_tenant_id_category_id_uq UNIQUE (tenant_id, category_id),
  -- Composite-FK target (§0.4).
  CONSTRAINT tenant_categories_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- Home category grid.
CREATE INDEX tenant_categories_tenant_id_enabled_sort_idx
  ON public.tenant_categories (tenant_id, is_enabled, sort_order);
--> statement-breakpoint
-- FK index (§0.4).
CREATE INDEX tenant_categories_category_id_idx ON public.tenant_categories (category_id);
--> statement-breakpoint
CREATE TRIGGER tenant_categories_set_updated_at BEFORE UPDATE ON public.tenant_categories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- A tenant may only make moderation stricter than the category default,
-- never looser, when the category is marked pre (scam-prone).
CREATE OR REPLACE FUNCTION public.tenant_categories_validate_moderation_mode()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  category_default text;
BEGIN
  IF NEW.moderation_mode_code IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT default_moderation_mode_code INTO category_default
  FROM public.categories WHERE id = NEW.category_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_categories.category_id % does not exist', NEW.category_id;
  END IF;

  IF category_default = 'pre' AND NEW.moderation_mode_code <> 'pre' THEN
    RAISE EXCEPTION 'tenant_categories: category % requires pre-moderation and cannot be loosened',
      NEW.category_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER tenant_categories_a_validate_moderation_mode
  BEFORE INSERT OR UPDATE OF moderation_mode_code, category_id ON public.tenant_categories
  FOR EACH ROW EXECUTE FUNCTION public.tenant_categories_validate_moderation_mode();
--> statement-breakpoint

-- ============================================================================
-- Closing two deferred items from 0001, now that geo_areas/localities exist.
-- ============================================================================

ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_geo_area_id_fk FOREIGN KEY (geo_area_id)
    REFERENCES public.geo_areas (id) ON DELETE RESTRICT;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.tenants_reject_unverified_geo_area()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  area public.geo_areas%ROWTYPE;
BEGIN
  SELECT * INTO area FROM public.geo_areas WHERE id = NEW.geo_area_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenants.geo_area_id % does not exist', NEW.geo_area_id;
  END IF;
  IF area.needs_manual_review AND area.manually_verified_at IS NULL THEN
    RAISE EXCEPTION 'geo_area % needs manual verification before a tenant can use it', NEW.geo_area_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER tenants_a_reject_unverified_geo_area BEFORE INSERT OR UPDATE OF geo_area_id ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.tenants_reject_unverified_geo_area();
--> statement-breakpoint

ALTER TABLE public.tenant_members
  ADD CONSTRAINT tenant_members_tenant_id_home_locality_id_fk
    FOREIGN KEY (tenant_id, home_locality_id) REFERENCES public.localities (tenant_id, id)
    ON DELETE SET NULL (home_locality_id);
--> statement-breakpoint
CREATE INDEX tenant_members_home_locality_id_idx ON public.tenant_members (tenant_id, home_locality_id)
  WHERE home_locality_id IS NOT NULL;
--> statement-breakpoint

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
        'geo_area_levels', 'category_kinds', 'schema_statuses',
        'geo_areas', 'localities', 'categories', 'category_field_schemas', 'tenant_categories'
      )
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.ident);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', obj.ident);
  END LOOP;
END
$$;
--> statement-breakpoint

-- ---- enum tables: read by all, write by platform admin (as 0002/0003) ----

DO $$
DECLARE
  enum_table text;
BEGIN
  FOREACH enum_table IN ARRAY ARRAY['geo_area_levels', 'category_kinds', 'schema_statuses']
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

-- ---- geo_areas: G-REFERENCE ------------------------------------------------

CREATE POLICY geo_areas_read_all ON public.geo_areas
  FOR SELECT
  USING (true);
--> statement-breakpoint
CREATE POLICY geo_areas_platform_admin ON public.geo_areas
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- localities: T-PUBLIC-READ (active rows); staff+agent write ----------

CREATE POLICY localities_public_read ON public.localities
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND is_active
    AND deleted_at IS NULL
  );
--> statement-breakpoint
CREATE POLICY localities_staff_write ON public.localities
  FOR ALL
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND public.app_role() IN ('moderator', 'tenant_admin', 'partner_owner', 'agent')
  )
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND public.app_role() IN ('moderator', 'tenant_admin', 'partner_owner', 'agent')
  );
--> statement-breakpoint
CREATE POLICY localities_platform_admin ON public.localities
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- categories: G-REFERENCE -----------------------------------------------

CREATE POLICY categories_read_all ON public.categories
  FOR SELECT
  USING (true);
--> statement-breakpoint
CREATE POLICY categories_platform_admin ON public.categories
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- category_field_schemas: G-REFERENCE -----------------------------------

CREATE POLICY category_field_schemas_read_all ON public.category_field_schemas
  FOR SELECT
  USING (true);
--> statement-breakpoint
CREATE POLICY category_field_schemas_platform_admin ON public.category_field_schemas
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- tenant_categories: T-PUBLIC-READ (enabled rows); tenant_admin write --

CREATE POLICY tenant_categories_public_read ON public.tenant_categories
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND is_enabled);
--> statement-breakpoint
CREATE POLICY tenant_categories_admin_write ON public.tenant_categories
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
CREATE POLICY tenant_categories_platform_admin ON public.tenant_categories
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ============================================================================
-- Grants
-- ============================================================================

GRANT SELECT ON public.geo_area_levels, public.category_kinds, public.schema_statuses TO ae_app;
--> statement-breakpoint
GRANT INSERT, UPDATE ON public.geo_area_levels, public.category_kinds, public.schema_statuses TO ae_app;
--> statement-breakpoint

-- No DELETE anywhere here: geo_areas retires via is_active, categories/
-- localities soft-delete, tenant_categories disables via is_enabled, and a
-- published category_field_schemas row must survive for posts to pin to.
GRANT SELECT, INSERT, UPDATE ON public.geo_areas TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.localities TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.categories TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.category_field_schemas TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.tenant_categories TO ae_app;
