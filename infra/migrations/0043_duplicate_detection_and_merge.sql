-- 0043_duplicate_detection_and_merge
--
-- Duplicate places and stores, and the moderators' merge tool (ADR 048).
--
--   places / stores       + name_translit: the Bengali name in Latin letters
--                           (the API's transliterate(), search/text), written
--                           on create/edit and backfilled by the nightly job.
--                           Trigram indexes on it, and on stores.name_bn.
--   duplicate_name_key()  a name without the generic words that every shop
--                           shares (setting duplicate_name_stopwords: store,
--                           ষ্টোর, ফার্মেসি…), so "রহিম স্টোর" and "করিম স্টোর"
--                           compare as রহিম vs করিম.
--   place_duplicate_signals() / store_duplicate_signals()
--                           SECURITY DEFINER: every place (store) within a
--                           radius of a point, in ANY tenant (rule 10 — the
--                           boundary decides ownership, never visibility), with
--                           its name similarity (pg_trgm over the Bengali,
--                           transliterated and English name keys, best of),
--                           phone overlap, same category and distance. Scoring
--                           and classification are the API's (settings).
--   duplicate_candidates  TENANT-SCOPED (the tenant of the entity flagged): the
--                           review queue of likely/possible pairs, places or
--                           stores. One row per pair ever: a dismissed pair is
--                           never flagged again. Staff read/resolve; the system
--                           files them.
--   places.merged_into_place_id / merged_at
--                         a merged place stays as a redirect record (soft-deleted).
--   place_merges          TENANT-SCOPED: what each merge moved, so it can be
--                           undone within merge_undo_days.
--   merge_place() / undo_place_merge()
--                           staff, one transaction each: photos, revisions,
--                           saves, reviews, lead history, pending claims and an
--                           approved claim (with its store pin) move to the
--                           target; moderation_actions records it.
--   place_revisions_prevent_mutation
--                           also lets a merge (and its undo) re-point a revision
--                           to another place — place_id only, nothing else.
--   search sync triggers  places/stores: name_translit is noise (not indexed),
--                           so the backfill never reindexes.
--   scheduled job         detect-duplicates (nightly).
--
-- Seeds: settings, lookups, the job code. Tests: apps/api/test/duplicates.db-spec.ts,
-- apps/api/test/duplicates.e2e-spec.ts, src/places/duplicate-score.spec.ts.

SELECT set_config('app.is_platform_admin', 'true', true);
--> statement-breakpoint

INSERT INTO public.moderation_action_types (code, label_key, sort_order) VALUES
  ('merged',       'enum.moderation_action_types.merged',       150),
  ('merge_undone', 'enum.moderation_action_types.merge_undone', 160);
--> statement-breakpoint
INSERT INTO public.scheduled_jobs (code, label_key, sort_order) VALUES
  ('detect-duplicates', 'enum.scheduled_jobs.detect-duplicates', 110);
--> statement-breakpoint

-- ============================================================================
-- Transliterated names
-- ============================================================================

ALTER TABLE public.places ADD COLUMN name_translit text;
--> statement-breakpoint
ALTER TABLE public.stores ADD COLUMN name_translit text;
--> statement-breakpoint
CREATE INDEX places_name_translit_trgm_idx ON public.places USING gin (name_translit gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX stores_name_bn_trgm_idx ON public.stores USING gin (name_bn gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX stores_name_translit_trgm_idx ON public.stores USING gin (name_translit gin_trgm_ops);
--> statement-breakpoint
-- The nightly backfill.
CREATE INDEX places_name_translit_missing_idx ON public.places (id) WHERE name_translit IS NULL;
--> statement-breakpoint
CREATE INDEX stores_name_translit_missing_idx ON public.stores (id) WHERE name_translit IS NULL;
--> statement-breakpoint
-- Stores near a point, whatever their status (the existing GiST is active-only).
CREATE INDEX stores_location_all_gist_idx ON public.stores USING gist (location)
  WHERE location IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint

-- name_translit isn't in any search document (search builds its own
-- transliteration): writing it — the nightly backfill touches every row once
-- — must neither reindex nor leave a row looking out of sync to the sweeper.
DROP TRIGGER places_search_sync ON public.places;
--> statement-breakpoint
CREATE TRIGGER places_search_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.places
  FOR EACH ROW EXECUTE FUNCTION public.search_sync_row('updated_at', 'search_synced_at', 'name_translit');
--> statement-breakpoint
CREATE TRIGGER places_zz_search_carry_synced
  BEFORE UPDATE ON public.places
  FOR EACH ROW EXECUTE FUNCTION public.search_carry_synced('updated_at', 'search_synced_at', 'name_translit');
--> statement-breakpoint
DROP TRIGGER stores_search_sync ON public.stores;
--> statement-breakpoint
CREATE TRIGGER stores_search_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.stores
  FOR EACH ROW EXECUTE FUNCTION public.search_sync_row('updated_at', 'search_synced_at', 'follower_count', 'name_translit');
--> statement-breakpoint
DROP TRIGGER stores_zz_search_carry_synced ON public.stores;
--> statement-breakpoint
CREATE TRIGGER stores_zz_search_carry_synced
  BEFORE UPDATE ON public.stores
  FOR EACH ROW EXECUTE FUNCTION public.search_carry_synced('updated_at', 'search_synced_at', 'follower_count', 'name_translit');
--> statement-breakpoint

-- ============================================================================
-- Merged places stay as redirects
-- ============================================================================

ALTER TABLE public.places
  ADD COLUMN merged_into_place_id uuid,
  ADD COLUMN merged_at timestamptz;
--> statement-breakpoint
ALTER TABLE public.places
  ADD CONSTRAINT places_tenant_id_merged_into_place_id_fk FOREIGN KEY (tenant_id, merged_into_place_id)
    REFERENCES public.places (tenant_id, id) ON DELETE SET NULL (merged_into_place_id),
  ADD CONSTRAINT places_merged_ck CHECK (
    (merged_into_place_id IS NULL) = (merged_at IS NULL)
    AND merged_into_place_id IS DISTINCT FROM id
  );
--> statement-breakpoint
-- FK index (§0.4); "what was merged into this place".
CREATE INDEX places_merged_into_place_id_idx ON public.places (tenant_id, merged_into_place_id)
  WHERE merged_into_place_id IS NOT NULL;
--> statement-breakpoint

-- ============================================================================
-- duplicate_candidates
-- ============================================================================

CREATE TABLE public.duplicate_candidates (
  id                   uuid         NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id            uuid         NOT NULL DEFAULT public.current_tenant_id(),
  entity_type_code     text         NOT NULL,
  -- The flagged entity (in tenant_id) and the existing one it resembles (in
  -- candidate_tenant_id, possibly a neighbour). Exactly one pair is set.
  place_id             uuid,
  candidate_place_id   uuid,
  store_id             uuid,
  candidate_store_id   uuid,
  candidate_tenant_id  uuid         NOT NULL,
  score                numeric(4,3) NOT NULL,
  classification_code  text         NOT NULL,
  -- {name_similarity, phone_match, same_category, distance_m}
  signals              jsonb        NOT NULL DEFAULT '{}',
  source_code          text         NOT NULL,
  status_code          text         NOT NULL DEFAULT 'open',
  resolved_by_user_id  uuid,
  resolved_at          timestamptz,
  created_at           timestamptz  NOT NULL DEFAULT now(),
  updated_at           timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT duplicate_candidates_pk PRIMARY KEY (id),
  CONSTRAINT duplicate_candidates_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT duplicate_candidates_candidate_tenant_id_fk FOREIGN KEY (candidate_tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT duplicate_candidates_tenant_id_place_id_fk FOREIGN KEY (tenant_id, place_id)
    REFERENCES public.places (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT duplicate_candidates_candidate_place_fk FOREIGN KEY (candidate_tenant_id, candidate_place_id)
    REFERENCES public.places (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT duplicate_candidates_tenant_id_store_id_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT duplicate_candidates_candidate_store_fk FOREIGN KEY (candidate_tenant_id, candidate_store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT duplicate_candidates_resolved_by_user_id_fk FOREIGN KEY (resolved_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT duplicate_candidates_entity_type_ck CHECK (entity_type_code IN ('place', 'store')),
  CONSTRAINT duplicate_candidates_pair_ck CHECK (
    (entity_type_code = 'place' AND place_id IS NOT NULL AND candidate_place_id IS NOT NULL
       AND store_id IS NULL AND candidate_store_id IS NULL AND place_id <> candidate_place_id)
    OR (entity_type_code = 'store' AND store_id IS NOT NULL AND candidate_store_id IS NOT NULL
       AND place_id IS NULL AND candidate_place_id IS NULL AND store_id <> candidate_store_id)
  ),
  CONSTRAINT duplicate_candidates_score_ck CHECK (score BETWEEN 0 AND 1),
  CONSTRAINT duplicate_candidates_classification_ck CHECK (classification_code IN ('likely', 'possible')),
  CONSTRAINT duplicate_candidates_source_ck CHECK (source_code IN ('create', 'batch')),
  CONSTRAINT duplicate_candidates_status_ck CHECK (status_code IN ('open', 'merged', 'dismissed')),
  CONSTRAINT duplicate_candidates_resolved_ck CHECK ((status_code = 'open') = (resolved_at IS NULL)),
  CONSTRAINT duplicate_candidates_signals_ck CHECK (jsonb_typeof(signals) = 'object')
);
--> statement-breakpoint
-- One row per pair, whichever side was flagged, whatever became of it.
CREATE UNIQUE INDEX duplicate_candidates_pair_uq ON public.duplicate_candidates (
  entity_type_code,
  least(coalesce(place_id, store_id), coalesce(candidate_place_id, candidate_store_id)),
  greatest(coalesce(place_id, store_id), coalesce(candidate_place_id, candidate_store_id))
);
--> statement-breakpoint
-- The review queue: likely first, then by score.
CREATE INDEX duplicate_candidates_queue_idx ON public.duplicate_candidates (tenant_id, classification_code, score DESC, id)
  WHERE status_code = 'open';
--> statement-breakpoint
-- FK indexes (§0.4).
CREATE INDEX duplicate_candidates_place_idx ON public.duplicate_candidates (tenant_id, place_id)
  WHERE place_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX duplicate_candidates_candidate_place_idx ON public.duplicate_candidates (candidate_tenant_id, candidate_place_id)
  WHERE candidate_place_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX duplicate_candidates_store_idx ON public.duplicate_candidates (tenant_id, store_id)
  WHERE store_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX duplicate_candidates_candidate_store_idx ON public.duplicate_candidates (candidate_tenant_id, candidate_store_id)
  WHERE candidate_store_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX duplicate_candidates_resolved_by_idx ON public.duplicate_candidates (resolved_by_user_id)
  WHERE resolved_by_user_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER duplicate_candidates_set_updated_at BEFORE UPDATE ON public.duplicate_candidates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
ALTER TABLE public.duplicate_candidates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.duplicate_candidates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY duplicate_candidates_staff_read ON public.duplicate_candidates
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY duplicate_candidates_staff_resolve ON public.duplicate_candidates
  FOR UPDATE
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
-- Filing is the system's (the create flow and the nightly job run as system).
CREATE POLICY duplicate_candidates_system ON public.duplicate_candidates
  FOR ALL
  USING ((SELECT public.app_is_system()) OR (SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.app_is_system()) OR (SELECT public.is_platform_admin()));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.duplicate_candidates TO ae_app;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.duplicate_candidates TO ae_rls_bypass;
--> statement-breakpoint

-- ============================================================================
-- place_merges
-- ============================================================================

CREATE TABLE public.place_merges (
  id                  uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id           uuid        NOT NULL DEFAULT public.current_tenant_id(),
  loser_place_id      uuid        NOT NULL,
  target_place_id     uuid        NOT NULL,
  merged_by_user_id   uuid,
  reason_code         text        NOT NULL,
  reason_text         text,
  -- Exactly what moved, for the undo: {media: [{id, sort_order}], revisions: [id],
  -- reviews: [id], lead_events: [id], saves: [{user_id, new_on_target}],
  -- claims_moved: [id], claims_rejected: [id], claim: {store_id, member_id} | null}
  moved               jsonb       NOT NULL,
  undo_until          timestamptz NOT NULL,
  undone_at           timestamptz,
  undone_by_user_id   uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT place_merges_pk PRIMARY KEY (id),
  CONSTRAINT place_merges_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT place_merges_tenant_id_loser_place_id_fk FOREIGN KEY (tenant_id, loser_place_id)
    REFERENCES public.places (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT place_merges_tenant_id_target_place_id_fk FOREIGN KEY (tenant_id, target_place_id)
    REFERENCES public.places (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT place_merges_merged_by_user_id_fk FOREIGN KEY (merged_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT place_merges_undone_by_user_id_fk FOREIGN KEY (undone_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT place_merges_reason_code_fk FOREIGN KEY (reason_code)
    REFERENCES public.moderation_reasons (code) ON DELETE RESTRICT,
  CONSTRAINT place_merges_moved_ck CHECK (jsonb_typeof(moved) = 'object'),
  CONSTRAINT place_merges_undone_ck CHECK ((undone_at IS NULL) = (undone_by_user_id IS NULL)),
  CONSTRAINT place_merges_distinct_ck CHECK (loser_place_id <> target_place_id)
);
--> statement-breakpoint
-- A place is merged away at most once at a time.
CREATE UNIQUE INDEX place_merges_active_loser_uq ON public.place_merges (loser_place_id)
  WHERE undone_at IS NULL;
--> statement-breakpoint
CREATE INDEX place_merges_tenant_loser_idx ON public.place_merges (tenant_id, loser_place_id);
--> statement-breakpoint
CREATE INDEX place_merges_tenant_target_idx ON public.place_merges (tenant_id, target_place_id, id DESC);
--> statement-breakpoint
CREATE INDEX place_merges_merged_by_idx ON public.place_merges (merged_by_user_id) WHERE merged_by_user_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX place_merges_undone_by_idx ON public.place_merges (undone_by_user_id) WHERE undone_by_user_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX place_merges_reason_code_idx ON public.place_merges (reason_code);
--> statement-breakpoint
CREATE TRIGGER place_merges_set_updated_at BEFORE UPDATE ON public.place_merges
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
ALTER TABLE public.place_merges ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.place_merges FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Written only by merge_place() / undo_place_merge().
CREATE POLICY place_merges_staff_read ON public.place_merges
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY place_merges_platform_admin ON public.place_merges
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint
GRANT SELECT ON public.place_merges TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.place_merges TO ae_rls_bypass;
--> statement-breakpoint

-- ============================================================================
-- A merge re-points revisions (place_id only)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.place_revisions_prevent_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.places p WHERE p.id = OLD.place_id) THEN
    RETURN OLD;
  END IF;
  -- merge_place() / undo_place_merge() move a place's history wholesale; set
  -- only inside those functions, and ae_app has no UPDATE grant here anyway.
  IF TG_OP = 'UPDATE' AND current_setting('app.place_merge', true) = 'on'
     AND (to_jsonb(NEW) - 'place_id' - 'updated_at') = (to_jsonb(OLD) - 'place_id' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  IF OLD.xact_id <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'place_revisions rows are immutable (% blocked)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint

-- ============================================================================
-- Settings (rule 9)
-- ============================================================================

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('duplicate_radius_m', '150', 'integer', 'meters', 10, 2000, 'platform',
   'How far apart two places (or stores) may be and still be checked as duplicates.'),
  ('duplicate_likely_score', '0.8', 'decimal', 'ratio', 0, 1, 'platform',
   'Score at or above which a new place is a likely duplicate: its creation is held with an "is this the same place?" prompt.'),
  ('duplicate_possible_score', '0.45', 'decimal', 'ratio', 0, 1, 'platform',
   'Score at or above which a pair is a possible duplicate: allowed, but queued for a moderator.'),
  ('duplicate_phone_bonus', '0.4', 'decimal', 'ratio', 0, 1, 'platform',
   'Added to the name similarity when the two share a phone number (the strongest single signal).'),
  ('duplicate_category_mismatch_factor', '0.7', 'decimal', 'ratio', 0, 1, 'platform',
   'Multiplies the score when two places are in different categories.'),
  ('duplicate_candidates_max', '5', 'integer', 'count', 1, 50, 'none',
   'Most existing places shown in the "is this the same place?" prompt and checked per entity.'),
  ('duplicate_name_stopwords',
   '["store", "stor", "shtor", "stores", "shop", "enterprise", "enterprises", "traders", "trading", "telecom", "pharmacy", "pharmesi", "hotel", "restaurant", "restora", "ltd", "limited", "and", "স্টোর", "ষ্টোর", "স্টোরস", "দোকান", "এন্টারপ্রাইজ", "ট্রেডার্স", "টেলিকম", "ফার্মেসি", "ফার্মেসী", "হোটেল", "রেস্টুরেন্ট", "রেস্তোরাঁ", "লিমিটেড", "এন্ড", "ও"]',
   'text_array', NULL, NULL, NULL, 'tenant_admin',
   'Generic words left out when comparing names (every second shop is a "store"). Lower-case; tenant admins can replace the list.'),
  ('duplicate_batch_lookback_hours', '48', 'integer', 'hours', 1, 720, 'none',
   'The nightly duplicate check looks at places and stores created or changed this recently.'),
  ('merge_undo_days', '30', 'integer', 'days', 0, 365, 'platform',
   'How long a moderator can undo a place merge.');
--> statement-breakpoint

-- ============================================================================
-- Functions (owned by ae_rls_bypass)
-- ============================================================================

SET LOCAL ROLE ae_rls_bypass;
--> statement-breakpoint

-- Lower-cased words of a name minus the stop words; NULL when nothing is left.
CREATE OR REPLACE FUNCTION public.duplicate_name_key(p_name text, p_stopwords text[])
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT nullif(string_agg(t.w, ' ' ORDER BY t.ord), '')
  -- Explicit separators, not [[:punct:]]: under C.UTF-8 that class also
  -- matches the Bengali virama (্) and would split every conjunct (স্টোর).
  FROM regexp_split_to_table(lower(coalesce(p_name, '')), '[[:space:],.;:!?()"''/\\&+_|।-]+') WITH ORDINALITY AS t(w, ord)
  WHERE t.w <> '' AND NOT (t.w = ANY (coalesce(p_stopwords, '{}'::text[])))
$$;
--> statement-breakpoint

-- Best trigram similarity between two names over their Bengali, transliterated
-- and English keys (Latin keys also cross-compared): 0 when nothing compares.
CREATE OR REPLACE FUNCTION public.duplicate_name_similarity(
  a_bn text, a_en text, a_translit text,
  b_bn text, b_en text, b_translit text,
  p_stopwords text[]
)
RETURNS real
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(greatest(
    similarity(public.duplicate_name_key(a_bn, p_stopwords), public.duplicate_name_key(b_bn, p_stopwords)),
    similarity(public.duplicate_name_key(a_translit, p_stopwords), public.duplicate_name_key(b_translit, p_stopwords)),
    similarity(public.duplicate_name_key(a_en, p_stopwords), public.duplicate_name_key(b_en, p_stopwords)),
    similarity(public.duplicate_name_key(a_translit, p_stopwords), public.duplicate_name_key(b_en, p_stopwords)),
    similarity(public.duplicate_name_key(a_en, p_stopwords), public.duplicate_name_key(b_translit, p_stopwords))
  ), 0)
$$;
--> statement-breakpoint

-- Places within p_radius_m of a point, any tenant (rule 10), not deleted,
-- merged or rejected, with the raw signals. Only those with some name
-- likeness (>= p_min_name) or a shared phone come back.
CREATE OR REPLACE FUNCTION public.place_duplicate_signals(
  p_lat double precision,
  p_lng double precision,
  p_name_bn text,
  p_name_en text,
  p_name_translit text,
  p_phones text[],
  p_category_id uuid,
  p_exclude_place_id uuid,
  p_radius_m integer,
  p_stopwords text[],
  p_min_name real,
  p_limit integer
)
RETURNS TABLE (
  place_id uuid,
  tenant_id uuid,
  name_bn text,
  name_en text,
  status_code text,
  lat double precision,
  lng double precision,
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
  WITH origin AS (SELECT public.geo_point(p_lat, p_lng) AS pt),
  near AS (
    SELECT p.*, st_distance(p.location, o.pt) AS d,
           public.duplicate_name_similarity(p_name_bn, p_name_en, p_name_translit,
                                            p.name_bn, p.name_en, p.name_translit, p_stopwords) AS sim
    FROM public.places p, origin o
    WHERE st_dwithin(p.location, o.pt, p_radius_m)
      AND p.deleted_at IS NULL
      AND p.merged_into_place_id IS NULL
      AND p.status_code <> 'rejected'
      AND p.id IS DISTINCT FROM p_exclude_place_id
  )
  SELECT n.id, n.tenant_id, n.name_bn, n.name_en, n.status_code,
         st_y(n.location::geometry), st_x(n.location::geometry), n.d, n.sim,
         n.phones && coalesce(p_phones, '{}'::text[]),
         n.category_id = p_category_id
  FROM near n
  WHERE n.sim >= p_min_name OR n.phones && coalesce(p_phones, '{}'::text[])
  ORDER BY (n.phones && coalesce(p_phones, '{}'::text[])) DESC, n.sim DESC, n.d
  LIMIT p_limit
$$;
--> statement-breakpoint

-- The same for stores (no category; a store's own phone and WhatsApp count).
CREATE OR REPLACE FUNCTION public.store_duplicate_signals(
  p_lat double precision,
  p_lng double precision,
  p_name_bn text,
  p_name_en text,
  p_name_translit text,
  p_phones text[],
  p_exclude_store_id uuid,
  p_radius_m integer,
  p_stopwords text[],
  p_min_name real,
  p_limit integer
)
RETURNS TABLE (
  store_id uuid,
  tenant_id uuid,
  name_bn text,
  name_en text,
  status_code text,
  lat double precision,
  lng double precision,
  distance_m double precision,
  name_similarity real,
  phone_match boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH origin AS (SELECT public.geo_point(p_lat, p_lng) AS pt),
  near AS (
    SELECT s.*, st_distance(s.location, o.pt) AS d,
           public.duplicate_name_similarity(p_name_bn, p_name_en, p_name_translit,
                                            s.name_bn, s.name_en, s.name_translit, p_stopwords) AS sim,
           array_remove(ARRAY[s.phone_e164, s.whatsapp_e164], NULL) && coalesce(p_phones, '{}'::text[]) AS phone_hit
    FROM public.stores s, origin o
    WHERE s.location IS NOT NULL
      AND st_dwithin(s.location, o.pt, p_radius_m)
      AND s.deleted_at IS NULL
      AND s.status_code <> 'closed'
      AND s.id IS DISTINCT FROM p_exclude_store_id
  )
  SELECT n.id, n.tenant_id, n.name_bn, n.name_en, n.status_code,
         st_y(n.location::geometry), st_x(n.location::geometry), n.d, n.sim, n.phone_hit
  FROM near n
  WHERE n.sim >= p_min_name OR n.phone_hit
  ORDER BY n.phone_hit DESC, n.sim DESC, n.d
  LIMIT p_limit
$$;
--> statement-breakpoint

-- The place a (possibly merged) place now lives on: itself, or the end of its
-- merge chain. NULL when there is no such place. Public facts only.
CREATE OR REPLACE FUNCTION public.place_redirect_target(p_place_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_id uuid := p_place_id;
  next_id uuid;
  hops integer := 0;
BEGIN
  LOOP
    SELECT p.merged_into_place_id INTO next_id FROM public.places p WHERE p.id = current_id;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    IF next_id IS NULL OR hops >= 16 THEN
      RETURN current_id;
    END IF;
    current_id := next_id;
    hops := hops + 1;
  END LOOP;
END
$$;
--> statement-breakpoint

-- Merge p_loser into p_target (staff, same tenant). One transaction:
--   photos (after the target's own), revisions, saves (one per user), reviews
--   (unless the reviewer already reviewed the target), lead history, pending
--   claims (unless the claimant already has one on the target: rejected as a
--   duplicate) and an approved claim with its store pin move to the target;
--   the loser becomes a redirect (merged_into_place_id, soft-deleted); open
--   duplicate_candidates rows for the pair close as merged; ratings are
--   recomputed; place_merges records what moved; moderation_actions logs it.
-- SQLSTATEs: no_data_found, insufficient_privilege, AE230 (not mergeable:
-- same place, deleted or already merged), AE231 (both have verified owners).
CREATE OR REPLACE FUNCTION public.merge_place(
  p_loser uuid,
  p_target uuid,
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
  v_role text := public.app_role();
  loser public.places%ROWTYPE;
  target public.places%ROWTYPE;
  v_offset integer;
  v_media jsonb;
  v_revisions jsonb;
  v_reviews jsonb;
  v_leads jsonb;
  v_saves jsonb;
  v_claims_moved jsonb;
  v_claims_rejected jsonb;
  v_claim jsonb := NULL;
  v_undo_days integer;
  v_merge uuid;
BEGIN
  IF v_tenant IS NULL OR v_user IS NULL OR NOT public.app_is_staff() THEN
    RAISE EXCEPTION 'merge_place: staff only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Lock both in id order: two merges of the same pair can't deadlock.
  PERFORM 1 FROM public.places p
  WHERE p.id IN (p_loser, p_target) AND p.tenant_id = v_tenant
  ORDER BY p.id FOR UPDATE;
  SELECT * INTO loser FROM public.places WHERE id = p_loser AND tenant_id = v_tenant;
  SELECT * INTO target FROM public.places WHERE id = p_target AND tenant_id = v_tenant;
  IF loser.id IS NULL OR target.id IS NULL THEN
    RAISE EXCEPTION 'merge_place: no such places here' USING ERRCODE = 'no_data_found';
  END IF;
  IF loser.id = target.id
     OR loser.deleted_at IS NOT NULL OR target.deleted_at IS NOT NULL
     OR loser.merged_into_place_id IS NOT NULL OR target.merged_into_place_id IS NOT NULL THEN
    RAISE EXCEPTION 'merge_place: % cannot be merged into %', p_loser, p_target USING ERRCODE = 'AE230';
  END IF;
  IF loser.claim_store_id IS NOT NULL AND target.claim_store_id IS NOT NULL THEN
    RAISE EXCEPTION 'merge_place: both places have verified owners' USING ERRCODE = 'AE231';
  END IF;

  SELECT (ps.value #>> '{}')::integer INTO v_undo_days
  FROM public.platform_settings ps WHERE ps.key = 'merge_undo_days';
  SELECT coalesce((ts.setting_overrides ->> 'merge_undo_days')::integer, v_undo_days) INTO v_undo_days
  FROM (SELECT 1) one LEFT JOIN public.tenant_settings ts ON ts.tenant_id = v_tenant;

  -- Status and ownership columns are trigger-protected (staff/system only),
  -- and revisions move under app.place_merge; both for this function only.
  PERFORM set_config('app.role', 'system', true);
  PERFORM set_config('app.place_merge', 'on', true);

  -- Revisions first, before this transaction writes any of its own.
  WITH moved AS (
    UPDATE public.place_revisions r SET place_id = p_target
    WHERE r.tenant_id = v_tenant AND r.place_id = p_loser
      AND NOT EXISTS (SELECT 1 FROM public.place_revisions t
                      WHERE t.place_id = p_target AND t.xact_id = r.xact_id)
    RETURNING r.id
  )
  SELECT coalesce(jsonb_agg(moved.id), '[]'::jsonb) INTO v_revisions FROM moved;

  -- Photos, after the target's own.
  SELECT coalesce(max(a.sort_order) + 1, 0) INTO v_offset
  FROM public.media_attachments a WHERE a.place_id = p_target;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'sort_order', a.sort_order)), '[]'::jsonb)
    INTO v_media
  FROM public.media_attachments a
  WHERE a.place_id = p_loser
    AND NOT EXISTS (SELECT 1 FROM public.media_attachments t
                    WHERE t.place_id = p_target AND t.media_asset_id = a.media_asset_id);
  UPDATE public.media_attachments a
  SET place_id = p_target, sort_order = a.sort_order + v_offset
  WHERE a.id IN (SELECT (m ->> 'id')::uuid FROM jsonb_array_elements(v_media) m);

  -- Saves: one per user on the target.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'user_id', sp.user_id,
           'new_on_target', NOT EXISTS (SELECT 1 FROM public.saved_places t
                                        WHERE t.tenant_id = v_tenant AND t.place_id = p_target
                                          AND t.user_id = sp.user_id))), '[]'::jsonb)
    INTO v_saves
  FROM public.saved_places sp WHERE sp.tenant_id = v_tenant AND sp.place_id = p_loser;
  INSERT INTO public.saved_places (tenant_id, user_id, place_id)
  SELECT v_tenant, sp.user_id, p_target FROM public.saved_places sp
  WHERE sp.tenant_id = v_tenant AND sp.place_id = p_loser
  ON CONFLICT (tenant_id, user_id, place_id) DO NOTHING;
  DELETE FROM public.saved_places sp WHERE sp.tenant_id = v_tenant AND sp.place_id = p_loser;

  -- Reviews, unless the reviewer already reviewed the target.
  WITH moved AS (
    UPDATE public.reviews r SET place_id = p_target
    WHERE r.tenant_id = v_tenant AND r.place_id = p_loser
      AND NOT EXISTS (SELECT 1 FROM public.reviews t
                      WHERE t.tenant_id = v_tenant AND t.place_id = p_target
                        AND t.reviewer_member_id = r.reviewer_member_id AND t.deleted_at IS NULL)
    RETURNING r.id
  )
  SELECT coalesce(jsonb_agg(moved.id), '[]'::jsonb) INTO v_reviews FROM moved;

  -- Lead history.
  WITH moved AS (
    UPDATE public.lead_events l SET place_id = p_target
    WHERE l.tenant_id = v_tenant AND l.place_id = p_loser
    RETURNING l.id
  )
  SELECT coalesce(jsonb_agg(moved.id), '[]'::jsonb) INTO v_leads FROM moved;

  -- Pending claims follow the place; a claimant already waiting on the target loses the copy.
  WITH rejected AS (
    UPDATE public.place_claims c
    SET status_code = 'rejected', rejection_reason_code = 'duplicate',
        reviewed_by_user_id = v_user, reviewed_at = now()
    WHERE c.tenant_id = v_tenant AND c.place_id = p_loser AND c.status_code = 'pending'
      AND EXISTS (SELECT 1 FROM public.place_claims t
                  WHERE t.tenant_id = v_tenant AND t.place_id = p_target AND t.status_code = 'pending'
                    AND t.claimant_member_id = c.claimant_member_id)
    RETURNING c.id
  )
  SELECT coalesce(jsonb_agg(rejected.id), '[]'::jsonb) INTO v_claims_rejected FROM rejected;
  WITH moved AS (
    UPDATE public.place_claims c SET place_id = p_target
    WHERE c.tenant_id = v_tenant AND c.place_id = p_loser
      AND (c.status_code = 'pending' OR (c.status_code = 'approved' AND loser.claim_store_id IS NOT NULL))
    RETURNING c.id
  )
  SELECT coalesce(jsonb_agg(moved.id), '[]'::jsonb) INTO v_claims_moved FROM moved;

  -- A verified owner and their store pin move with the place.
  IF loser.claim_store_id IS NOT NULL THEN
    v_claim := jsonb_build_object('store_id', loser.claim_store_id, 'member_id', loser.claimed_by_member_id);
    UPDATE public.places SET claimed_by_member_id = NULL, claim_store_id = NULL WHERE id = p_loser;
    UPDATE public.stores SET place_id = p_target, location = target.location WHERE id = loser.claim_store_id;
    UPDATE public.places
    SET claimed_by_member_id = loser.claimed_by_member_id, claim_store_id = loser.claim_store_id
    WHERE id = p_target;
  END IF;

  -- The loser stays as a redirect.
  UPDATE public.places
  SET merged_into_place_id = p_target, merged_at = now(), deleted_at = now()
  WHERE id = p_loser;

  UPDATE public.duplicate_candidates d
  SET status_code = 'merged', resolved_by_user_id = v_user, resolved_at = now()
  WHERE d.status_code = 'open' AND d.entity_type_code = 'place'
    AND ((d.place_id = p_loser AND d.candidate_place_id = p_target)
      OR (d.place_id = p_target AND d.candidate_place_id = p_loser));

  PERFORM public.place_recompute_rating(p_target);
  PERFORM public.place_recompute_rating(p_loser);

  INSERT INTO public.place_merges
    (tenant_id, loser_place_id, target_place_id, merged_by_user_id, reason_code, reason_text, moved, undo_until)
  VALUES (v_tenant, p_loser, p_target, v_user, p_reason_code, p_reason_text,
          jsonb_build_object('media', v_media, 'revisions', v_revisions, 'reviews', v_reviews,
                             'lead_events', v_leads, 'saves', v_saves, 'claims_moved', v_claims_moved,
                             'claims_rejected', v_claims_rejected, 'claim', v_claim),
          now() + make_interval(days => v_undo_days))
  RETURNING id INTO v_merge;

  INSERT INTO public.moderation_actions
    (tenant_id, place_id, actor_user_id, action_code, reason_code, reason_text, evidence_refs)
  VALUES (v_tenant, p_loser, v_user, 'merged', p_reason_code, p_reason_text,
          jsonb_build_array(jsonb_build_object('place_merge_id', v_merge, 'target_place_id', p_target)));

  PERFORM set_config('app.place_merge', '', true);
  PERFORM set_config('app.role', v_role, true);
  RETURN v_merge;
END
$$;
--> statement-breakpoint

-- Undo a merge within its window: everything recorded moves back (as long as
-- it still sits on the target), the loser is restored, the merge is marked
-- undone, moderation_actions logs it. Returns the restored place.
-- SQLSTATEs: no_data_found, insufficient_privilege, AE232 (window passed),
-- AE233 (already undone), AE234 (target gone since: deleted or merged on).
CREATE OR REPLACE FUNCTION public.undo_place_merge(p_merge_id uuid)
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
  v_role text := public.app_role();
  m public.place_merges%ROWTYPE;
  target public.places%ROWTYPE;
  loser public.places%ROWTYPE;
BEGIN
  IF v_tenant IS NULL OR v_user IS NULL OR NOT public.app_is_staff() THEN
    RAISE EXCEPTION 'undo_place_merge: staff only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO m FROM public.place_merges WHERE id = p_merge_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'undo_place_merge: no merge %', p_merge_id USING ERRCODE = 'no_data_found';
  END IF;
  IF m.undone_at IS NOT NULL THEN
    RAISE EXCEPTION 'undo_place_merge: already undone' USING ERRCODE = 'AE233';
  END IF;
  IF now() > m.undo_until THEN
    RAISE EXCEPTION 'undo_place_merge: undo window passed' USING ERRCODE = 'AE232';
  END IF;
  PERFORM 1 FROM public.places p
  WHERE p.id IN (m.loser_place_id, m.target_place_id) ORDER BY p.id FOR UPDATE;
  SELECT * INTO target FROM public.places WHERE id = m.target_place_id;
  SELECT * INTO loser FROM public.places WHERE id = m.loser_place_id;
  IF target.deleted_at IS NOT NULL OR target.merged_into_place_id IS NOT NULL THEN
    RAISE EXCEPTION 'undo_place_merge: the target is gone' USING ERRCODE = 'AE234';
  END IF;

  PERFORM set_config('app.role', 'system', true);
  PERFORM set_config('app.place_merge', 'on', true);

  UPDATE public.place_revisions r SET place_id = m.loser_place_id
  WHERE r.place_id = m.target_place_id
    AND r.id IN (SELECT (x #>> '{}')::uuid FROM jsonb_array_elements(m.moved -> 'revisions') x);

  UPDATE public.media_attachments a
  SET place_id = m.loser_place_id, sort_order = (x ->> 'sort_order')::smallint
  FROM jsonb_array_elements(m.moved -> 'media') x
  WHERE a.id = (x ->> 'id')::uuid AND a.place_id = m.target_place_id;

  INSERT INTO public.saved_places (tenant_id, user_id, place_id)
  SELECT v_tenant, (x ->> 'user_id')::uuid, m.loser_place_id
  FROM jsonb_array_elements(m.moved -> 'saves') x
  ON CONFLICT (tenant_id, user_id, place_id) DO NOTHING;
  DELETE FROM public.saved_places sp
  USING jsonb_array_elements(m.moved -> 'saves') x
  WHERE sp.tenant_id = v_tenant AND sp.place_id = m.target_place_id
    AND sp.user_id = (x ->> 'user_id')::uuid AND (x ->> 'new_on_target')::boolean;

  UPDATE public.reviews r SET place_id = m.loser_place_id
  WHERE r.place_id = m.target_place_id
    AND r.id IN (SELECT (x #>> '{}')::uuid FROM jsonb_array_elements(m.moved -> 'reviews') x);

  UPDATE public.lead_events l SET place_id = m.loser_place_id
  WHERE l.place_id = m.target_place_id
    AND l.id IN (SELECT (x #>> '{}')::uuid FROM jsonb_array_elements(m.moved -> 'lead_events') x);

  UPDATE public.place_claims c SET place_id = m.loser_place_id
  WHERE c.place_id = m.target_place_id
    AND c.id IN (SELECT (x #>> '{}')::uuid FROM jsonb_array_elements(m.moved -> 'claims_moved') x);
  UPDATE public.place_claims c
  SET status_code = 'pending', rejection_reason_code = NULL, reviewed_by_user_id = NULL, reviewed_at = NULL
  WHERE c.status_code = 'rejected' AND c.rejection_reason_code = 'duplicate'
    AND c.id IN (SELECT (x #>> '{}')::uuid FROM jsonb_array_elements(m.moved -> 'claims_rejected') x);

  -- The verified owner goes back, if the target still has that store.
  IF jsonb_typeof(m.moved -> 'claim') = 'object'
     AND target.claim_store_id = (m.moved -> 'claim' ->> 'store_id')::uuid THEN
    UPDATE public.places SET claimed_by_member_id = NULL, claim_store_id = NULL WHERE id = target.id;
    UPDATE public.stores SET place_id = loser.id, location = loser.location WHERE id = target.claim_store_id;
    UPDATE public.places
    SET claimed_by_member_id = (m.moved -> 'claim' ->> 'member_id')::uuid,
        claim_store_id = (m.moved -> 'claim' ->> 'store_id')::uuid
    WHERE id = loser.id;
  END IF;

  UPDATE public.places SET merged_into_place_id = NULL, merged_at = NULL, deleted_at = NULL
  WHERE id = m.loser_place_id;

  UPDATE public.duplicate_candidates d
  SET status_code = 'open', resolved_by_user_id = NULL, resolved_at = NULL
  WHERE d.status_code = 'merged' AND d.entity_type_code = 'place'
    AND ((d.place_id = m.loser_place_id AND d.candidate_place_id = m.target_place_id)
      OR (d.place_id = m.target_place_id AND d.candidate_place_id = m.loser_place_id));

  PERFORM public.place_recompute_rating(m.target_place_id);
  PERFORM public.place_recompute_rating(m.loser_place_id);

  UPDATE public.place_merges SET undone_at = now(), undone_by_user_id = v_user WHERE id = m.id;
  INSERT INTO public.moderation_actions
    (tenant_id, place_id, actor_user_id, action_code, reason_code, evidence_refs)
  VALUES (v_tenant, m.loser_place_id, v_user, 'merge_undone', m.reason_code,
          jsonb_build_array(jsonb_build_object('place_merge_id', m.id, 'target_place_id', m.target_place_id)));

  PERFORM set_config('app.place_merge', '', true);
  PERFORM set_config('app.role', v_role, true);
  RETURN m.loser_place_id;
END
$$;
--> statement-breakpoint

-- rating_avg / rating_count from a place's published reviews.
CREATE OR REPLACE FUNCTION public.place_recompute_rating(p_place_id uuid)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.places p
  SET rating_avg = agg.avg_rating, rating_count = agg.n
  FROM (
    SELECT round(avg(r.rating)::numeric, 2) AS avg_rating, count(*)::integer AS n
    FROM public.reviews r
    WHERE r.place_id = p_place_id AND r.status_code = 'published' AND r.deleted_at IS NULL
  ) agg
  WHERE p.id = p_place_id
$$;
--> statement-breakpoint

RESET ROLE;
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION public.place_duplicate_signals(double precision, double precision, text, text, text, text[], uuid, uuid, integer, text[], real, integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.store_duplicate_signals(double precision, double precision, text, text, text, text[], uuid, integer, text[], real, integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.place_redirect_target(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.merge_place(uuid, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.undo_place_merge(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.place_recompute_rating(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.duplicate_name_key(text, text[]) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.duplicate_name_similarity(text, text, text, text, text, text, text[]) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.place_duplicate_signals(double precision, double precision, text, text, text, text[], uuid, uuid, integer, text[], real, integer) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.store_duplicate_signals(double precision, double precision, text, text, text, text[], uuid, integer, text[], real, integer) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.place_redirect_target(uuid) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.merge_place(uuid, uuid, text, text) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.undo_place_merge(uuid) TO ae_app;
--> statement-breakpoint
-- What the definer functions touch beyond 0042's grants.
GRANT SELECT, UPDATE ON public.media_attachments TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.stores TO ae_rls_bypass;
