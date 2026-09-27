-- 0030_feed
--
-- The home / category feed (ADR 035): GET /api/v1/feed.
--
--   categories.is_shippable       the `country` scope shows only these
--                                 (fashion, gadgets…): no radius, they ship.
--   posts.photo_count             attached photos, kept by a trigger on
--                                 media_attachments; with filled_field_count
--                                 it makes "completeness" a column read, not
--                                 a per-row join, when 50k posts are scored.
--   posts.filled_field_count      stored generated: non-empty keys of fields.
--   post_field_filter_matches()   the dynamic field filters as data (jsonb),
--                                 same semantics as post-field-filters.ts.
--   feed_posts()                  ranked page of post ids (score, keyset).
--   feed_stores()                 nearest active stores (keyset).
--   feed_landmarks()              landmark places whose own radius reaches
--                                 the viewer, whichever tenant owns them.
--
-- The three feed_* functions follow discover_nearby (0023): SECURITY DEFINER
-- owned by ae_rls_bypass, return ids (plus score/distance) only, clamp radius
-- and page size by platform settings; callers read card details in each
-- owning tenant's context, so no public-read policy changes.
--
-- Tests: apps/api/test/feed.db-spec.ts.

-- ============================================================================
-- categories.is_shippable
-- ============================================================================

ALTER TABLE public.categories
  ADD COLUMN is_shippable boolean NOT NULL DEFAULT false;
--> statement-breakpoint
COMMENT ON COLUMN public.categories.is_shippable IS
  'Items that can be sent by courier (fashion, gadgets): the only categories of the country-wide feed.';
--> statement-breakpoint

-- ============================================================================
-- posts.photo_count, posts.filled_field_count
-- ============================================================================

CREATE OR REPLACE FUNCTION public.jsonb_filled_key_count(doc jsonb)
RETURNS smallint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT count(*)::smallint
  FROM jsonb_each(doc) e
  WHERE e.value NOT IN ('null'::jsonb, '""'::jsonb, '[]'::jsonb, '{}'::jsonb)
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.jsonb_filled_key_count(jsonb) IS
  'Keys of a JSON object whose value is not null, "", [] or {}. Feeds posts.filled_field_count.';
--> statement-breakpoint

-- filled_field_count is a plain column set by a BEFORE trigger, not a
-- STORED generated one: BEFORE triggers see generated columns as NULL in
-- NEW, which would make posts_zz_search_carry_synced (0020, it compares the
-- whole row) treat every update as a real edit. posts_a_* fires before it.
ALTER TABLE public.posts
  ADD COLUMN photo_count smallint NOT NULL DEFAULT 0,
  ADD COLUMN filled_field_count smallint NOT NULL DEFAULT 0,
  ADD CONSTRAINT posts_photo_count_ck CHECK (photo_count >= 0);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.posts_maintain_filled_field_count()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.filled_field_count := public.jsonb_filled_key_count(NEW.fields);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER posts_a_maintain_filled_field_count
  BEFORE INSERT OR UPDATE OF fields ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.posts_maintain_filled_field_count();
--> statement-breakpoint

-- Backfill without touching updated_at or the search outbox: neither column
-- is in a search document, so no row goes out of sync.
ALTER TABLE public.posts DISABLE TRIGGER posts_set_updated_at;
--> statement-breakpoint
ALTER TABLE public.posts DISABLE TRIGGER posts_search_sync;
--> statement-breakpoint
ALTER TABLE public.posts DISABLE TRIGGER posts_zz_search_carry_synced;
--> statement-breakpoint
UPDATE public.posts p
SET photo_count = (
      SELECT count(*) FROM public.media_attachments a
      WHERE a.tenant_id = p.tenant_id AND a.post_id = p.id
    ),
    filled_field_count = public.jsonb_filled_key_count(p.fields);
--> statement-breakpoint
ALTER TABLE public.posts ENABLE TRIGGER posts_set_updated_at;
--> statement-breakpoint
ALTER TABLE public.posts ENABLE TRIGGER posts_search_sync;
--> statement-breakpoint
ALTER TABLE public.posts ENABLE TRIGGER posts_zz_search_carry_synced;
--> statement-breakpoint

-- SECURITY DEFINER: whoever attaches or detaches (author, moderator, scrub,
-- draft cleanup), the count must follow, even where the invoker's policies
-- would make the UPDATE match nothing. It writes photo_count only.
CREATE OR REPLACE FUNCTION public.posts_recount_photos(p_tenant_id uuid, p_post_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.posts p
  SET photo_count = (
    SELECT count(*) FROM public.media_attachments a
    WHERE a.tenant_id = p_tenant_id AND a.post_id = p_post_id
  )
  WHERE p.tenant_id = p_tenant_id AND p.id = p_post_id
$$;
--> statement-breakpoint
ALTER FUNCTION public.posts_recount_photos(uuid, uuid) OWNER TO ae_rls_bypass;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.posts_recount_photos(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.posts_maintain_photo_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Nested, not AND-ed: NEW is NULL on DELETE and OLD on INSERT.
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF NEW.post_id IS NOT NULL THEN
      PERFORM public.posts_recount_photos(NEW.tenant_id, NEW.post_id);
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.post_id IS NOT NULL THEN
      PERFORM public.posts_recount_photos(OLD.tenant_id, OLD.post_id);
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.post_id IS NOT NULL AND OLD.post_id IS DISTINCT FROM NEW.post_id THEN
      PERFORM public.posts_recount_photos(OLD.tenant_id, OLD.post_id);
    END IF;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.posts_maintain_photo_count() OWNER TO ae_rls_bypass;
--> statement-breakpoint
CREATE TRIGGER media_attachments_post_photo_count
  AFTER INSERT OR DELETE OR UPDATE OF post_id ON public.media_attachments
  FOR EACH ROW EXECUTE FUNCTION public.posts_maintain_photo_count();
--> statement-breakpoint

-- ============================================================================
-- Indexes
-- ============================================================================

-- Category feed within a radius, and the country feed's shippable
-- categories: category equality + distance in one GiST (btree_gist, 0000).
-- posts_location_gist_idx (0005) still serves the all-categories feed.
CREATE INDEX posts_live_category_location_gist_idx
  ON public.posts USING gist (category_id, location)
  WHERE status_code = 'live' AND deleted_at IS NULL AND NOT hidden_by_owner;
--> statement-breakpoint

-- ============================================================================
-- post_field_filter_matches
-- ============================================================================

-- One parsed filter (FieldFilter in categories/field-schema/field-filter.ts,
-- serialised as JSON) against a post's fields. Mirrors post-field-filters.ts:
-- the generated columns' keys cast directly (the column already proved the
-- cast works), every other comparison is guarded by the stored JSON type so
-- an older schema version's value never makes a cast fail; it just doesn't
-- match. NULL (no match) for an unknown kind or operator.
CREATE OR REPLACE FUNCTION public.post_field_filter_matches(doc jsonb, f jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE f ->> 'kind'
    WHEN 'equals' THEN
      doc @> jsonb_build_object(f ->> 'field', f -> 'value')
    WHEN 'one_of' THEN EXISTS (
      SELECT 1 FROM jsonb_array_elements(f -> 'values') v (value)
      WHERE doc @> jsonb_build_object(
        f ->> 'field',
        CASE WHEN (f ->> 'multiselect')::boolean THEN jsonb_build_array(v.value) ELSE v.value END))
    WHEN 'date' THEN (
      SELECT CASE f ->> 'op'
        WHEN 'eq' THEN x = f ->> 'value' WHEN 'gte' THEN x >= f ->> 'value'
        WHEN 'lte' THEN x <= f ->> 'value' WHEN 'gt' THEN x > f ->> 'value'
        WHEN 'lt' THEN x < f ->> 'value' END
      FROM (SELECT CASE WHEN doc ->> (f ->> 'field') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                        THEN doc ->> (f ->> 'field') END) s (x))
    WHEN 'number' THEN (
      SELECT CASE f ->> 'op'
        WHEN 'eq' THEN x = (f ->> 'value')::numeric WHEN 'gte' THEN x >= (f ->> 'value')::numeric
        WHEN 'lte' THEN x <= (f ->> 'value')::numeric WHEN 'gt' THEN x > (f ->> 'value')::numeric
        WHEN 'lt' THEN x < (f ->> 'value')::numeric END
      FROM (SELECT CASE
              WHEN f ->> 'field' IN ('price', 'bedrooms', 'seats', 'area') THEN (doc ->> (f ->> 'field'))::numeric
              WHEN jsonb_typeof(doc -> (f ->> 'field')) = 'number' THEN (doc ->> (f ->> 'field'))::numeric
            END) s (x))
    WHEN 'money' THEN (
      SELECT CASE f ->> 'op'
        WHEN 'eq' THEN x = (f ->> 'value')::numeric WHEN 'gte' THEN x >= (f ->> 'value')::numeric
        WHEN 'lte' THEN x <= (f ->> 'value')::numeric WHEN 'gt' THEN x > (f ->> 'value')::numeric
        WHEN 'lt' THEN x < (f ->> 'value')::numeric END
      FROM (SELECT CASE
              WHEN f ->> 'field' IN ('price', 'bedrooms', 'seats', 'area') THEN (doc ->> (f ->> 'field'))::numeric
              WHEN doc ->> (f ->> 'field') ~ '^[0-9]{1,10}\.[0-9]{2}$' THEN (doc ->> (f ->> 'field'))::numeric
            END) s (x))
  END
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.post_field_filter_matches(jsonb, jsonb) IS
  'One parsed category field filter (JSON) against posts.fields; same rules as apps/api/src/categories/post-field-filters.ts.';
--> statement-breakpoint

-- ============================================================================
-- feed_posts
-- ============================================================================

-- p_rank carries the ranking parameters the API read from SettingsService
-- (all required): w_distance, w_recency, w_boost, w_trust, w_completeness,
-- distance_half_km, recency_half_life_hours, photo_target, trust_default.
--
-- score = w_distance     * 0.5 ^ (distance_km / distance_half_km)
--       + w_recency      * 0.5 ^ (age_hours / recency_half_life_hours)
--       + w_boost        * (1 if boosted within the slot cap, else 0)
--       + w_trust        * poster trust / 100
--       + w_completeness * (min(photos, photo_target) / photo_target
--                           + filled fields / schema fields) / 2
--
-- age and boost windows are measured at p_as_of, never now(): the cursor
-- carries it, so every page of one scroll scores with the same clock and
-- (score, id) stays a strict total order. Posts published or bumped after
-- p_as_of are left out until the viewer refreshes.
--
-- Boost cap: active boosts of p_boost_placement, per owning tenant +
-- category, earliest start first; only the first boost_slots_per_category
-- (owning tenant's override, else platform) count. More boosts than slots
-- (bought before a slot cut, or a race at purchase) rank as organic.
--
-- p_radius_km NULL = no radius, allowed only with p_shippable_only.
--
-- Distances (radius test, proximity, distance_m) are on the mean-Earth
-- sphere (use_spheroid = false, as in feed_stores / feed_landmarks): within
-- 0.3% of WGS84 across Bangladesh and several times cheaper per row.
CREATE OR REPLACE FUNCTION public.feed_posts(
  p_origin geography,
  p_radius_km double precision,
  p_category_ids uuid[],
  p_shippable_only boolean,
  p_field_filters jsonb,
  p_boost_placement text,
  p_rank jsonb,
  p_as_of timestamptz,
  p_after_score double precision,
  p_after_id uuid,
  p_limit integer
)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  score double precision,
  distance_m double precision,
  is_boosted boolean,
  is_highlighted boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
-- Plan with the real arguments every call: a cached generic plan can't drop
-- the `x IS NULL OR …` branches and loses the GiST index (ADR 035).
SET plan_cache_mode = force_custom_plan
AS $$
#variable_conflict use_column
DECLARE
  max_radius_km double precision;
  max_page_size integer;
  slots_default integer;
  radius_m double precision;
  as_of timestamptz;
  w_distance double precision := (p_rank ->> 'w_distance')::double precision;
  w_recency double precision := (p_rank ->> 'w_recency')::double precision;
  w_boost double precision := (p_rank ->> 'w_boost')::double precision;
  w_trust double precision := (p_rank ->> 'w_trust')::double precision;
  w_completeness double precision := (p_rank ->> 'w_completeness')::double precision;
  distance_half_m double precision := (p_rank ->> 'distance_half_km')::double precision * 1000;
  recency_half_life_s double precision := (p_rank ->> 'recency_half_life_hours')::double precision * 3600;
  photo_target double precision := (p_rank ->> 'photo_target')::double precision;
  trust_default double precision := (p_rank ->> 'trust_default')::double precision;
  page_size integer;
  boosted_ids uuid[];
  highlighted_ids uuid[];
  schema_fields jsonb;
BEGIN
  IF p_origin IS NULL OR p_as_of IS NULL OR p_limit IS NULL OR p_limit <= 0 THEN
    RAISE EXCEPTION 'feed_posts needs an origin, as_of and a positive limit'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_radius_km IS NULL AND NOT coalesce(p_shippable_only, false) THEN
    RAISE EXCEPTION 'feed_posts without a radius is only for shippable categories'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_radius_km IS NOT NULL AND p_radius_km <= 0 THEN
    RAISE EXCEPTION 'feed_posts needs a positive radius' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (p_after_score IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'feed_posts cursor needs both score and id' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- coalesce(..., false): a missing key makes the comparison NULL, and that
  -- must fail too. Weights must be >= 0 for the trust bound below to hold.
  IF NOT coalesce(w_distance >= 0 AND w_recency >= 0 AND w_boost >= 0 AND w_trust >= 0
                  AND w_completeness >= 0 AND trust_default BETWEEN 0 AND 100
                  AND distance_half_m > 0 AND recency_half_life_s > 0 AND photo_target > 0, false) THEN
    RAISE EXCEPTION 'feed_posts ranking parameters are missing or out of range'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT (ps.value #>> '{}')::double precision INTO max_radius_km
  FROM public.platform_settings ps WHERE ps.key = 'feed_max_radius_km';
  SELECT (ps.value #>> '{}')::integer INTO max_page_size
  FROM public.platform_settings ps WHERE ps.key = 'feed_page_size_max';
  SELECT (ps.value #>> '{}')::integer INTO slots_default
  FROM public.platform_settings ps WHERE ps.key = 'boost_slots_per_category';
  IF max_radius_km IS NULL OR max_page_size IS NULL OR slots_default IS NULL THEN
    RAISE EXCEPTION 'platform settings feed_max_radius_km / feed_page_size_max / boost_slots_per_category are missing';
  END IF;

  -- least() skips NULLs: no radius must stay no radius.
  radius_m := CASE WHEN p_radius_km IS NOT NULL THEN least(p_radius_km, max_radius_km) * 1000 END;
  -- A cursor can't move the clock forward.
  as_of := least(p_as_of, now());
  page_size := least(p_limit, max_page_size);

  -- 1. The small sets, into variables, so the per-post pass below has no
  --    joins whose row estimates could go wrong (PostGIS estimates the
  --    st_dwithin filter at a handful of rows, whatever the radius).
  SELECT coalesce(array_agg(ranked.post_id), '{}')
    INTO boosted_ids
  FROM (
    SELECT b.tenant_id, b.post_id,
           row_number() OVER (PARTITION BY b.tenant_id, bp.category_id ORDER BY b.starts_at, b.id) AS slot
    FROM public.boosts b
    JOIN public.boost_types bt ON bt.id = b.boost_type_id
    JOIN public.posts bp ON bp.tenant_id = b.tenant_id AND bp.id = b.post_id
    WHERE b.status_code = 'active' AND b.post_id IS NOT NULL
      AND b.starts_at <= as_of AND b.ends_at > as_of
      AND bt.placement_code = p_boost_placement
      AND bp.status_code = 'live' AND bp.deleted_at IS NULL AND NOT bp.hidden_by_owner
  ) ranked
  LEFT JOIN public.tenant_settings ts ON ts.tenant_id = ranked.tenant_id
  WHERE ranked.slot <= coalesce((ts.setting_overrides ->> 'boost_slots_per_category')::integer, slots_default);

  SELECT coalesce(array_agg(DISTINCT b.post_id), '{}')
    INTO highlighted_ids
  FROM public.boosts b
  JOIN public.boost_types bt ON bt.id = b.boost_type_id
  WHERE b.status_code = 'active' AND b.post_id IS NOT NULL
    AND b.starts_at <= as_of AND b.ends_at > as_of
    AND bt.placement_code = 'highlight';

  SELECT coalesce(jsonb_object_agg(s.id::text, (
           SELECT count(*) FROM jsonb_object_keys(
             CASE WHEN jsonb_typeof(s.json_schema -> 'properties') = 'object'
                  THEN s.json_schema -> 'properties' ELSE '{}'::jsonb END))), '{}')
    INTO schema_fields
  FROM public.category_field_schemas s
  WHERE p_category_ids IS NULL OR s.category_id = ANY (p_category_ids);

  -- 2. One pass over the posts in scope: every term but trust (`base`).
  -- 3. Trust adds w_trust * t/100 with t in [0, 100], so score is in
  --    [base, base + w_trust]. B = the page_size-th best base among rows
  --    surely past the cursor (base + w_trust < cursor): at least page_size
  --    rows score >= B, so a row with base + w_trust < B can't make the page
  --    and never pays for its trust lookup. Exact, not approximate.
  RETURN QUERY
    WITH base AS MATERIALIZED (
      SELECT p.id, p.tenant_id, p.author_member_id, d.distance_m,
             d.is_boosted,
             p.id = ANY (highlighted_ids) AS is_highlighted,
             -- Exponents capped so a far or old post decays to ~0 instead of
             -- raising a float underflow.
             ( w_distance * coalesce(power(0.5::double precision,
                                          least(d.distance_m / distance_half_m, 1000)), 0)
             + w_recency * power(0.5::double precision,
                                 least(greatest(d.age_s, 0) / recency_half_life_s, 1000))
             + w_boost * d.is_boosted::integer
             + w_completeness * (
                 least(p.photo_count, photo_target) / photo_target
                 + CASE WHEN d.schema_fields > 0
                        THEN least(p.filled_field_count, d.schema_fields) / d.schema_fields
                        ELSE 1 END
               ) / 2
             )::double precision AS base_score
      FROM public.posts p
      CROSS JOIN LATERAL (
        SELECT st_distance(p.location, p_origin, false) AS distance_m,
               extract(epoch FROM as_of - coalesce(p.bumped_at, p.published_at))::double precision AS age_s,
               p.id = ANY (boosted_ids) AS is_boosted,
               coalesce((schema_fields ->> p.field_schema_id::text)::double precision, 0) AS schema_fields
      ) d
      -- Matches the live-post partial indexes' predicate.
      WHERE p.status_code = 'live' AND p.deleted_at IS NULL AND NOT p.hidden_by_owner
        AND coalesce(p.bumped_at, p.published_at) <= as_of
        AND (p.expires_at IS NULL OR p.expires_at > as_of)
        AND (radius_m IS NULL OR st_dwithin(p.location, p_origin, radius_m, false))
        AND (p_category_ids IS NULL OR p.category_id = ANY (p_category_ids))
        AND (NOT coalesce(p_shippable_only, false) OR p.category_id IN (
              SELECT c.id FROM public.categories c WHERE c.is_shippable AND c.deleted_at IS NULL))
        AND (p_field_filters IS NULL OR NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(p_field_filters) f (value)
              WHERE NOT coalesce(public.post_field_filter_matches(p.fields, f.value), false)))
    ),
    eligible AS MATERIALIZED (
      -- score >= base, so a row with base > cursor was on an earlier page.
      SELECT b.* FROM base b WHERE p_after_score IS NULL OR b.base_score <= p_after_score
    ),
    bound AS MATERIALIZED (
      SELECT min(t.base_score) AS b, count(*) AS n
      FROM (
        SELECT e.base_score FROM eligible e
        WHERE p_after_score IS NULL OR e.base_score + w_trust < p_after_score
        ORDER BY e.base_score DESC
        LIMIT page_size
      ) t
    ),
    -- MATERIALIZED so the cursor test below isn't pushed under the bound and
    -- run (with its trust lookup) on every eligible row.
    scored AS MATERIALIZED (
      SELECT e.id, e.tenant_id, e.distance_m, e.is_boosted, e.is_highlighted,
             (e.base_score + w_trust * (coalesce(
                (SELECT coalesce(m.override_score, m.score)::double precision
                 FROM public.member_trust_scores m
                 WHERE m.tenant_id = e.tenant_id AND m.member_id = e.author_member_id),
                trust_default) / 100::double precision))::double precision AS score
      FROM eligible e
      CROSS JOIN bound
      WHERE bound.n < page_size OR e.base_score + w_trust >= bound.b
    )
    SELECT s.id, s.tenant_id, s.score, s.distance_m, s.is_boosted, s.is_highlighted
    FROM scored s
    WHERE p_after_score IS NULL OR (s.score, s.id) < (p_after_score, p_after_id)
    ORDER BY s.score DESC, s.id DESC
    LIMIT page_size;
END
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.feed_posts(geography, double precision, uuid[], boolean, jsonb, text, jsonb, timestamptz, double precision, uuid, integer) IS
  'Ranked feed page (ADR 035): ids of live posts within the radius (or shippable ones country-wide), highest score first, keyset on (score, id). Boosts count only within boost_slots_per_category. SECURITY DEFINER: ids and scores only.';
--> statement-breakpoint
ALTER FUNCTION public.feed_posts(geography, double precision, uuid[], boolean, jsonb, text, jsonb, timestamptz, double precision, uuid, integer)
  OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.feed_posts(geography, double precision, uuid[], boolean, jsonb, text, jsonb, timestamptz, double precision, uuid, integer)
TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- feed_stores
-- ============================================================================

-- Active stores within the radius, nearest first, keyset on (distance, id).
CREATE OR REPLACE FUNCTION public.feed_stores(
  p_origin geography,
  p_radius_km double precision,
  p_after_distance double precision,
  p_after_id uuid,
  p_limit integer
)
RETURNS TABLE (id uuid, tenant_id uuid, distance_m double precision)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
-- Plan with the real arguments every call: a cached generic plan can't drop
-- the `x IS NULL OR …` branches and loses the GiST index (ADR 035).
SET plan_cache_mode = force_custom_plan
AS $$
#variable_conflict use_column
DECLARE
  max_radius_km double precision;
  max_page_size integer;
BEGIN
  IF p_origin IS NULL OR p_radius_km IS NULL OR p_radius_km <= 0 OR p_limit IS NULL OR p_limit <= 0 THEN
    RAISE EXCEPTION 'feed_stores needs an origin, a positive radius and a positive limit'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (p_after_distance IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'feed_stores cursor needs both distance and id' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT (ps.value #>> '{}')::double precision INTO max_radius_km
  FROM public.platform_settings ps WHERE ps.key = 'feed_max_radius_km';
  SELECT (ps.value #>> '{}')::integer INTO max_page_size
  FROM public.platform_settings ps WHERE ps.key = 'feed_page_size_max';
  IF max_radius_km IS NULL OR max_page_size IS NULL THEN
    RAISE EXCEPTION 'platform settings feed_max_radius_km / feed_page_size_max are missing';
  END IF;

  RETURN QUERY
    SELECT d.id, d.tenant_id, d.distance_m
    FROM (
      SELECT s.id, s.tenant_id, st_distance(s.location, p_origin, false) AS distance_m
      FROM public.stores s
      WHERE s.status_code = 'active' AND s.deleted_at IS NULL
        AND st_dwithin(s.location, p_origin, least(p_radius_km, max_radius_km) * 1000, false)
    ) d
    WHERE p_after_distance IS NULL OR (d.distance_m, d.id) > (p_after_distance, p_after_id)
    ORDER BY d.distance_m, d.id
    LIMIT least(p_limit, max_page_size);
END
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.feed_stores(geography, double precision, double precision, uuid, integer) IS
  'Store cards for the feed (ADR 035): active stores within the radius, nearest first, keyset on (distance, id). SECURITY DEFINER: ids only.';
--> statement-breakpoint
ALTER FUNCTION public.feed_stores(geography, double precision, double precision, uuid, integer)
  OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.feed_stores(geography, double precision, double precision, uuid, integer) TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- feed_landmarks
-- ============================================================================

-- Landmarks (district hospital, bus terminal…) whose own reach covers the
-- viewer: landmark_radius_km, else the owning tenant's
-- landmark_default_radius_km override, else the platform default. Any
-- tenant, so a neighbour's landmark shows across the boundary (schema.md
-- §4.4). Nearest first.
CREATE OR REPLACE FUNCTION public.feed_landmarks(p_origin geography, p_limit integer)
RETURNS TABLE (id uuid, tenant_id uuid, distance_m double precision)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
-- Plan with the real arguments every call: a cached generic plan can't drop
-- the `x IS NULL OR …` branches and loses the GiST index (ADR 035).
SET plan_cache_mode = force_custom_plan
AS $$
#variable_conflict use_column
DECLARE
  default_km double precision;
  widest_km double precision;
  max_page_size integer;
BEGIN
  IF p_origin IS NULL OR p_limit IS NULL OR p_limit <= 0 THEN
    RAISE EXCEPTION 'feed_landmarks needs an origin and a positive limit'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT (ps.value #>> '{}')::double precision INTO default_km
  FROM public.platform_settings ps WHERE ps.key = 'landmark_default_radius_km';
  SELECT (ps.value #>> '{}')::integer INTO max_page_size
  FROM public.platform_settings ps WHERE ps.key = 'feed_page_size_max';
  IF default_km IS NULL OR max_page_size IS NULL THEN
    RAISE EXCEPTION 'platform settings landmark_default_radius_km / feed_page_size_max are missing';
  END IF;

  -- The widest reach any landmark has: the index-assisted search radius.
  SELECT greatest(
           default_km,
           (SELECT max((ts.setting_overrides ->> 'landmark_default_radius_km')::double precision)
            FROM public.tenant_settings ts
            WHERE ts.setting_overrides ->> 'landmark_default_radius_km' IS NOT NULL),
           (SELECT max(pl.landmark_radius_km)::double precision
            FROM public.places pl
            WHERE pl.is_landmark AND pl.status_code = 'published' AND pl.deleted_at IS NULL))
    INTO widest_km;

  RETURN QUERY
    SELECT d.id, d.tenant_id, d.distance_m
    FROM (
      SELECT pl.id, pl.tenant_id, st_distance(pl.location, p_origin, false) AS distance_m,
             coalesce(pl.landmark_radius_km::double precision,
                      (ts.setting_overrides ->> 'landmark_default_radius_km')::double precision,
                      default_km) * 1000 AS reach_m
      FROM public.places pl
      LEFT JOIN public.tenant_settings ts ON ts.tenant_id = pl.tenant_id
      -- Matches places_landmark_location_gist_idx's predicate.
      WHERE pl.is_landmark AND pl.status_code = 'published' AND pl.deleted_at IS NULL
        AND st_dwithin(pl.location, p_origin, widest_km * 1000, false)
    ) d
    WHERE d.distance_m <= d.reach_m
    ORDER BY d.distance_m, d.id
    LIMIT least(p_limit, max_page_size);
END
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.feed_landmarks(geography, integer) IS
  'Landmark place cards for the feed (ADR 035): published landmarks of any tenant whose own radius reaches the viewer, nearest first. SECURITY DEFINER: ids only.';
--> statement-breakpoint
ALTER FUNCTION public.feed_landmarks(geography, integer) OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.feed_landmarks(geography, integer) TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- Grants for the owner
-- ============================================================================

-- BYPASSRLS skips row policies, not table GRANTs (0012 precedent). posts
-- (SELECT, UPDATE), stores, places, media_attachments, tenant_settings and
-- platform_settings were granted in 0012 / 0023 / 0027.
GRANT SELECT ON public.boosts TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.boost_types TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.member_trust_scores TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.categories TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.category_field_schemas TO ae_rls_bypass;
--> statement-breakpoint

-- ============================================================================
-- Settings
-- ============================================================================

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('feed_default_radius_km', '5', 'decimal', 'km', 0.5, 50, 'tenant_admin',
   'Radius of the area feed (scope=area) around the viewer, and of nearby when no radius is asked for.'),
  ('feed_max_radius_km', '25', 'decimal', 'km', 1, 50, 'platform',
   'Largest radius the nearby feed accepts; also clamps feed_posts/feed_stores in the database.'),
  ('feed_page_size_default', '20', 'integer', 'count', 1, 100, 'none',
   'Post cards per feed page when the request gives no limit.'),
  ('feed_page_size_max', '50', 'integer', 'count', 1, 100, 'none',
   'Most post cards one feed page returns.'),
  ('feed_weight_distance', '0.30', 'decimal', 'weight', 0, 10, 'platform',
   'Ranking weight of proximity: 0.5 ^ (distance / feed_distance_half_km).'),
  ('feed_weight_recency', '0.35', 'decimal', 'weight', 0, 10, 'platform',
   'Ranking weight of freshness: 0.5 ^ (age / feed_recency_half_life_hours).'),
  ('feed_weight_boost', '0.50', 'decimal', 'weight', 0, 10, 'platform',
   'Ranking bonus of a post boosted within the boost_slots_per_category cap.'),
  ('feed_weight_trust', '0.15', 'decimal', 'weight', 0, 10, 'platform',
   'Ranking weight of the poster trust score (0-100, scaled to 0-1).'),
  ('feed_weight_completeness', '0.20', 'decimal', 'weight', 0, 10, 'platform',
   'Ranking weight of completeness: half photo count, half filled category fields.'),
  ('feed_distance_half_km', '2', 'decimal', 'km', 0.1, 500, 'platform',
   'Distance at which the proximity part of the feed score halves.'),
  ('feed_recency_half_life_hours', '48', 'integer', 'hours', 1, 720, 'platform',
   'Post age at which the freshness part of the feed score halves.'),
  ('feed_completeness_photo_target', '4', 'integer', 'count', 1, 20, 'none',
   'Photos at which a post gets full photo credit in the completeness score.'),
  ('feed_store_card_interval', '6', 'integer', 'count', 0, 100, 'tenant_admin',
   'A nearby store card after every N post cards; 0 turns store cards off.'),
  ('feed_emergency_card_position', '1', 'integer', 'count', 0, 100, 'tenant_admin',
   'Slot on the first feed page for the emergency shortcut card (1 = first); 0 = off.'),
  ('feed_bazar_card_position', '4', 'integer', 'count', 0, 100, 'tenant_admin',
   'Slot on the first feed page for the bazar prices today card; 0 = off.'),
  ('feed_landmark_card_position', '8', 'integer', 'count', 0, 100, 'tenant_admin',
   'Slot on the first feed page where landmark cards start; 0 = off.'),
  ('feed_landmark_cards_max', '3', 'integer', 'count', 1, 20, 'tenant_admin',
   'Most landmark cards on the first feed page.'),
  ('feed_bazar_card_items', '4', 'integer', 'count', 1, 20, 'tenant_admin',
   'Commodities shown on the bazar prices today card.'),
  ('feed_emergency_card_items', '3', 'integer', 'count', 1, 10, 'none',
   'National hotlines shown on the emergency shortcut card.'),
  ('feed_cache_ttl_seconds', '60', 'integer', 'seconds', 0, 3600, 'none',
   'How long a cached first feed page lives in Redis; 0 disables the cache.'),
  ('feed_cache_geohash_precision', '7', 'integer', 'count', 5, 9, 'none',
   'Geohash length of the first-page cache cell; the feed origin snaps to the cell centre (7 = about 150 m).');
