-- 0050_stores_module
--
-- The stores module (ADR 054): a store belongs to one tenant, has one owner
-- member and optional staff, a map pin (its place), hours (0044, reused) and
-- a catalog (posts.store_id). What existed since 0006/0042/0044 stays; this
-- migration fills the gaps the module needs.
--
--   store_tiers            NEW lookup: basic | pro | premium. Limits per tier
--                          are settings (store_staff_max_<tier>,
--                          store_catalog_max_<tier>); everyone is basic until
--                          paid tiers (week 17). Nothing here sells a tier.
--   store_member_roles     + editor (posts as the store, nothing else);
--                          'staff' retired (is_active = false), its rows
--                          became editors. manager = everything but the slug
--                          and managers.
--   stores                 + tier_code, category_id, slug_changed_at,
--                          previous_slug; 'me' and 'review-queue' are never slugs
--                          (they are routes under /stores).
--                          stores_b_protect_tier_and_slug: only staff/system
--                          move the tier; the slug changes once (the old one is
--                          kept for redirects), enforced here, not just in TS.
--   posts.store_hidden     the post's store is not active (suspended, closed,
--                          pending, deleted). Kept by posts_c_maintain_store_hidden
--                          (insert, or a change of store_id / store_hidden) and
--                          stores_propagate_hidden (a store's status change).
--   post_is_listed()       takes store_hidden: a suspended store's posts leave
--                          the feed, map, search, heatmap and nearby discovery
--                          through the ONE visibility rule. The old 6-argument
--                          version is dropped so nothing can skip the check.
--                          feed_posts, map_features, heatmap_cells and
--                          discover_nearby below are their current bodies
--                          (pg_get_functiondef) with the new argument; partial
--                          indexes still match (they don't mention it).
--   map_features()         also: a place that is a store's pin is drawn once,
--                          as the store (it was drawn twice since claims,
--                          0042); stores now honour the category filter.
--   moderation_actions     + store_id target (exactly one target, as 0042);
--                          action types store_suspended / store_reinstated /
--                          store_closed (rule 13: every status change by
--                          moderation writes one, in the same transaction).
--   create_store()         store + its map pin (claimed, linked both ways) +
--                          logo/banner attachments in one transaction; the
--                          per-owner limit under the membership row's lock.
--   member_may_post_as_store()  THE "may post as this store" rule; the 0006
--                          posts trigger now calls it (SQLSTATE AE246), and so
--                          does store_posting_facts() for the API's checks.
--   my_stores()            the caller's owned and staffed stores, every tenant.
--   store_staff()          a store's staff for its owner and managers.
--   store_slug_available() no store here uses it as its slug or old slug.
--   store_members          + store_members_self_delete: leave, or decline.
--   places                 + places_store_manager_update: a store's managers
--                          edit its pin (kept in step with the store).
--   store_invite_staff()   one transaction: caller may invite (owner: any
--                          role; manager: editors), staff limit under the
--                          store's row lock, the invitee's account and
--                          membership in the store's tenant, the pending
--                          store_members row.
--   notification types     store_staff_invited, store_suspended, store_reinstated.
--   RBAC                   moderator: stores read + approve (status changes).
--   settings               store_max_per_owner, store_staff_max_<tier>,
--                          store_catalog_max_<tier>, store_description_max_length.
--
-- No column is dropped or renamed. The only dropped object is the 6-argument
-- post_is_listed(), replaced in this file.
-- Seeds: lookups and settings here; the dev seed gives stores categories and
-- an editor. Tests: apps/api/test/stores.db-spec.ts, stores.e2e-spec.ts,
-- rls-stores.db-spec.ts (store_tiers), post-visibility.db-spec.ts.

-- Lookup and settings tables are FORCE RLS with platform-admin-only writes;
-- this transaction-local flag lets the INSERTs below through (as 0042).
SELECT set_config('app.is_platform_admin', 'true', true);
--> statement-breakpoint

-- ---- 1. Lookups --------------------------------------------------------------

CREATE TABLE public.store_tiers (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_tiers_pk PRIMARY KEY (code),
  CONSTRAINT store_tiers_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER store_tiers_set_updated_at BEFORE UPDATE ON public.store_tiers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
ALTER TABLE public.store_tiers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.store_tiers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY store_tiers_read_all ON public.store_tiers FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY store_tiers_platform_admin ON public.store_tiers
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.store_tiers TO ae_app;
--> statement-breakpoint
GRANT SELECT ON public.store_tiers TO ae_rls_bypass;
--> statement-breakpoint
INSERT INTO public.store_tiers (code, label_key, sort_order) VALUES
  ('basic',   'enum.store_tiers.basic',   10),
  ('pro',     'enum.store_tiers.pro',     20),
  ('premium', 'enum.store_tiers.premium', 30);
--> statement-breakpoint

INSERT INTO public.store_member_roles (code, label_key, sort_order) VALUES
  ('editor', 'enum.store_member_roles.editor', 15);
--> statement-breakpoint
UPDATE public.store_member_roles SET is_active = false WHERE code = 'staff';
--> statement-breakpoint

INSERT INTO public.moderation_action_types (code, label_key, sort_order) VALUES
  ('store_suspended',  'enum.moderation_action_types.store_suspended',  400),
  ('store_reinstated', 'enum.moderation_action_types.store_reinstated', 410),
  ('store_closed',     'enum.moderation_action_types.store_closed',     420);
--> statement-breakpoint

INSERT INTO public.notification_types (code, label_key, sort_order) VALUES
  ('store_staff_invited', 'enum.notification_types.store_staff_invited', 300),
  ('store_suspended',     'enum.notification_types.store_suspended',     310),
  ('store_reinstated',    'enum.notification_types.store_reinstated',    320);
--> statement-breakpoint

-- ---- 2. Stores ------------------------------------------------------------------

ALTER TABLE public.stores
  ADD COLUMN tier_code text NOT NULL DEFAULT 'basic',
  ADD COLUMN category_id uuid,
  ADD COLUMN slug_changed_at timestamptz,
  ADD COLUMN previous_slug text;
--> statement-breakpoint
ALTER TABLE public.stores
  ADD CONSTRAINT stores_tier_code_fk FOREIGN KEY (tier_code)
    REFERENCES public.store_tiers (code) ON DELETE RESTRICT,
  ADD CONSTRAINT stores_category_id_fk FOREIGN KEY (category_id)
    REFERENCES public.categories (id) ON DELETE RESTRICT,
  -- GET /stores/me and /stores/review-queue must never be a store's page.
  ADD CONSTRAINT stores_slug_not_reserved_ck CHECK (slug NOT IN ('me', 'review-queue')),
  ADD CONSTRAINT stores_previous_slug_ck CHECK (previous_slug IS NULL OR previous_slug = lower(previous_slug));
--> statement-breakpoint
CREATE INDEX stores_category_id_idx ON public.stores (category_id) WHERE category_id IS NOT NULL;
--> statement-breakpoint
-- An old link (/stores/<previous slug>) still finds the store.
CREATE INDEX stores_tenant_id_previous_slug_idx ON public.stores (tenant_id, previous_slug)
  WHERE previous_slug IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint

-- Tier: staff/system only (paid tiers arrive with billing). Slug: changes
-- once — the change stamps slug_changed_at and keeps the old slug; a second
-- change is refused (AE240). Staff and the system may always fix a slug.
CREATE OR REPLACE FUNCTION public.stores_protect_tier_and_slug()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  privileged boolean := public.app_is_staff() OR public.app_is_system();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT privileged THEN
      NEW.tier_code := 'basic';
      NEW.slug_changed_at := NULL;
      NEW.previous_slug := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF NOT privileged THEN
    NEW.tier_code := OLD.tier_code;
  END IF;
  IF NEW.slug IS DISTINCT FROM OLD.slug THEN
    IF OLD.slug_changed_at IS NOT NULL AND NOT privileged THEN
      RAISE EXCEPTION 'stores: the slug of % was already changed once', OLD.id USING ERRCODE = 'AE240';
    END IF;
    NEW.slug_changed_at := now();
    NEW.previous_slug := OLD.slug;
  ELSIF NOT privileged THEN
    NEW.slug_changed_at := OLD.slug_changed_at;
    NEW.previous_slug := OLD.previous_slug;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER stores_b_protect_tier_and_slug BEFORE INSERT OR UPDATE ON public.stores
  FOR EACH ROW EXECUTE FUNCTION public.stores_protect_tier_and_slug();
--> statement-breakpoint

-- ---- 3. Staff roles -------------------------------------------------------------

UPDATE public.store_members SET role_code = 'editor' WHERE role_code = 'staff';
--> statement-breakpoint
ALTER TABLE public.store_members ALTER COLUMN role_code SET DEFAULT 'editor';
--> statement-breakpoint

-- Invites a member of staff by phone (ADR 054). The caller must be the
-- store's owner (any role) or an accepted manager (editors only). The staff
-- limit (p_max_staff, store_staff_max_<tier>, read by the service) counts
-- pending invites too, checked under the store's row lock so two concurrent
-- invites can't both pass. The invitee gets an account if the phone has none
-- (unverified until they sign in, like any new number) and a membership in
-- the store's tenant; nothing is visible to them until they accept.
-- SQLSTATEs: AE241 not allowed, AE242 store not active, AE243 limit reached,
-- AE244 already the owner or on the staff, AE245 a banned or terminated number.
CREATE OR REPLACE FUNCTION public.store_invite_staff(
  p_store_id uuid,
  p_phone text,
  p_role text,
  p_max_staff integer
)
RETURNS TABLE (store_member_id uuid, member_id uuid, user_id uuid, user_created boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_member uuid := public.current_member_id();
  st public.stores%ROWTYPE;
  v_caller_role text;
  v_count integer;
  v_user uuid;
  v_created boolean := false;
  v_target uuid;
  v_row uuid;
BEGIN
  IF v_tenant IS NULL OR v_member IS NULL THEN
    RAISE EXCEPTION 'store_invite_staff: no caller' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_role NOT IN ('manager', 'editor') THEN
    RAISE EXCEPTION 'store_invite_staff: role % cannot be invited', p_role USING ERRCODE = 'AE241';
  END IF;

  SELECT * INTO st FROM public.stores s
  WHERE s.id = p_store_id AND s.tenant_id = v_tenant AND s.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'store_invite_staff: no store %', p_store_id USING ERRCODE = 'no_data_found';
  END IF;

  IF st.owner_member_id = v_member THEN
    v_caller_role := 'owner';
  ELSE
    SELECT sm.role_code INTO v_caller_role FROM public.store_members sm
    WHERE sm.tenant_id = v_tenant AND sm.store_id = st.id AND sm.member_id = v_member
      AND sm.accepted_at IS NOT NULL;
  END IF;
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'manager')
     OR (v_caller_role = 'manager' AND p_role = 'manager') THEN
    RAISE EXCEPTION 'store_invite_staff: not allowed' USING ERRCODE = 'AE241';
  END IF;
  IF st.status_code <> 'active' THEN
    RAISE EXCEPTION 'store_invite_staff: store % is %', st.id, st.status_code USING ERRCODE = 'AE242';
  END IF;

  SELECT count(*) INTO v_count FROM public.store_members sm
  WHERE sm.tenant_id = v_tenant AND sm.store_id = st.id;
  IF v_count >= p_max_staff THEN
    RAISE EXCEPTION 'store_invite_staff: limit % reached', p_max_staff USING ERRCODE = 'AE243';
  END IF;

  SELECT u.id INTO v_user FROM public.users u WHERE u.phone_e164 = p_phone AND u.deleted_at IS NULL;
  IF v_user IS NULL THEN
    IF public.active_blacklist_severity(NULL, p_phone) IN ('banned', 'terminated') THEN
      RAISE EXCEPTION 'store_invite_staff: number refused' USING ERRCODE = 'AE245';
    END IF;
    INSERT INTO public.users (phone_e164) VALUES (p_phone) RETURNING id INTO v_user;
    -- The same digits-only placeholder name as auth_resolve_or_create_by_phone (0013).
    INSERT INTO public.user_profiles (user_id, display_name) VALUES (v_user, right(p_phone, 4));
    v_created := true;
  ELSIF public.active_blacklist_severity(v_user, p_phone) IN ('banned', 'terminated') THEN
    RAISE EXCEPTION 'store_invite_staff: number refused' USING ERRCODE = 'AE245';
  END IF;

  INSERT INTO public.tenant_members AS tm (tenant_id, user_id, role_code)
  VALUES (v_tenant, v_user, 'member')
  ON CONFLICT (user_id, tenant_id) DO NOTHING;
  SELECT tm.id INTO v_target FROM public.tenant_members tm
  WHERE tm.tenant_id = v_tenant AND tm.user_id = v_user;

  IF v_target = st.owner_member_id THEN
    RAISE EXCEPTION 'store_invite_staff: the owner' USING ERRCODE = 'AE244';
  END IF;
  INSERT INTO public.store_members (tenant_id, store_id, member_id, role_code, invited_by_member_id)
  VALUES (v_tenant, st.id, v_target, p_role, v_member)
  ON CONFLICT (tenant_id, store_id, member_id) DO NOTHING
  RETURNING id INTO v_row;
  IF v_row IS NULL THEN
    RAISE EXCEPTION 'store_invite_staff: already on the staff' USING ERRCODE = 'AE244';
  END IF;

  RETURN QUERY SELECT v_row, v_target, v_user, v_created;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.store_invite_staff(uuid, text, text, integer) OWNER TO ae_rls_bypass;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.store_invite_staff(uuid, text, text, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.store_invite_staff(uuid, text, text, integer) TO ae_app;
--> statement-breakpoint

-- ---- 4. A store's status reaches its posts --------------------------------------

ALTER TABLE public.posts ADD COLUMN store_hidden boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- Whether a store's posts are out of discovery. The one place this is decided.
CREATE OR REPLACE FUNCTION public.store_hides_posts(p_status text, p_deleted_at timestamptz)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURN p_status <> 'active' OR p_deleted_at IS NOT NULL;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.store_hides_posts(text, timestamptz) TO ae_app, ae_rls_bypass;
--> statement-breakpoint

-- On insert, or when store_id or store_hidden is written: the flag is always
-- recomputed from the store, so an author can't clear it. SECURITY DEFINER:
-- the author can't see a suspended store through RLS.
CREATE OR REPLACE FUNCTION public.posts_maintain_store_hidden()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.store_id IS NULL THEN
    NEW.store_hidden := false;
  ELSE
    SELECT public.store_hides_posts(s.status_code, s.deleted_at) INTO NEW.store_hidden
    FROM public.stores s WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.store_id;
    NEW.store_hidden := coalesce(NEW.store_hidden, false);
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.posts_maintain_store_hidden() OWNER TO ae_rls_bypass;
--> statement-breakpoint
CREATE TRIGGER posts_c_maintain_store_hidden
  BEFORE INSERT OR UPDATE OF store_id, store_hidden ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.posts_maintain_store_hidden();
--> statement-breakpoint

-- A store's status or deletion changed: its posts follow. The posts' search
-- sync trigger queues them, so search drops (or restores) them too.
CREATE OR REPLACE FUNCTION public.stores_propagate_hidden()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_hidden boolean := public.store_hides_posts(NEW.status_code, NEW.deleted_at);
BEGIN
  UPDATE public.posts p
  SET store_hidden = v_hidden
  WHERE p.tenant_id = NEW.tenant_id AND p.store_id = NEW.id AND p.store_hidden IS DISTINCT FROM v_hidden;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.stores_propagate_hidden() OWNER TO ae_rls_bypass;
--> statement-breakpoint
CREATE TRIGGER stores_propagate_hidden
  AFTER UPDATE OF status_code, deleted_at ON public.stores
  FOR EACH ROW
  WHEN (OLD.status_code IS DISTINCT FROM NEW.status_code OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public.stores_propagate_hidden();
--> statement-breakpoint

UPDATE public.posts p
SET store_hidden = true
FROM public.stores s
WHERE s.tenant_id = p.tenant_id AND s.id = p.store_id
  AND public.store_hides_posts(s.status_code, s.deleted_at);
--> statement-breakpoint

-- ---- 5. The visibility rule takes the store ------------------------------------

-- THE rule for "listed" (0049) plus the store: a post of a suspended, closed
-- or deleted store is not listed.
CREATE FUNCTION public.post_is_listed(
  p_status text,
  p_deleted_at timestamptz,
  p_scrubbed_at timestamptz,
  p_hidden boolean,
  p_store_hidden boolean,
  p_expires_at timestamptz,
  p_at timestamptz
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURN p_status = 'live' AND p_deleted_at IS NULL AND p_scrubbed_at IS NULL AND NOT p_hidden
       AND NOT p_store_hidden
       AND (p_expires_at IS NULL OR p_expires_at > p_at);
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.post_is_listed(text, timestamptz, timestamptz, boolean, boolean, timestamptz, timestamptz)
  TO ae_app, ae_rls_bypass;
--> statement-breakpoint

-- ---- 6. Moderation can target a store ------------------------------------------

ALTER TABLE public.moderation_actions ADD COLUMN store_id uuid;
--> statement-breakpoint
ALTER TABLE public.moderation_actions
  ADD CONSTRAINT moderation_actions_tenant_id_store_id_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
-- Exactly one target; the 0042 check is replaced (no column dropped).
ALTER TABLE public.moderation_actions DROP CONSTRAINT moderation_actions_one_target_ck;
--> statement-breakpoint
ALTER TABLE public.moderation_actions
  ADD CONSTRAINT moderation_actions_one_target_ck
    CHECK (num_nonnulls(post_id, place_id, place_claim_id, store_id) = 1);
--> statement-breakpoint
CREATE INDEX moderation_actions_tenant_store_idx ON public.moderation_actions (tenant_id, store_id, id DESC)
  WHERE store_id IS NOT NULL;
--> statement-breakpoint

-- ---- 7. Settings and permissions ------------------------------------------------

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('store_max_per_owner', '3', 'integer', 'stores', 1, 50, 'platform',
   'How many stores one member may own in a tenant (any status but deleted).'),
  ('store_staff_max_basic', '2', 'integer', 'people', 0, 100, 'platform',
   'Staff (managers and editors, invited or accepted) a basic-tier store may have.'),
  ('store_staff_max_pro', '5', 'integer', 'people', 0, 100, 'platform',
   'Staff (managers and editors, invited or accepted) a pro-tier store may have.'),
  ('store_staff_max_premium', '15', 'integer', 'people', 0, 100, 'platform',
   'Staff (managers and editors, invited or accepted) a premium-tier store may have.'),
  ('store_catalog_max_basic', '50', 'integer', 'posts', 1, 100000, 'platform',
   'Posts a basic-tier store may hold at once (draft, in review or live).'),
  ('store_catalog_max_pro', '300', 'integer', 'posts', 1, 100000, 'platform',
   'Posts a pro-tier store may hold at once (draft, in review or live).'),
  ('store_catalog_max_premium', '2000', 'integer', 'posts', 1, 100000, 'platform',
   'Posts a premium-tier store may hold at once (draft, in review or live).'),
  ('store_description_max_length', '1000', 'integer', 'characters', 50, 5000, 'platform',
   'How long a store''s description may be (its name follows place_name_max_length: it is also its map pin''s name).');
--> statement-breakpoint

INSERT INTO public.role_permissions (role_id, module, action)
SELECT r.id, grant_row.module, grant_row.action
FROM public.roles r
JOIN (VALUES
  ('moderator', 'stores', 'read'), ('moderator', 'stores', 'approve')
) AS grant_row (role_code, module, action) ON grant_row.role_code = r.code
WHERE r.tenant_id IS NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ---- 7b. Creating a store, posting as a store, "my stores" -----------------------

-- Creates a store and its map pin in one transaction (ADR 054). The service
-- has already checked the category (a place category enabled here), the
-- media (the caller's own ready, unattached images in this tenant), the slug
-- and the trust gate (p_live); this function does the writes the caller's
-- RLS can't: an active status, a pin claimed by the owner and linked both
-- ways (places.claim_store_id, stores.place_id — as approve_place_claim), the
-- logo and banner attached so the orphan sweep keeps them. The pin never
-- carries the store's phone (phones leave only through the contact endpoint).
-- AE247: the caller already owns p_max_per_owner stores here (counted under
-- the lock on the caller's membership row).
CREATE OR REPLACE FUNCTION public.create_store(
  p_slug text,
  p_name_bn text,
  p_name_en text,
  p_name_translit text,
  p_description text,
  p_category_id uuid,
  p_logo_media_id uuid,
  p_cover_media_id uuid,
  p_phone text,
  p_whatsapp text,
  p_address_text text,
  p_lat double precision,
  p_lng double precision,
  p_geo_area_id uuid,
  p_outside_boundary boolean,
  p_place_slug text,
  p_live boolean,
  p_max_per_owner integer
)
RETURNS TABLE (store_id uuid, place_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := public.current_user_id();
  v_member uuid := public.current_member_id();
  v_role text := current_setting('app.role', true);
  v_count integer;
  v_store uuid;
  v_place uuid;
  v_media uuid;
  v_sort integer := 0;
BEGIN
  IF v_tenant IS NULL OR v_user IS NULL OR v_member IS NULL OR NOT public.app_is_active_user() THEN
    RAISE EXCEPTION 'create_store: no caller' USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM 1 FROM public.tenant_members tm WHERE tm.tenant_id = v_tenant AND tm.id = v_member FOR UPDATE;
  SELECT count(*) INTO v_count FROM public.stores s
  WHERE s.tenant_id = v_tenant AND s.owner_member_id = v_member AND s.deleted_at IS NULL;
  IF v_count >= p_max_per_owner THEN
    RAISE EXCEPTION 'create_store: % stores already', v_count USING ERRCODE = 'AE247';
  END IF;

  -- The status and the pin's claim columns are the system's to set
  -- (stores_protect_status, places_protect_system_columns); restored below.
  PERFORM set_config('app.role', 'system', true);

  INSERT INTO public.stores
    (tenant_id, owner_member_id, slug, name_bn, name_en, name_translit, description, category_id,
     logo_media_id, cover_media_id, phone_e164, whatsapp_e164, address_text, location, status_code)
  VALUES
    (v_tenant, v_member, p_slug, p_name_bn, p_name_en, p_name_translit, p_description, p_category_id,
     p_logo_media_id, p_cover_media_id, p_phone, p_whatsapp, p_address_text, public.geo_point(p_lat, p_lng),
     CASE WHEN p_live THEN 'active' ELSE 'pending_review' END)
  RETURNING id INTO v_store;

  INSERT INTO public.places
    (tenant_id, category_id, slug, name_bn, name_en, name_translit, address_text, location, geo_area_id,
     outside_boundary, source_code, created_by_user_id, claimed_by_member_id, claim_store_id, status_code)
  VALUES
    (v_tenant, p_category_id, p_place_slug, p_name_bn, p_name_en, p_name_translit, p_address_text,
     public.geo_point(p_lat, p_lng), p_geo_area_id, p_outside_boundary, 'owner_created', v_user, v_member,
     v_store, CASE WHEN p_live THEN 'published' ELSE 'pending_review' END)
  RETURNING id INTO v_place;

  UPDATE public.stores SET place_id = v_place WHERE id = v_store;

  FOREACH v_media IN ARRAY array_remove(ARRAY[p_logo_media_id, p_cover_media_id], NULL) LOOP
    INSERT INTO public.media_attachments (tenant_id, media_asset_id, store_id, sort_order)
    VALUES (v_tenant, v_media, v_store, v_sort);
    v_sort := v_sort + 1;
  END LOOP;

  PERFORM set_config('app.role', coalesce(v_role, ''), true);
  RETURN QUERY SELECT v_store, v_place;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.create_store(text, text, text, text, text, uuid, uuid, uuid, text, text, text,
  double precision, double precision, uuid, boolean, text, boolean, integer) OWNER TO ae_rls_bypass;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.create_store(text, text, text, text, text, uuid, uuid, uuid, text, text, text,
  double precision, double precision, uuid, boolean, text, boolean, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.create_store(text, text, text, text, text, uuid, uuid, uuid, text, text, text,
  double precision, double precision, uuid, boolean, text, boolean, integer) TO ae_app;
--> statement-breakpoint

-- What create_store() and store_invite_staff() write as their owner
-- (ae_rls_bypass had read/update on these, not insert).
GRANT INSERT ON public.places, public.media_attachments, public.store_members TO ae_rls_bypass;
--> statement-breakpoint

-- THE rule for "may post as this store": its owner, or staff who accepted
-- (manager or editor). The posts trigger (0006) and store_posting_facts()
-- both ask it.
CREATE OR REPLACE FUNCTION public.member_may_post_as_store(p_tenant_id uuid, p_store_id uuid, p_member_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.stores s
    WHERE s.tenant_id = p_tenant_id AND s.id = p_store_id AND s.owner_member_id = p_member_id
  ) OR EXISTS (
    SELECT 1 FROM public.store_members sm
    WHERE sm.tenant_id = p_tenant_id AND sm.store_id = p_store_id AND sm.member_id = p_member_id
      AND sm.accepted_at IS NOT NULL
  )
$$;
--> statement-breakpoint
ALTER FUNCTION public.member_may_post_as_store(uuid, uuid, uuid) OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.member_may_post_as_store(uuid, uuid, uuid) TO ae_app;
--> statement-breakpoint

-- 0006's trigger, now through the one rule and with its own SQLSTATE (AE246)
-- so the API answers 403 STORE_MEMBERSHIP_REQUIRED instead of a 500.
CREATE OR REPLACE FUNCTION public.posts_validate_store_authorship()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.store_id IS NULL OR NEW.author_member_id IS NULL THEN
    RETURN NEW; -- no store, or already scrubbed
  END IF;
  IF NOT public.member_may_post_as_store(NEW.tenant_id, NEW.store_id, NEW.author_member_id) THEN
    RAISE EXCEPTION 'posts.author_member_id % may not post on behalf of store %', NEW.author_member_id, NEW.store_id
      USING ERRCODE = 'AE246';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- What posting as a store needs to know, whatever the caller's RLS shows:
-- the store's tenant and status, its tier, how many posts it holds (draft,
-- in review, live) and whether the caller (a member of the CURRENT tenant)
-- may post as it — false when the store is another tenant's. No row: no store.
CREATE OR REPLACE FUNCTION public.store_posting_facts(p_store_id uuid)
RETURNS TABLE (tenant_id uuid, status_code text, tier_code text, catalog_count integer, may_post boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.tenant_id, s.status_code, s.tier_code,
         (SELECT count(*)::integer FROM public.posts p
          WHERE p.tenant_id = s.tenant_id AND p.store_id = s.id AND p.deleted_at IS NULL
            AND p.status_code IN ('draft', 'pending', 'live')),
         public.member_may_post_as_store(s.tenant_id, s.id, public.current_member_id())
  FROM public.stores s
  WHERE s.id = p_store_id AND s.deleted_at IS NULL
$$;
--> statement-breakpoint
ALTER FUNCTION public.store_posting_facts(uuid) OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.store_posting_facts(uuid) TO ae_app;
--> statement-breakpoint

-- GET /stores/me: the caller's stores in every tenant — owned (any status
-- but deleted) and staffed (accepted or invited). Cross-tenant like
-- my_saved_items (0032), so SECURITY DEFINER, keyed on current_user_id().
CREATE OR REPLACE FUNCTION public.my_stores()
RETURNS TABLE (
  store_id uuid,
  tenant_id uuid,
  slug text,
  name_bn text,
  name_en text,
  status_code text,
  tier_code text,
  role_code text,
  accepted boolean,
  invited_at timestamptz,
  logo_variants jsonb,
  logo_thumbhash text,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH mine AS (
    SELECT s.id AS store_id, 'owner'::text AS role_code, true AS accepted, NULL::timestamptz AS invited_at
    FROM public.stores s
    JOIN public.tenant_members tm ON tm.tenant_id = s.tenant_id AND tm.id = s.owner_member_id
    WHERE tm.user_id = public.current_user_id() AND s.deleted_at IS NULL
    UNION ALL
    SELECT sm.store_id, sm.role_code, sm.accepted_at IS NOT NULL, sm.created_at
    FROM public.store_members sm
    JOIN public.tenant_members tm ON tm.tenant_id = sm.tenant_id AND tm.id = sm.member_id
    WHERE tm.user_id = public.current_user_id()
  )
  SELECT s.id, s.tenant_id, s.slug, s.name_bn, s.name_en, s.status_code, s.tier_code,
         mine.role_code, mine.accepted, mine.invited_at, logo.variants, logo.thumbhash, s.created_at
  FROM mine
  JOIN public.stores s ON s.id = mine.store_id AND s.deleted_at IS NULL
  LEFT JOIN public.media_assets logo
    ON logo.tenant_id = s.tenant_id AND logo.id = s.logo_media_id
   AND logo.status_code = 'ready' AND logo.deleted_at IS NULL
  WHERE public.current_user_id() IS NOT NULL
  ORDER BY s.created_at DESC, s.id
$$;
--> statement-breakpoint
ALTER FUNCTION public.my_stores() OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.my_stores() TO ae_app;
--> statement-breakpoint

-- A store's staff for its owner and managers (store_members' own read policy
-- shows a manager only their own row — see 0006 on why it can't do more).
-- The phone is returned for the API to mask; it never leaves unmasked.
CREATE OR REPLACE FUNCTION public.store_staff(p_store_id uuid)
RETURNS TABLE (
  member_id uuid,
  role_code text,
  invited_at timestamptz,
  accepted_at timestamptz,
  display_name text,
  phone_e164 text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT sm.member_id, sm.role_code, sm.created_at, sm.accepted_at, up.display_name, u.phone_e164
  FROM public.store_members sm
  JOIN public.tenant_members tm ON tm.tenant_id = sm.tenant_id AND tm.id = sm.member_id
  JOIN public.users u ON u.id = tm.user_id
  LEFT JOIN public.user_profiles up ON up.user_id = u.id
  WHERE sm.tenant_id = public.current_tenant_id() AND sm.store_id = p_store_id
    AND public.can_manage_store(p_store_id)
  ORDER BY sm.created_at, sm.id
$$;
--> statement-breakpoint
ALTER FUNCTION public.store_staff(uuid) OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.store_staff(uuid) TO ae_app;
--> statement-breakpoint

-- Whether a slug is free in the current tenant: no store has it as its slug
-- or its previous slug (old links keep resolving, so they stay taken).
-- Suspended and closed stores count too, which the caller can't see.
CREATE OR REPLACE FUNCTION public.store_slug_available(p_slug text, p_except uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.stores s
    WHERE s.tenant_id = public.current_tenant_id() AND s.deleted_at IS NULL
      AND (s.slug = p_slug OR s.previous_slug = p_slug)
      AND s.id IS DISTINCT FROM p_except
  )
$$;
--> statement-breakpoint
ALTER FUNCTION public.store_slug_available(text, uuid) OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.store_slug_available(text, uuid) TO ae_app;
--> statement-breakpoint

-- Staff may leave a store, and an invitee may decline, on their own.
CREATE POLICY store_members_self_delete ON public.store_members
  FOR DELETE
  USING (tenant_id = (SELECT public.current_tenant_id()) AND member_id = (SELECT public.current_member_id()));
--> statement-breakpoint

-- The store's managers keep its map pin in step with the store (name,
-- category, address, location): the pin is the store on the map. Before
-- this only the claimed owner could edit it.
CREATE POLICY places_store_manager_update ON public.places
  FOR UPDATE
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND claim_store_id IS NOT NULL
    AND (SELECT public.can_manage_store(claim_store_id))
  )
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND claim_store_id IS NOT NULL
    AND (SELECT public.can_manage_store(claim_store_id))
  );
--> statement-breakpoint

-- ---- 8. The discovery functions call the new rule --------------------------------
-- Their current bodies (pg_get_functiondef after 0049) with store_hidden passed
-- to post_is_listed; map_features also gets the store-pin and category changes
-- described in the header. Owned by ae_rls_bypass, so replaced as it.

SET LOCAL ROLE ae_rls_bypass;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.feed_posts(p_origin geography, p_radius_km double precision, p_category_ids uuid[], p_shippable_only boolean, p_field_filters jsonb, p_boost_placement text, p_rank jsonb, p_as_of timestamp with time zone, p_after_score double precision, p_after_id uuid, p_limit integer)
 RETURNS TABLE(id uuid, tenant_id uuid, score double precision, distance_m double precision, is_boosted boolean, is_highlighted boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
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
      AND public.post_is_listed(bp.status_code, bp.deleted_at, bp.scrubbed_at, bp.hidden_by_owner, bp.store_hidden, bp.expires_at, as_of)
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
      -- post_is_listed (0049) inlines to the live-post partial indexes' predicate.
      WHERE public.post_is_listed(p.status_code, p.deleted_at, p.scrubbed_at, p.hidden_by_owner, p.store_hidden, p.expires_at, as_of)
        AND coalesce(p.bumped_at, p.published_at) <= as_of
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
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.heatmap_cells(p_type text, p_category_slug text, p_precision integer, p_window_days integer, p_min_people integer, p_limit integer)
 RETURNS TABLE(geohash text, lat double precision, lng double precision, count integer, people integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_categories uuid[];
  v_area geography;
  v_reach_m double precision;
BEGIN
  IF v_tenant IS NULL OR NOT (public.app_is_tenant_admin() OR public.app_is_platform()) THEN
    RAISE EXCEPTION 'heatmap_cells: tenant admins only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_type NOT IN ('demand', 'supply') OR p_precision IS NULL OR p_precision < 1 OR p_precision > 12
     OR p_min_people IS NULL OR p_min_people < 2 OR p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'heatmap_cells: bad arguments' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Where this tenant's saved searches can be: its area (or centre, radius
  -- mode) plus the widest boundary buffer; resolve_owning_tenant decides.
  SELECT CASE WHEN t.boundary_mode = 'radius' OR g.boundary IS NULL THEN t.map_center ELSE g.boundary END,
         CASE WHEN t.boundary_mode = 'radius' THEN coalesce(t.service_radius_km, 0) * 1000 ELSE 0 END
         + 1000 * greatest(
             (SELECT (ps.value #>> '{}')::double precision FROM public.platform_settings ps
              WHERE ps.key = 'boundary_buffer_km'),
             coalesce((SELECT max((ts.setting_overrides ->> 'boundary_buffer_km')::double precision)
                       FROM public.tenant_settings ts
                       WHERE ts.setting_overrides ? 'boundary_buffer_km'), 0))
    INTO v_area, v_reach_m
  FROM public.tenants t LEFT JOIN public.geo_areas g ON g.id = t.geo_area_id WHERE t.id = v_tenant;
  IF p_category_slug IS NOT NULL THEN
    WITH RECURSIVE tree AS (
      SELECT c.id FROM public.categories c WHERE c.slug = p_category_slug AND c.deleted_at IS NULL
      UNION ALL
      SELECT c.id FROM public.categories c JOIN tree t ON c.parent_id = t.id WHERE c.deleted_at IS NULL
    )
    SELECT coalesce(array_agg(tree.id), '{}') INTO v_categories FROM tree;
  END IF;

  RETURN QUERY
    WITH events AS (
      SELECT q.origin::geometry AS g, coalesce(q.user_id::text, 's:' || q.searcher_hash) AS person
      FROM public.search_queries q
      WHERE p_type = 'demand' AND q.tenant_id = v_tenant AND q.origin IS NOT NULL
        AND q.created_at >= now() - make_interval(days => p_window_days)
        AND (v_categories IS NULL OR q.category_id = ANY (v_categories))
      UNION ALL
      -- Saved searches belong to a user, not a tenant: the tenant's are the
      -- ones whose centre it owns, by the one ownership rule
      -- (resolve_owning_tenant, as unmet_demand uses), near its area first.
      SELECT ss.center::geometry, ss.user_id::text
      FROM public.saved_searches ss
      WHERE p_type = 'demand' AND v_area IS NOT NULL AND st_dwithin(ss.center, v_area, v_reach_m)
        AND (SELECT o.tenant_id FROM public.resolve_owning_tenant(ss.center, NULL) o LIMIT 1) = v_tenant
        AND ss.is_active AND ss.paused_at IS NULL AND ss.deleted_at IS NULL
        AND (v_categories IS NULL OR ss.category_id = ANY (v_categories))
      UNION ALL
      SELECT p.location::geometry, p.author_member_id::text
      FROM public.posts p
      WHERE p_type = 'supply' AND p.tenant_id = v_tenant
        AND public.post_is_listed(p.status_code, p.deleted_at, p.scrubbed_at, p.hidden_by_owner, p.store_hidden, p.expires_at, now())
        AND p.location IS NOT NULL AND p.author_member_id IS NOT NULL
        AND (v_categories IS NULL OR p.category_id = ANY (v_categories))
      UNION ALL
      SELECT coalesce(s.location, pl.location)::geometry, s.owner_member_id::text
      FROM public.stores s
      LEFT JOIN public.places pl ON pl.tenant_id = s.tenant_id AND pl.id = s.place_id
      WHERE p_type = 'supply' AND v_categories IS NULL AND s.tenant_id = v_tenant
        AND s.status_code = 'active' AND s.deleted_at IS NULL
        AND coalesce(s.location, pl.location) IS NOT NULL
    ),
    cells AS (
      SELECT st_geohash(e.g, p_precision) AS gh, count(*)::integer AS n,
             count(DISTINCT e.person)::integer AS people
      FROM events e
      GROUP BY 1
      HAVING count(DISTINCT e.person) >= p_min_people
    )
    SELECT c.gh, st_y(st_pointfromgeohash(c.gh)), st_x(st_pointfromgeohash(c.gh)), c.n, c.people
    FROM cells c
    ORDER BY c.n DESC, c.gh
    LIMIT p_limit;
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.discover_nearby(p_point geography, p_radius_km double precision, p_kinds text[], p_category_ids uuid[], p_limit integer, p_offset integer)
 RETURNS TABLE(entity text, id uuid, tenant_id uuid, distance_m double precision)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
#variable_conflict use_column
DECLARE
  max_radius_km double precision;
  max_page_size integer;
  radius_m double precision;
BEGIN
  IF p_point IS NULL OR p_radius_km IS NULL OR p_radius_km <= 0 THEN
    RAISE EXCEPTION 'discover_nearby needs a point and a positive radius'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_limit IS NULL OR p_limit <= 0 OR p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'discover_nearby needs a positive limit and a non-negative offset'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT (ps.value #>> '{}')::double precision INTO max_radius_km
  FROM public.platform_settings ps WHERE ps.key = 'search_max_radius_km';
  SELECT (ps.value #>> '{}')::integer INTO max_page_size
  FROM public.platform_settings ps WHERE ps.key = 'search_page_size_max';
  IF max_radius_km IS NULL OR max_page_size IS NULL THEN
    RAISE EXCEPTION 'platform settings search_max_radius_km / search_page_size_max are missing';
  END IF;

  radius_m := least(p_radius_km, max_radius_km) * 1000;

  RETURN QUERY
    SELECT d.entity, d.id, d.tenant_id, d.distance_m
    FROM (
      SELECT 'post'::text AS entity, p.id, p.tenant_id,
             st_distance(p.location, p_point) AS distance_m
      FROM public.posts p
      WHERE 'post' = ANY (p_kinds)
        -- post_is_listed (0049) inlines to posts_location_gist_idx's predicate.
        AND public.post_is_listed(p.status_code, p.deleted_at, p.scrubbed_at, p.hidden_by_owner, p.store_hidden, p.expires_at, now())
        AND st_dwithin(p.location, p_point, radius_m)
        AND (p_category_ids IS NULL OR p.category_id = ANY (p_category_ids))
      UNION ALL
      SELECT 'store'::text, s.id, s.tenant_id, st_distance(s.location, p_point)
      FROM public.stores s
      WHERE 'store' = ANY (p_kinds)
        AND p_category_ids IS NULL
        AND s.status_code = 'active' AND s.deleted_at IS NULL
        AND st_dwithin(s.location, p_point, radius_m)
      UNION ALL
      SELECT 'place'::text, pl.id, pl.tenant_id, st_distance(pl.location, p_point)
      FROM public.places pl
      WHERE 'place' = ANY (p_kinds)
        AND pl.status_code IN ('published', 'temporarily_closed', 'permanently_closed')
        AND pl.deleted_at IS NULL
        AND st_dwithin(pl.location, p_point, radius_m)
        AND (p_category_ids IS NULL OR pl.category_id = ANY (p_category_ids))
    ) d
    ORDER BY d.distance_m, d.id
    LIMIT least(p_limit, max_page_size)
    OFFSET p_offset;
END
$function$;
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
             ELSE coalesce(s.name_bn, pl.name_bn, e.name_bn, st.name_bn)
           END,
           CASE
             WHEN p.id IS NOT NULL THEN CASE WHEN p.title ~ '[ঀ-৿]' THEN NULL ELSE p.title END
             ELSE coalesce(s.name_en, pl.name_en, e.name_en, st.name_en)
           END,
           CASE WHEN pk.layer = 'info' THEN NULL ELSE coalesce(pc.slug, plc.slug, sc.slug) END,
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
    LEFT JOIN public.categories sc ON sc.id = s.category_id
    LEFT JOIN public.places pl ON pk.n = 1 AND pk.src = 'places' AND pl.id = pk.id
    LEFT JOIN public.categories plc ON plc.id = pl.category_id
    LEFT JOIN public.emergency_contacts e ON pk.n = 1 AND pk.src = 'emergency' AND e.id = pk.id
    LEFT JOIN public.transport_route_stops st ON pk.n = 1 AND pk.src = 'bus_stops' AND st.id = pk.id
    ORDER BY pk.n DESC, pk.dist, pk.layer, pk.kind, pk.id;
END
$function$;
--> statement-breakpoint

RESET ROLE;
--> statement-breakpoint

-- Nothing may decide "listed" without the store any more.
DROP FUNCTION public.post_is_listed(text, timestamptz, timestamptz, boolean, timestamptz, timestamptz);
