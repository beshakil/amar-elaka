-- 0018_category_versioning
--
-- Category engine, part 2 (docs/specs/categories.md §3.6, §6):
--
--   1. monetization_mode_code becomes a real column. categories.md used to
--      keep it as informational metadata only; platform admins now manage it
--      through the category CRUD, so it needs to be stored and constrained.
--   2. Field-schema versioning. A published version stays immutable (posts
--      pin to it), but it may move to `retired` when its successor is
--      published: the one change 0004's trigger didn't allow, which made a
--      second version impossible to publish. Retired versions are immutable
--      too, so old posts always render against exactly what they were
--      written with.
--   3. At most one draft per category, the version being edited.
--   4. authored_definition keeps what the admin wrote (own fields, before
--      parent fields are merged in). json_schema/ui_schema hold the
--      flattened result posts validate against; the authored form is what
--      lets a child be re-flattened when its parent publishes a new version.

-- ============================================================================
-- monetization_modes: enum table (§0.3)
-- ============================================================================

CREATE TABLE public.monetization_modes (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT monetization_modes_pk PRIMARY KEY (code),
  CONSTRAINT monetization_modes_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER monetization_modes_set_updated_at BEFORE UPDATE ON public.monetization_modes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.monetization_modes (code, label_key, sort_order) VALUES
  ('per_listing',  'enum.monetization_modes.per_listing',  10),
  ('boost',        'enum.monetization_modes.boost',        20),
  ('subscription', 'enum.monetization_modes.subscription', 30),
  ('lead_fee',     'enum.monetization_modes.lead_fee',     40),
  ('free',         'enum.monetization_modes.free',         50);
--> statement-breakpoint
ALTER TABLE public.monetization_modes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.monetization_modes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY monetization_modes_read_all ON public.monetization_modes
  FOR SELECT
  USING (true);
--> statement-breakpoint
CREATE POLICY monetization_modes_platform_admin ON public.monetization_modes
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.monetization_modes TO ae_app;
--> statement-breakpoint

ALTER TABLE public.categories
  ADD COLUMN monetization_mode_code text NOT NULL DEFAULT 'free',
  ADD CONSTRAINT categories_monetization_mode_code_fk FOREIGN KEY (monetization_mode_code)
    REFERENCES public.monetization_modes (code) ON DELETE RESTRICT;
--> statement-breakpoint
-- FK index (§0.4).
CREATE INDEX categories_monetization_mode_code_idx ON public.categories (monetization_mode_code);
--> statement-breakpoint

-- ============================================================================
-- category_field_schemas: authored definition, one draft, retire-on-publish
-- ============================================================================

ALTER TABLE public.category_field_schemas
  ADD COLUMN authored_definition jsonb NOT NULL DEFAULT '{}',
  ADD CONSTRAINT category_field_schemas_authored_definition_ck
    CHECK (jsonb_typeof(authored_definition) = 'object');
--> statement-breakpoint
-- 0004 tied published_at to status = 'published'; a retired version keeps
-- the time it was published, so the rule becomes "set once it has left draft".
ALTER TABLE public.category_field_schemas
  DROP CONSTRAINT category_field_schemas_published_at_ck,
  ADD CONSTRAINT category_field_schemas_published_at_ck
    CHECK ((status_code = 'draft') = (published_at IS NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX category_field_schemas_draft_uq ON public.category_field_schemas (category_id)
  WHERE status_code = 'draft';
--> statement-breakpoint

-- Replaces 0004's version. Published and retired rows are immutable, with
-- two exceptions that change nothing a post depends on:
--   - published -> retired, everything else unchanged (a successor was published);
--   - published_by_user_id -> NULL, so the FK's ON DELETE SET NULL still works.
CREATE OR REPLACE FUNCTION public.category_field_schemas_prevent_published_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status_code NOT IN ('published', 'retired') THEN
    RETURN NEW;
  END IF;

  IF (NEW.category_id, NEW.version, NEW.json_schema, NEW.ui_schema, NEW.filterable_fields,
      NEW.searchable_fields, NEW.analytics_fields, NEW.authored_definition, NEW.published_at)
     IS DISTINCT FROM
     (OLD.category_id, OLD.version, OLD.json_schema, OLD.ui_schema, OLD.filterable_fields,
      OLD.searchable_fields, OLD.analytics_fields, OLD.authored_definition, OLD.published_at)
     OR (NEW.published_by_user_id IS DISTINCT FROM OLD.published_by_user_id
         AND NEW.published_by_user_id IS NOT NULL)
  THEN
    RAISE EXCEPTION 'category_field_schemas: a % schema is immutable (category %, version %)',
      OLD.status_code, OLD.category_id, OLD.version
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.status_code IS DISTINCT FROM OLD.status_code
     AND NOT (OLD.status_code = 'published' AND NEW.status_code = 'retired')
  THEN
    RAISE EXCEPTION 'category_field_schemas: % -> % is not allowed (category %, version %)',
      OLD.status_code, NEW.status_code, OLD.category_id, OLD.version
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- Discarding a draft deletes it. Nothing else is ever deleted by the app:
-- this RESTRICTIVE policy is ANDed with category_field_schemas_platform_admin
-- (0004), so even a platform admin can only delete a draft. A version a post
-- pins is protected regardless by posts.field_schema_id ON DELETE RESTRICT.
CREATE POLICY category_field_schemas_delete_drafts_only ON public.category_field_schemas
  AS RESTRICTIVE
  FOR DELETE
  USING (status_code = 'draft');
--> statement-breakpoint
GRANT DELETE ON public.category_field_schemas TO ae_app;
