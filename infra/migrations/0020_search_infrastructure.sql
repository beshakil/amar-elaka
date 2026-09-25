-- 0020_search_infrastructure
--
-- Search sync through the transactional outbox (ADR 025, schema.md §11.8).
-- Every change that alters what a search document shows writes an
-- outbox_events row in the SAME transaction as the change; the worker relays
-- it to Meilisearch (apps/api/src/search/indexing). A request never writes to
-- Meilisearch, so search being down never fails a write.
--
--   search.sync      one post/store/place changed        (aggregate = the row)
--   search.resync    a change touching many documents    (payload.scope)
--   search.settings  synonyms must be re-applied (locality names/aliases)
--
-- No new tables (so no new RLS): outbox_events (0012) already has an open
-- INSERT policy and ae_app INSERT; the trigger functions run as the invoker.
-- Also: the search settings (CLAUDE.md rule 9) and a BEFORE trigger that keeps
-- search_synced_at in step on noise-only updates (view counts), so the
-- search_synced_at safety-net sweeper doesn't re-sync every viewed post.

-- ============================================================================
-- Settings
-- ============================================================================

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('search_default_radius_km', '10', 'integer', 'km', 1, 100, 'tenant_admin',
   'Radius of a "near me" search when the client sends a location but no radius. Rural tenants may want more.'),
  ('search_max_radius_km', '50', 'integer', 'km', 1, 500, 'none',
   'Largest radius a search may ask for (and the saved-search maximum, §8.11).'),
  ('search_page_size_default', '20', 'integer', 'count', 1, 100, 'none',
   'Results per page when the client does not ask for a size.'),
  ('search_page_size_max', '50', 'integer', 'count', 1, 200, 'none',
   'Largest page a client may ask for.'),
  ('search_max_total_hits', '1000', 'integer', 'count', 100, 10000, 'none',
   'How deep search results can be paged (Meilisearch pagination.maxTotalHits).'),
  ('search_facet_values_max', '100', 'integer', 'count', 10, 1000, 'none',
   'Most values returned per facet (Meilisearch faceting.maxValuesPerFacet).'),
  ('search_suggest_limit', '8', 'integer', 'count', 1, 20, 'none',
   'Suggestions returned per as-you-type request.'),
  ('search_suggest_min_chars', '2', 'integer', 'chars', 1, 10, 'none',
   'Characters typed before suggestions are offered.'),
  ('search_typo_one_typo_min_chars', '4', 'integer', 'chars', 1, 20, 'none',
   'Word length (in Unicode code points) from which one typo is tolerated. Bengali words are short in letters but long in code points.'),
  ('search_typo_two_typos_min_chars', '8', 'integer', 'chars', 2, 30, 'none',
   'Word length (in Unicode code points) from which two typos are tolerated.'),
  ('search_outbox_max_attempts', '10', 'integer', 'count', 1, 100, 'none',
   'Failed relay attempts before a search outbox event is parked for a human to look at.');
--> statement-breakpoint

-- ============================================================================
-- Emission helper
-- ============================================================================

CREATE OR REPLACE FUNCTION public.search_enqueue(
  p_event_type text,
  p_aggregate_table text,
  p_aggregate_id uuid,
  p_payload jsonb DEFAULT '{}'
)
RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, public
AS $$
  INSERT INTO public.outbox_events (aggregate_table, aggregate_id, event_type, payload)
  VALUES (p_aggregate_table, p_aggregate_id, p_event_type, p_payload);
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.search_enqueue(text, text, uuid, jsonb) IS
  'Writes a search.* outbox event in the caller''s transaction (0020, ADR 025).';
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.search_enqueue(text, text, uuid, jsonb) TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- posts / stores / places: one search.sync per real change
-- ============================================================================

-- TG_ARGV: columns whose changes don't affect the search document ("noise").
CREATE OR REPLACE FUNCTION public.search_sync_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  noise text[] := TG_ARGV::text[];
  row_id uuid;
  row_tenant uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - noise) = (to_jsonb(OLD) - noise) THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    row_id := OLD.id;
    row_tenant := OLD.tenant_id;
  ELSE
    row_id := NEW.id;
    row_tenant := NEW.tenant_id;
  END IF;
  PERFORM public.search_enqueue('search.sync', TG_TABLE_NAME, row_id,
                                jsonb_build_object('tenant_id', row_tenant));

  -- A store takes its category and fallback location from its place. Nested,
  -- not AND-ed: PL/pgSQL may evaluate NEW.category_id even when the table
  -- test is false, and stores have no such column.
  IF TG_TABLE_NAME = 'places' THEN
    IF TG_OP <> 'UPDATE'
       OR jsonb_build_array(NEW.category_id, NEW.location, NEW.deleted_at)
          IS DISTINCT FROM jsonb_build_array(OLD.category_id, OLD.location, OLD.deleted_at) THEN
      PERFORM public.search_enqueue('search.resync', 'places', row_id,
        jsonb_build_object('scope', 'place', 'tenant_id', row_tenant, 'place_id', row_id));
    END IF;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint

-- BEFORE UPDATE: a noise-only update (view_count) of a row that was in sync
-- stays in sync, although set_updated_at() moved updated_at. Named zz_ so it
-- runs after <table>_set_updated_at (BEFORE triggers fire in name order).
CREATE OR REPLACE FUNCTION public.search_carry_synced()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  noise text[] := TG_ARGV::text[];
BEGIN
  IF (to_jsonb(NEW) - noise) = (to_jsonb(OLD) - noise)
     AND OLD.search_synced_at IS NOT NULL
     AND OLD.search_synced_at >= OLD.updated_at THEN
    NEW.search_synced_at := NEW.updated_at;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE TRIGGER posts_search_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.search_sync_row('updated_at', 'search_synced_at', 'view_count');
--> statement-breakpoint
CREATE TRIGGER posts_zz_search_carry_synced
  BEFORE UPDATE ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.search_carry_synced('updated_at', 'search_synced_at', 'view_count');
--> statement-breakpoint
CREATE TRIGGER stores_search_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.stores
  FOR EACH ROW EXECUTE FUNCTION public.search_sync_row('updated_at', 'search_synced_at');
--> statement-breakpoint
CREATE TRIGGER places_search_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.places
  FOR EACH ROW EXECUTE FUNCTION public.search_sync_row('updated_at', 'search_synced_at');
--> statement-breakpoint

-- ============================================================================
-- Things denormalised into documents
-- ============================================================================

-- Boosts: is_boosted flips when a boost starts, stops, expires or moves.
CREATE OR REPLACE FUNCTION public.search_sync_boost_target()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF OLD.post_id IS NOT NULL THEN
      PERFORM public.search_enqueue('search.sync', 'posts', OLD.post_id, jsonb_build_object('tenant_id', OLD.tenant_id));
    ELSE
      PERFORM public.search_enqueue('search.sync', 'stores', OLD.store_id, jsonb_build_object('tenant_id', OLD.tenant_id));
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE')
     AND (TG_OP = 'INSERT' OR NEW.post_id IS DISTINCT FROM OLD.post_id OR NEW.store_id IS DISTINCT FROM OLD.store_id) THEN
    IF NEW.post_id IS NOT NULL THEN
      PERFORM public.search_enqueue('search.sync', 'posts', NEW.post_id, jsonb_build_object('tenant_id', NEW.tenant_id));
    ELSE
      PERFORM public.search_enqueue('search.sync', 'stores', NEW.store_id, jsonb_build_object('tenant_id', NEW.tenant_id));
    END IF;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER boosts_search_sync
  AFTER INSERT OR DELETE OR UPDATE OF status_code, starts_at, ends_at, post_id, store_id ON public.boosts
  FOR EACH ROW EXECUTE FUNCTION public.search_sync_boost_target();
--> statement-breakpoint

-- Categories (global): names and slug are in every document of the category.
CREATE OR REPLACE FUNCTION public.search_resync_category()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.search_enqueue('search.resync', 'categories', NEW.id,
    jsonb_build_object('scope', 'category', 'category_id', NEW.id));
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER categories_search_resync
  AFTER UPDATE OF slug, name_bn, name_en, is_active, deleted_at, parent_id ON public.categories
  FOR EACH ROW
  WHEN (jsonb_build_array(NEW.slug, NEW.name_bn, NEW.name_en, NEW.is_active, NEW.deleted_at, NEW.parent_id)
        IS DISTINCT FROM
        jsonb_build_array(OLD.slug, OLD.name_bn, OLD.name_en, OLD.is_active, OLD.deleted_at, OLD.parent_id))
  EXECUTE FUNCTION public.search_resync_category();
--> statement-breakpoint

-- A tenant switching a category on or off shows or hides its posts.
CREATE OR REPLACE FUNCTION public.search_resync_tenant_category()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  r record;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM public.search_enqueue('search.resync', 'tenant_categories', r.id,
    jsonb_build_object('scope', 'tenant_category', 'tenant_id', r.tenant_id, 'category_id', r.category_id));
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER tenant_categories_search_resync
  AFTER INSERT OR DELETE OR UPDATE OF is_enabled ON public.tenant_categories
  FOR EACH ROW EXECUTE FUNCTION public.search_resync_tenant_category();
--> statement-breakpoint

-- Localities: names are in documents (area_*); names and aliases are synonyms.
CREATE OR REPLACE FUNCTION public.search_sync_locality()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND jsonb_build_array(NEW.name_bn, NEW.name_en, NEW.center, NEW.deleted_at)
         IS DISTINCT FROM jsonb_build_array(OLD.name_bn, OLD.name_en, OLD.center, OLD.deleted_at) THEN
    PERFORM public.search_enqueue('search.resync', 'localities', NEW.id,
      jsonb_build_object('scope', 'locality', 'tenant_id', NEW.tenant_id, 'locality_id', NEW.id));
  END IF;
  IF TG_OP <> 'UPDATE'
     OR jsonb_build_array(NEW.name_bn, NEW.name_en, NEW.aliases, NEW.is_active, NEW.deleted_at)
        IS DISTINCT FROM jsonb_build_array(OLD.name_bn, OLD.name_en, OLD.aliases, OLD.is_active, OLD.deleted_at) THEN
    PERFORM public.search_enqueue('search.settings', 'localities',
      CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END);
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER localities_search_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.localities
  FOR EACH ROW EXECUTE FUNCTION public.search_sync_locality();
--> statement-breakpoint

-- A member banned (or unbanned) hides (or restores) their posts and stores.
CREATE OR REPLACE FUNCTION public.search_resync_member()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.search_enqueue('search.resync', 'tenant_members', NEW.id,
    jsonb_build_object('scope', 'member', 'tenant_id', NEW.tenant_id, 'member_id', NEW.id));
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER tenant_members_search_resync
  AFTER UPDATE OF ban_severity_code ON public.tenant_members
  FOR EACH ROW
  -- Null-safe: NULL -> 'restricted' must not count as a change of the banned state.
  WHEN ((NEW.ban_severity_code IS NOT DISTINCT FROM 'banned')
        IS DISTINCT FROM (OLD.ban_severity_code IS NOT DISTINCT FROM 'banned'))
  EXECUTE FUNCTION public.search_resync_member();
--> statement-breakpoint

-- Cover photos: attaching/detaching a photo, or a photo becoming ready.
CREATE OR REPLACE FUNCTION public.search_sync_attachment_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  r record;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  IF r.post_id IS NOT NULL THEN
    PERFORM public.search_enqueue('search.sync', 'posts', r.post_id, jsonb_build_object('tenant_id', r.tenant_id));
  ELSIF r.place_id IS NOT NULL THEN
    PERFORM public.search_enqueue('search.sync', 'places', r.place_id, jsonb_build_object('tenant_id', r.tenant_id));
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER media_attachments_search_sync
  AFTER INSERT OR DELETE OR UPDATE OF sort_order, media_asset_id ON public.media_attachments
  FOR EACH ROW EXECUTE FUNCTION public.search_sync_attachment_owner();
--> statement-breakpoint

-- SECURITY DEFINER (owned by ae_rls_bypass, 0009/0012 precedent): whoever
-- changes the photo, every post, place and store showing it must be re-synced,
-- including ones the invoker's policies don't let them see. It reads ids only
-- and writes nothing but outbox events.
CREATE OR REPLACE FUNCTION public.search_sync_media_owners()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner record;
BEGIN
  FOR owner IN
    SELECT 'posts' AS t, a.post_id AS id FROM public.media_attachments a
    WHERE a.tenant_id = NEW.tenant_id AND a.media_asset_id = NEW.id AND a.post_id IS NOT NULL
    UNION
    SELECT 'places', a.place_id FROM public.media_attachments a
    WHERE a.tenant_id = NEW.tenant_id AND a.media_asset_id = NEW.id AND a.place_id IS NOT NULL
    UNION
    SELECT 'stores', s.id FROM public.stores s
    WHERE s.tenant_id = NEW.tenant_id AND (s.logo_media_id = NEW.id OR s.cover_media_id = NEW.id)
  LOOP
    PERFORM public.search_enqueue('search.sync', owner.t, owner.id, jsonb_build_object('tenant_id', NEW.tenant_id));
  END LOOP;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.search_sync_media_owners() OWNER TO ae_rls_bypass;
--> statement-breakpoint
-- media_attachments and stores: SELECT already granted to ae_rls_bypass (0012).
GRANT INSERT ON public.outbox_events TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.search_enqueue(text, text, uuid, jsonb) TO ae_rls_bypass;
--> statement-breakpoint
CREATE TRIGGER media_assets_search_sync
  AFTER UPDATE OF status_code, deleted_at, variants, thumbhash ON public.media_assets
  FOR EACH ROW
  WHEN (jsonb_build_array(NEW.status_code, NEW.deleted_at, NEW.variants, NEW.thumbhash)
        IS DISTINCT FROM jsonb_build_array(OLD.status_code, OLD.deleted_at, OLD.variants, OLD.thumbhash))
  EXECUTE FUNCTION public.search_sync_media_owners();
