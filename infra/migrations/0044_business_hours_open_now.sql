-- 0044_business_hours_open_now
--
-- Business hours and "open now" (ADR 049): one SQL implementation, used by
-- the feed, search, the map and every detail view.
--
--   tenants.timezone      validated against pg_timezone_names. Every
--                           open/closed answer is computed in the OWNING
--                           tenant's zone, read from this column — never an
--                           assumed Asia/Dhaka (0039–0041's map_features
--                           hard-coded it; replaced below).
--   store_hours           TENANT-SCOPED, the weekly schedule of a store, the
--                           same shape as place_hours (0005): any number of
--                           ranges per day (split shifts: closed for Jummah or
--                           the afternoon), closes_next_day for ranges past
--                           midnight. A store with no hours of its own uses its
--                           place's (the place is its map pin, ADR 047).
--   hours_exceptions      TENANT-SCOPED, special days by date for a place or a
--                           store: closed all day (a holiday), or that day's own
--                           ranges. A date with any exception ignores the
--                           weekly schedule; a closed row wins over ranges.
--   places/stores.closed_until
--                           the owner's "closed today" toggle: closed until
--                           then (the API sets the next local midnight).
--   open_state            (state, changes_at): open | closed | opens_soon |
--                           closes_soon | unknown, and when it next changes.
--   hours_intervals()     the open intervals of an entity over local dates.
--   is_open_at(entity_type, id, at)
--                           THE implementation. No hours = unknown, never
--                           closed. open_states() (batch) and open_ids_near()
--                           (search) only call it.
--   map_features()        rebuilt on is_open_at (stores now have hours too);
--                           new columns open_state / open_changes_at. The old
--                           12-argument version is DROPPED (a return type can't
--                           be CREATE OR REPLACEd); the API moves with it.
--   feed_stores() / feed_landmarks()
--                           + p_open_only; the old signatures are DROPPED.
--
-- Seeds: settings. Tests: apps/api/test/hours.db-spec.ts, apps/api/test/hours.e2e-spec.ts.

SELECT set_config('app.is_platform_admin', 'true', true);
--> statement-breakpoint

-- ============================================================================
-- tenants.timezone: a real zone
-- ============================================================================

CREATE OR REPLACE FUNCTION public.tenants_validate_timezone()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name = NEW.timezone) THEN
    RAISE EXCEPTION 'tenants.timezone % is not a known time zone', NEW.timezone
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER tenants_a_validate_timezone BEFORE INSERT OR UPDATE OF timezone ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.tenants_validate_timezone();
--> statement-breakpoint

-- ============================================================================
-- store_hours
-- ============================================================================

CREATE TABLE public.store_hours (
  id                uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id         uuid        NOT NULL DEFAULT public.current_tenant_id(),
  store_id          uuid        NOT NULL,
  iso_day_of_week   smallint    NOT NULL,
  opens_at          time        NOT NULL,
  closes_at         time        NOT NULL,
  closes_next_day   boolean     NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_hours_pk PRIMARY KEY (id),
  CONSTRAINT store_hours_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT store_hours_tenant_id_store_id_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT store_hours_iso_day_of_week_ck CHECK (iso_day_of_week BETWEEN 1 AND 7),
  CONSTRAINT store_hours_closes_at_ck CHECK (closes_next_day OR closes_at > opens_at)
);
--> statement-breakpoint
-- A store's week; also the FK index.
CREATE INDEX store_hours_tenant_store_day_idx
  ON public.store_hours (tenant_id, store_id, iso_day_of_week, opens_at);
--> statement-breakpoint
CREATE TRIGGER store_hours_set_updated_at BEFORE UPDATE ON public.store_hours
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
ALTER TABLE public.store_hours ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.store_hours FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY store_hours_public_read ON public.store_hours
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND EXISTS (
      SELECT 1 FROM public.stores s
      WHERE s.id = store_hours.store_id AND s.status_code = 'active' AND s.deleted_at IS NULL
    )
  );
--> statement-breakpoint
CREATE POLICY store_hours_manage ON public.store_hours
  FOR ALL
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND ((SELECT public.can_manage_store(store_id)) OR (SELECT public.app_is_staff()))
  )
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND ((SELECT public.can_manage_store(store_id)) OR (SELECT public.app_is_staff()))
  );
--> statement-breakpoint
CREATE POLICY store_hours_platform_admin ON public.store_hours
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_hours TO ae_app;
--> statement-breakpoint
GRANT SELECT ON public.store_hours TO ae_rls_bypass;
--> statement-breakpoint

-- ============================================================================
-- hours_exceptions
-- ============================================================================

CREATE TABLE public.hours_exceptions (
  id                  uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id           uuid        NOT NULL DEFAULT public.current_tenant_id(),
  place_id            uuid,
  store_id            uuid,
  -- The local date (owning tenant's zone).
  on_date             date        NOT NULL,
  -- true: closed all day (a holiday). false: open opens_at–closes_at that day.
  is_closed           boolean     NOT NULL,
  opens_at            time,
  closes_at           time,
  closes_next_day     boolean     NOT NULL DEFAULT false,
  -- "ঈদের ছুটি" — shown to visitors as the owner wrote it.
  note                text,
  created_by_user_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hours_exceptions_pk PRIMARY KEY (id),
  CONSTRAINT hours_exceptions_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT hours_exceptions_tenant_id_place_id_fk FOREIGN KEY (tenant_id, place_id)
    REFERENCES public.places (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT hours_exceptions_tenant_id_store_id_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT hours_exceptions_created_by_user_id_fk FOREIGN KEY (created_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT hours_exceptions_owner_ck CHECK (num_nonnulls(place_id, store_id) = 1),
  CONSTRAINT hours_exceptions_range_ck CHECK (
    (is_closed AND opens_at IS NULL AND closes_at IS NULL AND NOT closes_next_day)
    OR (NOT is_closed AND opens_at IS NOT NULL AND closes_at IS NOT NULL
        AND (closes_next_day OR closes_at > opens_at))
  )
);
--> statement-breakpoint
-- An entity's special days by date; also the FK indexes.
CREATE INDEX hours_exceptions_place_date_idx ON public.hours_exceptions (tenant_id, place_id, on_date)
  WHERE place_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX hours_exceptions_store_date_idx ON public.hours_exceptions (tenant_id, store_id, on_date)
  WHERE store_id IS NOT NULL;
--> statement-breakpoint
-- One "closed" row per entity per date.
CREATE UNIQUE INDEX hours_exceptions_closed_uq
  ON public.hours_exceptions (coalesce(place_id, store_id), on_date) WHERE is_closed;
--> statement-breakpoint
CREATE INDEX hours_exceptions_created_by_idx ON public.hours_exceptions (created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER hours_exceptions_set_updated_at BEFORE UPDATE ON public.hours_exceptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
ALTER TABLE public.hours_exceptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.hours_exceptions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Visible with its (public) place or store.
CREATE POLICY hours_exceptions_public_read ON public.hours_exceptions
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND (
      EXISTS (SELECT 1 FROM public.places p
              WHERE p.id = hours_exceptions.place_id
                AND p.status_code IN ('published', 'temporarily_closed', 'permanently_closed')
                AND p.deleted_at IS NULL)
      OR EXISTS (SELECT 1 FROM public.stores s
                 WHERE s.id = hours_exceptions.store_id AND s.status_code = 'active' AND s.deleted_at IS NULL)
    )
  );
--> statement-breakpoint
-- Who may edit the place (its UPDATE policy) or manage the store.
CREATE POLICY hours_exceptions_write ON public.hours_exceptions
  FOR ALL
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND (
      (SELECT public.app_is_staff())
      OR (place_id IS NOT NULL AND (
            public.app_role() = 'agent'
            OR EXISTS (SELECT 1 FROM public.places p
                       WHERE p.id = hours_exceptions.place_id
                         AND p.claimed_by_member_id = (SELECT public.current_member_id()))))
      OR (store_id IS NOT NULL AND (SELECT public.can_manage_store(store_id)))
    )
  )
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND (
      (SELECT public.app_is_staff())
      OR (place_id IS NOT NULL AND (
            public.app_role() = 'agent'
            OR EXISTS (SELECT 1 FROM public.places p
                       WHERE p.id = hours_exceptions.place_id
                         AND p.claimed_by_member_id = (SELECT public.current_member_id()))))
      OR (store_id IS NOT NULL AND (SELECT public.can_manage_store(store_id)))
    )
  );
--> statement-breakpoint
CREATE POLICY hours_exceptions_platform_admin ON public.hours_exceptions
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hours_exceptions TO ae_app;
--> statement-breakpoint
GRANT SELECT ON public.hours_exceptions TO ae_rls_bypass;
--> statement-breakpoint

-- ============================================================================
-- "Closed today"
-- ============================================================================

ALTER TABLE public.places ADD COLUMN closed_until timestamptz;
--> statement-breakpoint
ALTER TABLE public.stores ADD COLUMN closed_until timestamptz;
--> statement-breakpoint

-- ============================================================================
-- Settings (rule 9)
-- ============================================================================

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('hours_opens_soon_minutes', '30', 'integer', 'minutes', 0, 240, 'tenant_admin',
   'A closed place that opens within this many minutes is "opens soon".'),
  ('hours_closes_soon_minutes', '30', 'integer', 'minutes', 0, 240, 'tenant_admin',
   'An open place that closes within this many minutes is "closes soon".'),
  ('hours_lookahead_days', '8', 'integer', 'days', 2, 31, 'none',
   'How far ahead the next opening or closing is looked for (a week plus a day covers any weekly schedule).'),
  ('hours_ranges_per_day_max', '4', 'integer', 'count', 1, 12, 'none',
   'Opening ranges one day may have (split shifts).'),
  ('hours_special_days_max', '60', 'integer', 'count', 1, 366, 'none',
   'Upcoming special days (holidays, exceptions) one place or store may list.');
--> statement-breakpoint

-- ============================================================================
-- The open-state type and functions (owned by ae_rls_bypass)
-- ============================================================================

CREATE TYPE public.open_state AS (state text, changes_at timestamptz);
--> statement-breakpoint

SET LOCAL ROLE ae_rls_bypass;
--> statement-breakpoint

-- A setting's effective value for a tenant: its override, else the platform default.
CREATE OR REPLACE FUNCTION public.setting_value_for(p_key text, p_tenant_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(
    (SELECT ts.setting_overrides -> p_key FROM public.tenant_settings ts WHERE ts.tenant_id = p_tenant_id),
    (SELECT ps.value FROM public.platform_settings ps WHERE ps.key = p_key))
$$;
--> statement-breakpoint

-- The open intervals (absolute instants) of an entity over the local dates
-- p_from..p_to in zone p_tz. A date with special days uses only them (none,
-- if one says closed); every other date uses the weekly schedule. A range
-- with closes_next_day ends the next day. A store without weekly hours of its
-- own uses its place's schedule and special days (plus its own special days).
CREATE OR REPLACE FUNCTION public.hours_intervals(
  p_entity_type text,
  p_entity_id uuid,
  p_tz text,
  p_from date,
  p_to date
)
RETURNS TABLE (starts_at timestamptz, ends_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH own_store_hours AS (
    SELECT EXISTS (SELECT 1 FROM public.store_hours sh WHERE sh.store_id = p_entity_id) AS present
  ),
  src AS (
    SELECT
      CASE
        WHEN p_entity_type = 'place' THEN p_entity_id
        WHEN p_entity_type = 'store' AND NOT o.present
          THEN (SELECT s.place_id FROM public.stores s WHERE s.id = p_entity_id)
      END AS place_id,
      CASE WHEN p_entity_type = 'store' AND o.present THEN p_entity_id END AS store_id,
      CASE WHEN p_entity_type = 'store' THEN p_entity_id END AS store_exceptions_id
    FROM own_store_hours o
  ),
  weekly AS (
    SELECT h.iso_day_of_week, h.opens_at, h.closes_at, h.closes_next_day
    FROM public.place_hours h, src WHERE h.place_id = src.place_id
    UNION ALL
    SELECT h.iso_day_of_week, h.opens_at, h.closes_at, h.closes_next_day
    FROM public.store_hours h, src WHERE h.store_id = src.store_id
  ),
  exc AS (
    SELECT e.on_date, e.is_closed, e.opens_at, e.closes_at, e.closes_next_day
    FROM public.hours_exceptions e, src
    WHERE (e.place_id = src.place_id OR e.store_id = src.store_exceptions_id)
      AND e.on_date BETWEEN p_from AND p_to
  ),
  days AS (
    SELECT d::date AS day FROM generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d
  ),
  ranges AS (
    SELECT d.day, x.opens_at, x.closes_at, x.closes_next_day
    FROM days d JOIN exc x ON x.on_date = d.day
    WHERE NOT x.is_closed
      AND NOT EXISTS (SELECT 1 FROM exc c WHERE c.on_date = d.day AND c.is_closed)
    UNION ALL
    SELECT d.day, w.opens_at, w.closes_at, w.closes_next_day
    FROM days d JOIN weekly w ON w.iso_day_of_week = extract(isodow FROM d.day)
    WHERE NOT EXISTS (SELECT 1 FROM exc x WHERE x.on_date = d.day)
  )
  SELECT (r.day + r.opens_at) AT TIME ZONE p_tz,
         (r.day + r.closes_at + CASE WHEN r.closes_next_day THEN interval '1 day' ELSE interval '0' END)
           AT TIME ZONE p_tz
  FROM ranges r
$$;
--> statement-breakpoint

-- THE open/closed answer (ADR 049) for a place, a store or an emergency
-- contact at an instant, in the owning tenant's zone:
--   unknown      no hours at all (never "closed" for lack of data);
--   closed       closed (temporarily/permanently closed, "closed today",
--                a closed special day, or between ranges);
--   opens_soon   closed, opening within hours_opens_soon_minutes;
--   open         inside a range;
--   closes_soon  open, closing within hours_closes_soon_minutes.
-- changes_at: the next opening (closed) or closing (open) within
-- hours_lookahead_days, NULL when there is none (or for unknown). Ranges that
-- touch or overlap (23:00–24:00 + 00:00–02:00) count as one. NULL for an
-- entity that doesn't exist.
CREATE OR REPLACE FUNCTION public.is_open_at(p_entity_type text, p_entity_id uuid, p_at timestamptz)
RETURNS public.open_state
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tenant uuid;
  v_status text;
  v_closed_until timestamptz;
  v_is_24h boolean;
  v_tz text;
  v_from timestamptz;
  v_local_day date;
  v_lookahead integer;
  v_soon_open integer;
  v_soon_close integer;
  v_has_hours boolean;
  v_current_end timestamptz;
  v_next_start timestamptz;
  v_change timestamptz;
BEGIN
  IF p_entity_type = 'place' THEN
    SELECT p.tenant_id,
           CASE WHEN p.deleted_at IS NOT NULL OR p.merged_into_place_id IS NOT NULL THEN 'gone'
                ELSE p.status_code END,
           p.closed_until
      INTO v_tenant, v_status, v_closed_until
    FROM public.places p WHERE p.id = p_entity_id;
  ELSIF p_entity_type = 'store' THEN
    SELECT s.tenant_id,
           CASE WHEN s.deleted_at IS NOT NULL THEN 'gone' ELSE s.status_code END,
           -- The store's own toggle, or its place's (when it shares the place's hours).
           greatest(s.closed_until, (SELECT pl.closed_until FROM public.places pl WHERE pl.id = s.place_id))
      INTO v_tenant, v_status, v_closed_until
    FROM public.stores s WHERE s.id = p_entity_id;
  ELSIF p_entity_type = 'emergency' THEN
    SELECT e.tenant_id, e.is_24h INTO v_tenant, v_is_24h
    FROM public.emergency_contacts e WHERE e.id = p_entity_id AND e.deleted_at IS NULL;
    IF v_tenant IS NULL THEN
      RETURN NULL;
    END IF;
    RETURN ROW(CASE WHEN v_is_24h THEN 'open' ELSE 'unknown' END, NULL)::public.open_state;
  ELSE
    RAISE EXCEPTION 'is_open_at: unknown entity type %', p_entity_type USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_tenant IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_status IN ('temporarily_closed', 'permanently_closed', 'gone', 'rejected', 'suspended', 'closed') THEN
    RETURN ROW('closed', NULL)::public.open_state;
  END IF;

  SELECT t.timezone INTO v_tz FROM public.tenants t WHERE t.id = v_tenant;
  v_lookahead := (public.setting_value_for('hours_lookahead_days', v_tenant) #>> '{}')::integer;
  v_soon_open := (public.setting_value_for('hours_opens_soon_minutes', v_tenant) #>> '{}')::integer;
  v_soon_close := (public.setting_value_for('hours_closes_soon_minutes', v_tenant) #>> '{}')::integer;
  IF v_tz IS NULL OR v_lookahead IS NULL OR v_soon_open IS NULL OR v_soon_close IS NULL THEN
    RAISE EXCEPTION 'is_open_at: tenant time zone or hours settings missing';
  END IF;
  v_local_day := (p_at AT TIME ZONE v_tz)::date;
  -- "Closed today" moves the question to when it ends.
  v_from := greatest(p_at, coalesce(v_closed_until, p_at));

  -- Any hours at all: a weekly schedule, or a special day in the window.
  v_has_hours := EXISTS (
    SELECT 1 FROM public.place_hours h
    WHERE h.place_id = CASE WHEN p_entity_type = 'place' THEN p_entity_id
                            ELSE (SELECT s.place_id FROM public.stores s WHERE s.id = p_entity_id) END
  ) OR EXISTS (SELECT 1 FROM public.store_hours h WHERE p_entity_type = 'store' AND h.store_id = p_entity_id)
    OR EXISTS (
    SELECT 1 FROM public.hours_exceptions e
    WHERE (e.place_id = p_entity_id OR e.store_id = p_entity_id)
      AND e.on_date BETWEEN v_local_day - 1 AND v_local_day + v_lookahead
  );
  IF NOT v_has_hours THEN
    -- No schedule: unknown — unless the owner said "closed today".
    RETURN CASE WHEN v_closed_until > p_at THEN ROW('closed', NULL)::public.open_state
                ELSE ROW('unknown', NULL)::public.open_state END;
  END IF;

  -- Ranges merged where they touch or overlap (gaps and islands).
  WITH iv AS (
    SELECT i.starts_at, i.ends_at
    FROM public.hours_intervals(p_entity_type, p_entity_id, v_tz, v_local_day - 1, v_local_day + v_lookahead) i
  ),
  marked AS (
    SELECT iv.*, CASE WHEN iv.starts_at > max(iv.ends_at) OVER (
                        ORDER BY iv.starts_at, iv.ends_at ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
                      THEN 1 ELSE 0 END AS gap
    FROM iv
  ),
  grouped AS (
    SELECT m.*, sum(m.gap) OVER (ORDER BY m.starts_at, m.ends_at) AS island FROM marked m
  ),
  merged AS (
    SELECT min(g.starts_at) AS s, max(g.ends_at) AS e FROM grouped g GROUP BY g.island
  )
  SELECT (SELECT m.e FROM merged m WHERE m.s <= v_from AND v_from < m.e),
         (SELECT min(m.s) FROM merged m WHERE m.s > v_from)
    INTO v_current_end, v_next_start;

  IF v_closed_until > p_at THEN
    -- Closed by the owner until v_from; it opens again then (if a range is
    -- running) or at the next range.
    v_change := CASE WHEN v_current_end IS NOT NULL THEN v_from ELSE v_next_start END;
    RETURN ROW(
      CASE WHEN v_change IS NOT NULL AND v_change - p_at <= make_interval(mins => v_soon_open)
           THEN 'opens_soon' ELSE 'closed' END,
      v_change)::public.open_state;
  END IF;
  IF v_current_end IS NOT NULL THEN
    RETURN ROW(
      CASE WHEN v_current_end - p_at <= make_interval(mins => v_soon_close) THEN 'closes_soon' ELSE 'open' END,
      v_current_end)::public.open_state;
  END IF;
  RETURN ROW(
    CASE WHEN v_next_start IS NOT NULL AND v_next_start - p_at <= make_interval(mins => v_soon_open)
         THEN 'opens_soon' ELSE 'closed' END,
    v_next_start)::public.open_state;
END
$$;
--> statement-breakpoint

-- is_open_at for many entities of one type (detail lists, cards, search hits).
CREATE OR REPLACE FUNCTION public.open_states(p_entity_type text, p_ids uuid[], p_at timestamptz)
RETURNS TABLE (id uuid, state text, changes_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT x.id, (o).state, (o).changes_at
  FROM (SELECT u.id, public.is_open_at(p_entity_type, u.id, p_at) AS o
        FROM unnest(coalesce(p_ids, '{}'::uuid[])) AS u(id)) x
$$;
--> statement-breakpoint

-- Public stores or places within p_radius_m of a point (any tenant, rule 10)
-- that are open at p_at (open or closes_soon), nearest first: search's
-- open_now filter.
CREATE OR REPLACE FUNCTION public.open_ids_near(
  p_entity_type text,
  p_lat double precision,
  p_lng double precision,
  p_radius_m double precision,
  p_at timestamptz,
  p_limit integer
)
RETURNS TABLE (id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH origin AS (SELECT public.geo_point(p_lat, p_lng) AS pt),
  near AS (
    SELECT p.id, st_distance(p.location, o.pt) AS d
    FROM public.places p, origin o
    WHERE p_entity_type = 'place' AND st_dwithin(p.location, o.pt, p_radius_m)
      AND p.status_code = 'published' AND p.deleted_at IS NULL
    UNION ALL
    -- A store is where it says, else at its place (as search indexes it).
    SELECT s.id, st_distance(coalesce(s.location, pl.location), o.pt)
    FROM public.stores s
    LEFT JOIN public.places pl ON pl.tenant_id = s.tenant_id AND pl.id = s.place_id
    CROSS JOIN origin o
    WHERE p_entity_type = 'store'
      AND st_dwithin(coalesce(s.location, pl.location), o.pt, p_radius_m)
      AND s.status_code = 'active' AND s.deleted_at IS NULL
  )
  SELECT n.id FROM near n
  WHERE (public.is_open_at(p_entity_type, n.id, p_at)).state IN ('open', 'closes_soon')
  ORDER BY n.d, n.id
  LIMIT p_limit
$$;
--> statement-breakpoint

-- ---- feed_stores / feed_landmarks + p_open_only -----------------------------

DROP FUNCTION public.feed_stores(geography, double precision, double precision, uuid, integer);
--> statement-breakpoint
DROP FUNCTION public.feed_landmarks(geography, integer);
--> statement-breakpoint

CREATE FUNCTION public.feed_stores(
  p_origin geography,
  p_radius_km double precision,
  p_after_distance double precision,
  p_after_id uuid,
  p_limit integer,
  p_open_only boolean
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
    WHERE (p_after_distance IS NULL OR (d.distance_m, d.id) > (p_after_distance, p_after_id))
      AND (NOT coalesce(p_open_only, false)
           OR (public.is_open_at('store', d.id, now())).state IN ('open', 'closes_soon'))
    ORDER BY d.distance_m, d.id
    LIMIT least(p_limit, max_page_size);
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.feed_landmarks(p_origin geography, p_limit integer, p_open_only boolean)
RETURNS TABLE (id uuid, tenant_id uuid, distance_m double precision)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
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
      AND (NOT coalesce(p_open_only, false)
           OR (public.is_open_at('place', d.id, now())).state IN ('open', 'closes_soon'))
    ORDER BY d.distance_m, d.id
    LIMIT least(p_limit, max_page_size);
END
$$;
--> statement-breakpoint

-- ---- map_features on is_open_at ---------------------------------------------

DROP FUNCTION public.map_features(double precision, double precision, double precision, double precision, integer, text[], text, boolean, double precision, double precision, integer, text[]);
--> statement-breakpoint

CREATE FUNCTION public.map_features(
  p_min_lng double precision,
  p_min_lat double precision,
  p_max_lng double precision,
  p_max_lat double precision,
  p_zoom integer,
  p_layers text[],
  p_category_slug text,
  p_open_now boolean,
  p_center_lat double precision,
  p_center_lng double precision,
  p_limit integer,
  p_kinds text[]
)
RETURNS TABLE (
  layer text,
  point_count integer,
  lng double precision,
  lat double precision,
  id uuid,
  tenant_id uuid,
  name_bn text,
  name_en text,
  category_slug text,
  price text,
  slug text,
  info_kind text,
  open_now boolean,
  kind text,
  open_state text,
  open_changes_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
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
        AND p.status_code = 'live' AND p.deleted_at IS NULL AND NOT p.hidden_by_owner
        AND p.location && envelope_g AND p.location::geometry && envelope
        AND (box_fits OR st_dwithin(p.location, center, radius_m))
        AND (category_ids IS NULL OR p.category_id = ANY (category_ids))
      UNION ALL
      SELECT 'stores'::text, s.id, s.tenant_id, s.location::geometry, 'stores'::text, NULL::uuid, NULL::text
      FROM public.stores s
      WHERE 'stores' = ANY (p_layers)
        AND p_category_slug IS NULL
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
    ),
    raw AS (
      SELECT b.*, o.state AS ostate, o.changes_at AS ochanges
      FROM base b
      LEFT JOIN LATERAL (
        SELECT (x).state, (x).changes_at
        FROM (SELECT public.is_open_at(
                       CASE b.src WHEN 'stores' THEN 'store' WHEN 'places' THEN 'place' ELSE 'emergency' END,
                       b.id, now()) AS x) y
      ) o ON open_only AND b.src IN ('stores', 'places', 'emergency')
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
      LEFT JOIN LATERAL (
        SELECT public.is_open_at(
                 CASE pk.src WHEN 'stores' THEN 'store' WHEN 'places' THEN 'place' ELSE 'emergency' END,
                 pk.id, now()) AS x
      ) os ON pk.n = 1 AND pk.ostate IS NULL AND pk.src IN ('stores', 'places', 'emergency')
    )
    SELECT pk.layer, pk.n, pk.lng, pk.lat, pk.id, pk.tenant_id,
           CASE
             WHEN p.id IS NOT NULL THEN CASE WHEN p.title ~ '[ঀ-৿]' THEN p.title END
             ELSE coalesce(s.name_bn, pl.name_bn, e.name_bn, st.name_bn)
           END,
           CASE
             WHEN p.id IS NOT NULL THEN CASE WHEN p.title ~ '[ঀ-৿]' THEN NULL ELSE p.title END
             ELSE coalesce(s.name_en, pl.name_en, e.name_en, st.name_en)
           END,
           CASE WHEN pk.layer = 'info' THEN NULL ELSE coalesce(pc.slug, plc.slug) END,
           p.price::text,
           coalesce(s.slug, pl.slug),
           CASE
             WHEN pk.layer <> 'info' THEN NULL
             WHEN e.id IS NOT NULL THEN e.service_type_code
             WHEN st.id IS NOT NULL THEN 'bus_stop'
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
    LEFT JOIN public.places pl ON pk.n = 1 AND pk.src = 'places' AND pl.id = pk.id
    LEFT JOIN public.categories plc ON plc.id = pl.category_id
    LEFT JOIN public.emergency_contacts e ON pk.n = 1 AND pk.src = 'emergency' AND e.id = pk.id
    LEFT JOIN public.transport_route_stops st ON pk.n = 1 AND pk.src = 'bus_stops' AND st.id = pk.id
    ORDER BY pk.n DESC, pk.dist, pk.layer, pk.kind, pk.id;
END
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.map_features(double precision, double precision, double precision, double precision, integer, text[], text, boolean, double precision, double precision, integer, text[]) IS
  'The map''s data (ADR 045, 046, 049): public posts/stores/places/landmarks/info in a box, radius-bounded, grid-clustered by zoom per (layer, kind); open state from is_open_at(). SECURITY DEFINER: only columns public-read already exposes.';
--> statement-breakpoint

RESET ROLE;
--> statement-breakpoint

ALTER FUNCTION public.setting_value_for(text, uuid) OWNER TO ae_rls_bypass;
--> statement-breakpoint
ALTER FUNCTION public.hours_intervals(text, uuid, text, date, date) OWNER TO ae_rls_bypass;
--> statement-breakpoint
ALTER FUNCTION public.is_open_at(text, uuid, timestamptz) OWNER TO ae_rls_bypass;
--> statement-breakpoint
ALTER FUNCTION public.open_states(text, uuid[], timestamptz) OWNER TO ae_rls_bypass;
--> statement-breakpoint
ALTER FUNCTION public.open_ids_near(text, double precision, double precision, double precision, timestamptz, integer) OWNER TO ae_rls_bypass;
--> statement-breakpoint
ALTER FUNCTION public.feed_stores(geography, double precision, double precision, uuid, integer, boolean) OWNER TO ae_rls_bypass;
--> statement-breakpoint
ALTER FUNCTION public.feed_landmarks(geography, integer, boolean) OWNER TO ae_rls_bypass;
--> statement-breakpoint
ALTER FUNCTION public.map_features(double precision, double precision, double precision, double precision, integer, text[], text, boolean, double precision, double precision, integer, text[]) OWNER TO ae_rls_bypass;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.hours_intervals(text, uuid, text, date, date) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.setting_value_for(text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_open_at(text, uuid, timestamptz) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.open_states(text, uuid[], timestamptz) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.open_ids_near(text, double precision, double precision, double precision, timestamptz, integer) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.feed_stores(geography, double precision, double precision, uuid, integer, boolean) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.feed_landmarks(geography, integer, boolean) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.map_features(double precision, double precision, double precision, double precision, integer, text[], text, boolean, double precision, double precision, integer, text[]) TO ae_app;
--> statement-breakpoint
GRANT SELECT ON public.emergency_contacts, public.place_hours TO ae_rls_bypass;
