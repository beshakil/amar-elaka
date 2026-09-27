-- 0032_saved_items_and_follows
--
-- Saved items and store follows (Q25, schema.md §13.29; ADR 037):
--
--   saved_places, saved_stores   TENANT-SCOPED in the target's tenant, like
--                                saved_posts (0005): the user reads and deletes
--                                their own rows in any tenant context, so "my
--                                saved" is one list across tenants. Insert only
--                                for a target the inserter can see.
--   posts.saved_count            saved_posts rows, and stores.follower_count,
--   stores.follower_count        store_follows rows: kept by triggers (+1/-1,
--                                row-locked, so concurrent saves never lose a
--                                count), backfilled here. Both are search
--                                "noise": a save or follow never reindexes.
--   scrub_post()                 no longer deletes the post's saves: a saved
--                                post never silently disappears. The saved
--                                list shows a scrubbed post as "removed", with
--                                nothing of its content.
--   item_tenant_of(type, id)     which tenant a post/place/store lives in (ids
--                                only, post_tenant_of pattern).
--   my_saved_items(type, before, limit)
--                                the caller's saved items across tenants,
--                                newest first, each with its state (available,
--                                sold, expired, unavailable, deleted, removed,
--                                temporarily_closed, closed) and a card only
--                                where the state allows one.
--   tenant_store_activity(months) average posts per active store per month,
--                                for tenant admins, marketers and platform
--                                staff (a metric to decide on a following
--                                feed later; no feed is built).
--
-- Seeds: settings below; saved rows come from the dev seed (seed.ts).

-- ============================================================================
-- Counter columns
-- ============================================================================

ALTER TABLE public.posts ADD COLUMN saved_count integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE public.posts ADD CONSTRAINT posts_saved_count_ck CHECK (saved_count >= 0);
--> statement-breakpoint
ALTER TABLE public.stores ADD COLUMN follower_count integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE public.stores ADD CONSTRAINT stores_follower_count_ck CHECK (follower_count >= 0);
--> statement-breakpoint

-- ============================================================================
-- saved_places, saved_stores
-- ============================================================================

CREATE TABLE public.saved_places (
  id          uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id   uuid        NOT NULL DEFAULT public.current_tenant_id(),
  user_id     uuid        NOT NULL,
  place_id    uuid        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_places_pk PRIMARY KEY (id),
  CONSTRAINT saved_places_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT saved_places_user_id_fk FOREIGN KEY (user_id)
    REFERENCES public.users (id) ON DELETE CASCADE,
  -- Saves survive the place (§13.31); places are soft-deleted.
  CONSTRAINT saved_places_tenant_id_place_id_fk FOREIGN KEY (tenant_id, place_id)
    REFERENCES public.places (tenant_id, id) ON DELETE RESTRICT
);
--> statement-breakpoint
-- One save per place; also the tenant_id index.
CREATE UNIQUE INDEX saved_places_tenant_user_place_uq ON public.saved_places (tenant_id, user_id, place_id);
--> statement-breakpoint
-- "My saved" across tenants, newest first.
CREATE INDEX saved_places_user_id_idx ON public.saved_places (user_id, id DESC);
--> statement-breakpoint
CREATE INDEX saved_places_tenant_id_place_id_idx ON public.saved_places (tenant_id, place_id);
--> statement-breakpoint
CREATE TRIGGER saved_places_set_updated_at BEFORE UPDATE ON public.saved_places
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE TABLE public.saved_stores (
  id          uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id   uuid        NOT NULL DEFAULT public.current_tenant_id(),
  user_id     uuid        NOT NULL,
  store_id    uuid        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_stores_pk PRIMARY KEY (id),
  CONSTRAINT saved_stores_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT saved_stores_user_id_fk FOREIGN KEY (user_id)
    REFERENCES public.users (id) ON DELETE CASCADE,
  CONSTRAINT saved_stores_tenant_id_store_id_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX saved_stores_tenant_user_store_uq ON public.saved_stores (tenant_id, user_id, store_id);
--> statement-breakpoint
CREATE INDEX saved_stores_user_id_idx ON public.saved_stores (user_id, id DESC);
--> statement-breakpoint
CREATE INDEX saved_stores_tenant_id_store_id_idx ON public.saved_stores (tenant_id, store_id);
--> statement-breakpoint
CREATE TRIGGER saved_stores_set_updated_at BEFORE UPDATE ON public.saved_stores
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

ALTER TABLE public.saved_places ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.saved_places FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.saved_stores ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.saved_stores FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Own rows in any tenant context (§13.29), exactly saved_posts' shape. The
-- insert also needs the target to be visible to the inserter: the EXISTS runs
-- under the inserter's own places/stores policies.
CREATE POLICY saved_places_owner_read ON public.saved_places
  FOR SELECT
  USING (user_id = (SELECT public.current_user_id()) AND (SELECT public.app_is_active_user()));
--> statement-breakpoint
CREATE POLICY saved_places_owner_delete ON public.saved_places
  FOR DELETE
  USING (user_id = (SELECT public.current_user_id()) AND (SELECT public.app_is_active_user()));
--> statement-breakpoint
CREATE POLICY saved_places_owner_insert ON public.saved_places
  FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND user_id = (SELECT public.current_user_id())
    AND (SELECT public.app_is_active_user())
    AND EXISTS (
      SELECT 1 FROM public.places pl
      WHERE pl.id = saved_places.place_id AND pl.tenant_id = saved_places.tenant_id
    )
  );
--> statement-breakpoint
CREATE POLICY saved_places_platform_admin ON public.saved_places
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint
CREATE POLICY saved_stores_owner_read ON public.saved_stores
  FOR SELECT
  USING (user_id = (SELECT public.current_user_id()) AND (SELECT public.app_is_active_user()));
--> statement-breakpoint
CREATE POLICY saved_stores_owner_delete ON public.saved_stores
  FOR DELETE
  USING (user_id = (SELECT public.current_user_id()) AND (SELECT public.app_is_active_user()));
--> statement-breakpoint
CREATE POLICY saved_stores_owner_insert ON public.saved_stores
  FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND user_id = (SELECT public.current_user_id())
    AND (SELECT public.app_is_active_user())
    AND EXISTS (
      SELECT 1 FROM public.stores st
      WHERE st.id = saved_stores.store_id AND st.tenant_id = saved_stores.tenant_id
    )
  );
--> statement-breakpoint
CREATE POLICY saved_stores_platform_admin ON public.saved_stores
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.saved_places, public.saved_stores TO ae_app;
--> statement-breakpoint
GRANT SELECT ON public.saved_places, public.saved_stores, public.store_follows, public.localities
  TO ae_rls_bypass;
--> statement-breakpoint
GRANT UPDATE ON public.stores TO ae_rls_bypass;
--> statement-breakpoint

-- ============================================================================
-- Counter triggers
-- ============================================================================

-- SECURITY DEFINER: the saver may not UPDATE someone else's post (or store).
-- +1/-1 rather than a recount: the UPDATE row-locks the target, and a
-- concurrent save's increment re-reads the latest row version, so no save is
-- lost (a recount's subquery would see its own statement snapshot).
CREATE OR REPLACE FUNCTION public.posts_maintain_saved_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.posts SET saved_count = saved_count + 1
    WHERE tenant_id = NEW.tenant_id AND id = NEW.post_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.posts SET saved_count = greatest(saved_count - 1, 0)
    WHERE tenant_id = OLD.tenant_id AND id = OLD.post_id;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.posts_maintain_saved_count() OWNER TO ae_rls_bypass;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.posts_maintain_saved_count() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER saved_posts_post_saved_count
  AFTER INSERT OR DELETE ON public.saved_posts
  FOR EACH ROW EXECUTE FUNCTION public.posts_maintain_saved_count();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.stores_maintain_follower_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.stores SET follower_count = follower_count + 1
    WHERE tenant_id = NEW.tenant_id AND id = NEW.store_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.stores SET follower_count = greatest(follower_count - 1, 0)
    WHERE tenant_id = OLD.tenant_id AND id = OLD.store_id;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.stores_maintain_follower_count() OWNER TO ae_rls_bypass;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.stores_maintain_follower_count() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER store_follows_store_follower_count
  AFTER INSERT OR DELETE ON public.store_follows
  FOR EACH ROW EXECUTE FUNCTION public.stores_maintain_follower_count();
--> statement-breakpoint

-- ============================================================================
-- Search: the counters are noise (0020)
-- ============================================================================

DROP TRIGGER posts_search_sync ON public.posts;
--> statement-breakpoint
CREATE TRIGGER posts_search_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.search_sync_row('updated_at', 'search_synced_at', 'view_count', 'saved_count');
--> statement-breakpoint
DROP TRIGGER posts_zz_search_carry_synced ON public.posts;
--> statement-breakpoint
CREATE TRIGGER posts_zz_search_carry_synced
  BEFORE UPDATE ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.search_carry_synced('updated_at', 'search_synced_at', 'view_count', 'saved_count');
--> statement-breakpoint
DROP TRIGGER stores_search_sync ON public.stores;
--> statement-breakpoint
CREATE TRIGGER stores_search_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.stores
  FOR EACH ROW EXECUTE FUNCTION public.search_sync_row('updated_at', 'search_synced_at', 'follower_count');
--> statement-breakpoint
-- A follow moves stores.updated_at (set_updated_at); without this the
-- search sweeper (search_synced_at < updated_at) would reindex the store.
CREATE TRIGGER stores_zz_search_carry_synced
  BEFORE UPDATE ON public.stores
  FOR EACH ROW EXECUTE FUNCTION public.search_carry_synced('updated_at', 'search_synced_at', 'follower_count');
--> statement-breakpoint

-- ============================================================================
-- Backfill (without moving updated_at or queueing reindexes, as 0030)
-- ============================================================================

ALTER TABLE public.posts DISABLE TRIGGER posts_set_updated_at;
--> statement-breakpoint
ALTER TABLE public.posts DISABLE TRIGGER posts_search_sync;
--> statement-breakpoint
ALTER TABLE public.posts DISABLE TRIGGER posts_zz_search_carry_synced;
--> statement-breakpoint
UPDATE public.posts p
SET saved_count = s.n
FROM (SELECT tenant_id, post_id, count(*)::integer AS n FROM public.saved_posts GROUP BY 1, 2) s
WHERE p.tenant_id = s.tenant_id AND p.id = s.post_id;
--> statement-breakpoint
ALTER TABLE public.posts ENABLE TRIGGER posts_set_updated_at;
--> statement-breakpoint
ALTER TABLE public.posts ENABLE TRIGGER posts_search_sync;
--> statement-breakpoint
ALTER TABLE public.posts ENABLE TRIGGER posts_zz_search_carry_synced;
--> statement-breakpoint
ALTER TABLE public.stores DISABLE TRIGGER stores_set_updated_at;
--> statement-breakpoint
ALTER TABLE public.stores DISABLE TRIGGER stores_search_sync;
--> statement-breakpoint
ALTER TABLE public.stores DISABLE TRIGGER stores_zz_search_carry_synced;
--> statement-breakpoint
UPDATE public.stores st
SET follower_count = f.n
FROM (SELECT tenant_id, store_id, count(*)::integer AS n FROM public.store_follows GROUP BY 1, 2) f
WHERE st.tenant_id = f.tenant_id AND st.id = f.store_id;
--> statement-breakpoint
ALTER TABLE public.stores ENABLE TRIGGER stores_set_updated_at;
--> statement-breakpoint
ALTER TABLE public.stores ENABLE TRIGGER stores_search_sync;
--> statement-breakpoint
ALTER TABLE public.stores ENABLE TRIGGER stores_zz_search_carry_synced;
--> statement-breakpoint

-- ============================================================================
-- scrub_post: keep the saves
-- ============================================================================

-- Owned by ae_rls_bypass: only it may redefine it (ae_migrator is NOINHERIT,
-- see 0024). The body is 0027's, less `DELETE FROM saved_posts`.
SET LOCAL ROLE ae_rls_bypass;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.scrub_post(p_post_id uuid, p_scrub_reason text, p_deletion_reason text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_post public.posts%ROWTYPE;
  v_seller_user uuid;
  v_keep text[];
  v_purge_days integer;
BEGIN
  SELECT * INTO v_post FROM public.posts WHERE id = p_post_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scrub_post: no post %', p_post_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_post.scrubbed_at IS NOT NULL THEN
    RETURN; -- already scrubbed: idempotent
  END IF;
  IF public.legal_hold_blocks('post', p_post_id) THEN
    RAISE EXCEPTION 'scrub_post: post % is under a legal hold', p_post_id USING ERRCODE = 'AE100';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.moderation_actions ma
    WHERE ma.post_id = p_post_id
      AND ma.action_code IN ('moderator_removed', 'privacy_scrub')
      AND ma.xact_id = pg_current_xact_id()
  ) THEN
    RAISE EXCEPTION 'scrub_post: no moderation_actions row for post % in this transaction', p_post_id
      USING ERRCODE = 'AE101';
  END IF;
  IF p_deletion_reason IS NOT NULL AND p_deletion_reason <> 'moderator_removed' THEN
    RAISE EXCEPTION 'scrub_post: deletion reason must be moderator_removed or NULL' USING ERRCODE = 'AE102';
  END IF;

  SELECT tm.user_id INTO v_seller_user FROM public.tenant_members tm
  WHERE tm.tenant_id = v_post.tenant_id AND tm.id = v_post.author_member_id;

  -- Analytics whitelist: the generated columns' keys plus the schema's own.
  SELECT ARRAY['price', 'bedrooms', 'seats', 'area'] || coalesce(s.analytics_fields, '{}')
    INTO v_keep
  FROM public.category_field_schemas s WHERE s.id = v_post.field_schema_id;

  -- Messages first, while conversations still point at the post.
  UPDATE public.messages m SET listing_snapshot = '{"state": "listing_removed"}'::jsonb
  WHERE m.listing_snapshot IS NOT NULL
    AND m.conversation_id IN (SELECT c.id FROM public.conversations c WHERE c.post_id = p_post_id);
  UPDATE public.conversations SET post_id = NULL, post_context_removed = true WHERE post_id = p_post_id;
  -- saved_posts rows stay (0032, ADR 037): the saver's list shows the post as
  -- "removed", and my_saved_items gives nothing of a scrubbed post's content.
  UPDATE public.reviews SET post_id = NULL WHERE post_id = p_post_id;
  UPDATE public.lead_events SET subject_scrubbed = true WHERE post_id = p_post_id;
  UPDATE public.lead_daily_stats SET subject_scrubbed = true WHERE post_id = p_post_id;

  UPDATE public.posts p SET
    title = '',
    description = NULL,
    fields = coalesce(
      (SELECT jsonb_object_agg(f.key, f.value) FROM jsonb_each(p.fields) f WHERE f.key = ANY (v_keep)),
      '{}'::jsonb),
    contact_phone_e164 = NULL,
    contact_name = NULL,
    author_member_id = NULL,
    store_id = NULL,
    locality_id = NULL,
    location = NULL,
    geo_area_id = NULL,
    deleted_by_user_id = CASE WHEN p.deleted_by_user_id = v_seller_user THEN NULL ELSE p.deleted_by_user_id END,
    scrubbed_at = now(),
    scrub_reason = p_scrub_reason,
    deleted_at = CASE WHEN p_deletion_reason IS NULL THEN p.deleted_at ELSE coalesce(p.deleted_at, now()) END,
    deletion_reason_code = coalesce(p_deletion_reason, p.deletion_reason_code)
  WHERE p.id = p_post_id;

  -- Photos go now (scrub_media_purge_days). posts_soft_delete_media already
  -- did this if the UPDATE above first set deleted_at; a post deleted
  -- earlier needs it here, with the scrub's purge window.
  SELECT (value #>> '{}')::integer INTO v_purge_days
  FROM public.platform_settings WHERE key = 'scrub_media_purge_days';
  UPDATE public.media_assets m
  SET deleted_at = coalesce(m.deleted_at, now()),
      purge_due_at = CASE WHEN m.evidence_hold THEN NULL ELSE now() + make_interval(days => v_purge_days) END
  WHERE m.tenant_id = v_post.tenant_id
    AND m.id IN (SELECT a.media_asset_id FROM public.media_attachments a WHERE a.post_id = p_post_id)
    AND NOT public.media_asset_is_referenced(m.id, m.storage_key, p_post_id);
END;
$$;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint

-- ============================================================================
-- item_tenant_of
-- ============================================================================

CREATE OR REPLACE FUNCTION public.item_tenant_of(p_item_type text, p_item_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT CASE p_item_type
    WHEN 'post' THEN (
      SELECT p.tenant_id FROM public.posts p
      WHERE p.id = p_item_id AND p.deletion_reason_code IS DISTINCT FROM 'legal_hold')
    WHEN 'place' THEN (SELECT pl.tenant_id FROM public.places pl WHERE pl.id = p_item_id)
    WHEN 'store' THEN (SELECT st.tenant_id FROM public.stores st WHERE st.id = p_item_id)
  END
$$;
--> statement-breakpoint

-- ============================================================================
-- my_saved_items
-- ============================================================================

-- The caller's own saves (current_user_id(), from the verified JWT) across
-- tenants: saved_posts ∪ saved_places ∪ saved_stores, newest first (uuid v7
-- ids sort by time), keyset-paged by p_before. A saved item never drops out:
-- its state says what became of it. Card data (price, cover, area) only for
-- a state a buyer may still look at; a title while the item exists and
-- wasn't taken down; nothing at all for a removed post.
CREATE OR REPLACE FUNCTION public.my_saved_items(p_item_type text, p_before uuid, p_limit integer)
RETURNS TABLE (
  save_id          uuid,
  item_type        text,
  item_id          uuid,
  tenant_id        uuid,
  saved_at         timestamptz,
  state            text,
  name_bn          text,
  name_en          text,
  slug             text,
  price            text,
  price_type_code  text,
  cover_variants   jsonb,
  cover_thumbhash  text,
  area_bn          text,
  area_en          text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH me AS (SELECT public.current_user_id() AS user_id),
  saved AS (
    SELECT sp.id, 'post'::text AS item_type, sp.post_id AS item_id, sp.tenant_id, sp.created_at
    FROM public.saved_posts sp, me
    WHERE sp.user_id = me.user_id AND (p_item_type IS NULL OR p_item_type = 'post')
      AND (p_before IS NULL OR sp.id < p_before)
    UNION ALL
    SELECT sv.id, 'place', sv.place_id, sv.tenant_id, sv.created_at
    FROM public.saved_places sv, me
    WHERE sv.user_id = me.user_id AND (p_item_type IS NULL OR p_item_type = 'place')
      AND (p_before IS NULL OR sv.id < p_before)
    UNION ALL
    SELECT ss.id, 'store', ss.store_id, ss.tenant_id, ss.created_at
    FROM public.saved_stores ss, me
    WHERE ss.user_id = me.user_id AND (p_item_type IS NULL OR p_item_type = 'store')
      AND (p_before IS NULL OR ss.id < p_before)
  ),
  page AS (
    SELECT * FROM saved ORDER BY id DESC LIMIT greatest(p_limit, 0)
  ),
  resolved AS (
    SELECT
      pg.id, pg.item_type, pg.item_id, pg.tenant_id, pg.created_at,
      CASE pg.item_type
        WHEN 'post' THEN CASE
          WHEN p.scrubbed_at IS NOT NULL OR p.status_code = 'removed' THEN 'removed'
          WHEN p.deleted_at IS NOT NULL THEN 'deleted'
          WHEN p.status_code = 'sold' THEN 'sold'
          WHEN p.status_code = 'expired' THEN 'expired'
          WHEN p.status_code = 'live' AND NOT p.hidden_by_owner THEN 'available'
          ELSE 'unavailable' END
        WHEN 'place' THEN CASE
          WHEN pl.deleted_at IS NOT NULL THEN 'unavailable'
          WHEN pl.status_code = 'published' THEN 'available'
          WHEN pl.status_code = 'temporarily_closed' THEN 'temporarily_closed'
          WHEN pl.status_code = 'permanently_closed' THEN 'closed'
          ELSE 'unavailable' END
        ELSE CASE
          WHEN st.deleted_at IS NULL AND st.status_code = 'active' THEN 'available'
          WHEN st.deleted_at IS NULL AND st.status_code = 'closed' THEN 'closed'
          ELSE 'unavailable' END
      END AS state,
      p.title, p.price::text AS price, p.price_type_code,
      pl.name_bn AS place_name_bn, pl.name_en AS place_name_en, pl.slug AS place_slug,
      st.name_bn AS store_name_bn, st.name_en AS store_name_en, st.slug AS store_slug, st.cover_media_id,
      st.logo_media_id,
      coalesce(p.locality_id, pl.locality_id, st.locality_id) AS locality_id,
      coalesce(p.geo_area_id, pl.geo_area_id) AS geo_area_id
    FROM page pg
    LEFT JOIN public.posts p ON pg.item_type = 'post' AND p.tenant_id = pg.tenant_id AND p.id = pg.item_id
    LEFT JOIN public.places pl ON pg.item_type = 'place' AND pl.tenant_id = pg.tenant_id AND pl.id = pg.item_id
    LEFT JOIN public.stores st ON pg.item_type = 'store' AND st.tenant_id = pg.tenant_id AND st.id = pg.item_id
  )
  SELECT
    r.id, r.item_type, r.item_id, r.tenant_id, r.created_at, r.state,
    CASE
      WHEN r.state = 'removed' THEN NULL
      WHEN r.item_type = 'post' THEN r.title
      WHEN r.item_type = 'place' THEN r.place_name_bn
      ELSE r.store_name_bn
    END,
    CASE r.item_type WHEN 'place' THEN r.place_name_en WHEN 'store' THEN r.store_name_en END,
    CASE WHEN r.state = 'available' OR r.state IN ('temporarily_closed', 'closed')
      THEN coalesce(r.place_slug, r.store_slug) END,
    CASE WHEN r.state IN ('available', 'sold', 'expired') THEN r.price END,
    CASE WHEN r.state IN ('available', 'sold', 'expired') THEN r.price_type_code END,
    cover.variants,
    cover.thumbhash,
    CASE WHEN r.state IN ('available', 'sold', 'expired', 'temporarily_closed', 'closed')
      THEN coalesce(l.name_bn, ga.name_bn) END,
    CASE WHEN r.state IN ('available', 'sold', 'expired', 'temporarily_closed', 'closed')
      THEN coalesce(l.name_en, ga.name_en) END
  FROM resolved r
  LEFT JOIN public.localities l ON l.tenant_id = r.tenant_id AND l.id = r.locality_id
  LEFT JOIN public.geo_areas ga ON ga.id = r.geo_area_id
  LEFT JOIN LATERAL (
    SELECT m.variants, m.thumbhash
    FROM public.media_assets m
    WHERE r.state IN ('available', 'sold', 'expired', 'temporarily_closed', 'closed')
      AND m.tenant_id = r.tenant_id
      AND m.status_code = 'ready' AND m.visibility_code = 'public' AND m.deleted_at IS NULL
      AND (
        (r.item_type = 'store' AND m.id = coalesce(r.cover_media_id, r.logo_media_id))
        OR (r.item_type <> 'store' AND m.id = (
          SELECT a.media_asset_id FROM public.media_attachments a
          WHERE a.tenant_id = r.tenant_id
            AND ((r.item_type = 'post' AND a.post_id = r.item_id)
                 OR (r.item_type = 'place' AND a.place_id = r.item_id))
          ORDER BY a.sort_order
          LIMIT 1))
      )
    LIMIT 1
  ) cover ON true
  ORDER BY r.id DESC
$$;
--> statement-breakpoint

-- ============================================================================
-- tenant_store_activity
-- ============================================================================

-- Per Dhaka calendar month, newest first: stores active in the tenant (active
-- now, not deleted, created by the month's end — there is no status history,
-- so a store closed since doesn't count for earlier months either), how many
-- of them published at least one post that month, their posts, and the
-- averages. The metric that decides on a following feed later (ADR 037).
-- p_months is clamped to store_activity_months_max.
CREATE OR REPLACE FUNCTION public.tenant_store_activity(p_months integer)
RETURNS TABLE (
  month                        date,
  active_stores                integer,
  posting_stores               integer,
  store_posts                  integer,
  avg_posts_per_active_store   numeric,
  avg_posts_per_posting_store  numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_max integer;
BEGIN
  IF v_tenant IS NULL
     OR NOT (public.app_is_tenant_admin() OR public.app_role() = 'marketer' OR public.app_is_platform()) THEN
    RAISE EXCEPTION 'tenant_store_activity: tenant admins, marketers and platform staff only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT (ps.value #>> '{}')::integer INTO v_max
  FROM public.platform_settings ps WHERE ps.key = 'store_activity_months_max';
  IF v_max IS NULL THEN
    RAISE EXCEPTION 'platform setting store_activity_months_max is missing';
  END IF;

  RETURN QUERY
  WITH bounds AS (
    SELECT m.month_start,
           (m.month_start::timestamp AT TIME ZONE 'Asia/Dhaka') AS from_ts,
           ((m.month_start + interval '1 month')::timestamp AT TIME ZONE 'Asia/Dhaka') AS to_ts
    FROM (
      SELECT (date_trunc('month', now() AT TIME ZONE 'Asia/Dhaka') - make_interval(months => g))::date AS month_start
      FROM generate_series(0, least(greatest(p_months, 1), v_max) - 1) AS g
    ) m
  ),
  per_store AS (
    SELECT b.month_start, s.id AS store_id,
           (SELECT count(*) FROM public.posts p
            WHERE p.tenant_id = v_tenant AND p.store_id = s.id
              AND p.published_at >= b.from_ts AND p.published_at < b.to_ts) AS n
    FROM bounds b
    JOIN public.stores s
      ON s.tenant_id = v_tenant AND s.status_code = 'active' AND s.deleted_at IS NULL AND s.created_at < b.to_ts
  )
  SELECT b.month_start,
         count(ps.store_id)::integer,
         (count(ps.store_id) FILTER (WHERE ps.n > 0))::integer,
         coalesce(sum(ps.n), 0)::integer,
         round(coalesce(sum(ps.n), 0)::numeric / nullif(count(ps.store_id), 0), 2),
         round(coalesce(sum(ps.n), 0)::numeric / nullif(count(ps.store_id) FILTER (WHERE ps.n > 0), 0), 2)
  FROM bounds b
  LEFT JOIN per_store ps ON ps.month_start = b.month_start
  GROUP BY b.month_start
  ORDER BY b.month_start DESC;
END
$$;
--> statement-breakpoint

ALTER FUNCTION public.item_tenant_of(text, uuid) OWNER TO ae_rls_bypass;
--> statement-breakpoint
ALTER FUNCTION public.my_saved_items(text, uuid, integer) OWNER TO ae_rls_bypass;
--> statement-breakpoint
ALTER FUNCTION public.tenant_store_activity(integer) OWNER TO ae_rls_bypass;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.item_tenant_of(text, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.my_saved_items(text, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.tenant_store_activity(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.item_tenant_of(text, uuid) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.my_saved_items(text, uuid, integer) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.tenant_store_activity(integer) TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- Settings (CLAUDE.md rule 9)
-- ============================================================================

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('saved_page_size_default', '20', 'integer', 'count', 1, 100, 'none',
   'Saved items per page when GET /saved gives no limit.'),
  ('saved_page_size_max', '50', 'integer', 'count', 1, 100, 'none',
   'Most saved items one GET /saved page returns.'),
  ('store_activity_months_default', '6', 'integer', 'months', 1, 60, 'none',
   'Months the store-activity analytics returns when none are asked for.'),
  ('store_activity_months_max', '24', 'integer', 'months', 1, 60, 'none',
   'Most months the store-activity analytics returns (also clamps tenant_store_activity in the database).');
