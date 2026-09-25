-- 0017_category_engine
--
-- Category engine (docs/specs/categories.md §6, changes C1, C2, C3, C7).
-- No column is dropped or renamed; every change is additive.
--
--   C1  Per-category post expiry: categories.default_post_expiry_days and a
--       per-tenant override, tenant_categories.post_expiry_days. The post
--       service resolves a post's TTL as tenant override -> category default
--       -> the post_expiry_days_default setting. Places and module-backed
--       categories never expire, so both columns must stay NULL for them.
--   C2  A `module` category kind for home tiles backed by their own tables
--       (emergency contacts, blood donors, bazar prices). They live in
--       categories/tenant_categories so a tenant enables and orders every
--       tile in one place, but posts, places and field schemas reject them.
--   C3  category_field_schemas.searchable_fields: the full-text search
--       attributes, next to filterable_fields. List-card order is
--       presentation and lives in ui_schema.
--   C7  place_reverify_after_days setting for the agent re-verification
--       worklist (CLAUDE.md rule 9: registry entry ships in the same change).
--
-- New table category_modules is an enum table: RLS, policies and grants
-- follow 0004's enum tables exactly.

-- ============================================================================
-- category_modules: enum table (§0.3)
-- ============================================================================

CREATE TABLE public.category_modules (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT category_modules_pk PRIMARY KEY (code),
  CONSTRAINT category_modules_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER category_modules_set_updated_at BEFORE UPDATE ON public.category_modules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.category_modules (code, label_key, sort_order) VALUES
  ('emergency', 'enum.category_modules.emergency', 10),
  ('blood',     'enum.category_modules.blood',     20),
  ('bazar',     'enum.category_modules.bazar',     30);
--> statement-breakpoint
ALTER TABLE public.category_modules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.category_modules FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY category_modules_read_all ON public.category_modules
  FOR SELECT
  USING (true);
--> statement-breakpoint
CREATE POLICY category_modules_platform_admin ON public.category_modules
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.category_modules TO ae_app;
--> statement-breakpoint

INSERT INTO public.category_kinds (code, label_key, sort_order) VALUES
  ('module', 'enum.category_kinds.module', 60);
--> statement-breakpoint

-- ============================================================================
-- categories: module_code (C2) and default_post_expiry_days (C1)
-- ============================================================================

ALTER TABLE public.categories
  ADD COLUMN module_code text,
  ADD COLUMN default_post_expiry_days integer,
  ADD CONSTRAINT categories_module_code_fk FOREIGN KEY (module_code)
    REFERENCES public.category_modules (code) ON DELETE RESTRICT,
  -- A module tile names its module; nothing else does.
  ADD CONSTRAINT categories_module_code_ck
    CHECK ((kind_code = 'module') = (module_code IS NOT NULL)),
  -- A module tile is a single home tile: no children, no posting price.
  ADD CONSTRAINT categories_module_shape_ck
    CHECK (kind_code <> 'module' OR (parent_id IS NULL AND default_post_cost_credits = 0)),
  ADD CONSTRAINT categories_default_post_expiry_days_ck
    CHECK (default_post_expiry_days IS NULL OR default_post_expiry_days > 0),
  -- Places and modules have no posts, so nothing to expire.
  ADD CONSTRAINT categories_expiry_kind_ck
    CHECK (default_post_expiry_days IS NULL OR kind_code NOT IN ('place', 'module'));
--> statement-breakpoint
-- One tile per module; also the FK index (§0.4).
CREATE UNIQUE INDEX categories_module_code_uq ON public.categories (module_code)
  WHERE module_code IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint

-- ============================================================================
-- tenant_categories: post_expiry_days override (C1)
-- ============================================================================

ALTER TABLE public.tenant_categories
  ADD COLUMN post_expiry_days integer,
  ADD CONSTRAINT tenant_categories_post_expiry_days_ck
    CHECK (post_expiry_days IS NULL OR post_expiry_days > 0);
--> statement-breakpoint

-- Posting overrides only make sense for categories that take posts.
CREATE OR REPLACE FUNCTION public.tenant_categories_validate_post_overrides()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  category_kind text;
BEGIN
  IF NEW.post_expiry_days IS NULL AND NEW.post_cost_credits IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT kind_code INTO category_kind FROM public.categories WHERE id = NEW.category_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_categories.category_id % does not exist', NEW.category_id;
  END IF;

  IF category_kind IN ('place', 'module') THEN
    RAISE EXCEPTION 'tenant_categories: category % (%) takes no posts, so it has no post cost or expiry',
      NEW.category_id, category_kind
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER tenant_categories_b_validate_post_overrides
  BEFORE INSERT OR UPDATE OF post_expiry_days, post_cost_credits, category_id ON public.tenant_categories
  FOR EACH ROW EXECUTE FUNCTION public.tenant_categories_validate_post_overrides();
--> statement-breakpoint

-- ============================================================================
-- category_field_schemas: searchable_fields (C3); no schema for a module
-- ============================================================================

ALTER TABLE public.category_field_schemas
  ADD COLUMN searchable_fields text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint

-- A module tile's fields are its tables' own columns (categories.md §3.1).
CREATE OR REPLACE FUNCTION public.category_field_schemas_reject_module_category()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  category_kind text;
BEGIN
  SELECT kind_code INTO category_kind FROM public.categories WHERE id = NEW.category_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'category_field_schemas.category_id % does not exist', NEW.category_id;
  END IF;
  IF category_kind = 'module' THEN
    RAISE EXCEPTION 'category_field_schemas: category % is a module tile and has no custom-field schema',
      NEW.category_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER category_field_schemas_b_reject_module_category
  BEFORE INSERT OR UPDATE OF category_id ON public.category_field_schemas
  FOR EACH ROW EXECUTE FUNCTION public.category_field_schemas_reject_module_category();
--> statement-breakpoint

-- Changing a category's kind to `module` would strand its field schemas and
-- tenant overrides; allow it only while it has neither.
CREATE OR REPLACE FUNCTION public.categories_validate_module_kind_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.kind_code = 'module' AND OLD.kind_code <> 'module' AND (
    EXISTS (SELECT 1 FROM public.category_field_schemas WHERE category_id = NEW.id)
    OR EXISTS (SELECT 1 FROM public.categories WHERE parent_id = NEW.id)
  ) THEN
    RAISE EXCEPTION 'category % has field schemas or children and cannot become a module tile', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER categories_b_validate_module_kind_change
  BEFORE UPDATE OF kind_code ON public.categories
  FOR EACH ROW EXECUTE FUNCTION public.categories_validate_module_kind_change();
--> statement-breakpoint

-- ============================================================================
-- posts: reject module-kind categories as well as place-kind (C2)
-- ============================================================================
-- places_validate_category() (0005) already requires kind = 'place', so it
-- rejects module tiles without a change.

CREATE OR REPLACE FUNCTION public.posts_validate_category_and_schema()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  category_kind text;
  schema_category_id uuid;
BEGIN
  SELECT kind_code INTO category_kind FROM public.categories WHERE id = NEW.category_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'posts.category_id % does not exist', NEW.category_id;
  END IF;
  IF category_kind IN ('place', 'module') THEN
    RAISE EXCEPTION 'posts.category_id % is a %-kind category; posts cannot use it', NEW.category_id, category_kind
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT category_id INTO schema_category_id
  FROM public.category_field_schemas WHERE id = NEW.field_schema_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'posts.field_schema_id % does not exist', NEW.field_schema_id;
  END IF;
  IF schema_category_id <> NEW.category_id THEN
    RAISE EXCEPTION 'posts.field_schema_id % does not belong to category %', NEW.field_schema_id, NEW.category_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- ============================================================================
-- Settings (C7)
-- ============================================================================

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('place_reverify_after_days', '180', 'integer', 'days', 30, 1095, 'tenant_admin',
   'A place not field-verified for this long goes on the agent re-verification worklist.');
