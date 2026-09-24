-- 0006_stores
--
-- Stores & sellers domain (docs/specs/schema.md §5): seller reputation,
-- storefronts, the people who manage them, and store follows. Runs as
-- ae_migrator; RLS and grants are in this same file, as in 0003-0005.
--
-- Closes three deferred items now that stores exists:
--   - posts.store_id            -> stores(T) ON DELETE SET NULL (store_id)
--   - media_attachments.store_id -> stores(T) ON DELETE CASCADE
--   - posts: the "author must own or staff the store" trigger (§4.2), which
--     needed stores/store_members to check against.
--
-- Deviation from spec, with reasoning: §5.3 asks for `can_manage_store()` as
-- SECURITY DEFINER. It is NOT SECURITY DEFINER here. FORCE ROW LEVEL
-- SECURITY (0002) binds a function's queries to its OWNER even under
-- SECURITY DEFINER — current_user is the owner during execution, so a
-- definer function gets exactly the same "see nothing" default as anyone
-- else unless app.is_platform_admin is set, which this check must not grant.
-- (This is the same root cause as 0003's user_is_visible() fix.) Instead
-- can_manage_store() is a plain STABLE function that runs as the caller, and
-- store_members'/stores' own SELECT policies are written to expose enough
-- of the caller's own rows for it to resolve correctly — never anyone else's.
--
-- Still deferred:
--   - stores.current_plan_code: no FK yet (subscription_plans is 0007's).
--   - store_follows' "owners/managers see follower counts only" needs a
--     reporting function (aggregate, no row access) — a service-layer
--     concern, not a table constraint; not built here.

-- ============================================================================
-- Enum tables
-- ============================================================================

CREATE TABLE public.seller_types (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seller_types_pk PRIMARY KEY (code),
  CONSTRAINT seller_types_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER seller_types_set_updated_at BEFORE UPDATE ON public.seller_types
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.seller_types (code, label_key, sort_order) VALUES
  ('individual', 'enum.seller_types.individual', 10),
  ('business',   'enum.seller_types.business',   20);
--> statement-breakpoint

CREATE TABLE public.seller_verification_levels (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seller_verification_levels_pk PRIMARY KEY (code),
  CONSTRAINT seller_verification_levels_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER seller_verification_levels_set_updated_at BEFORE UPDATE ON public.seller_verification_levels
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.seller_verification_levels (code, label_key, sort_order) VALUES
  ('phone',    'enum.seller_verification_levels.phone',    10),
  ('identity', 'enum.seller_verification_levels.identity', 20),
  ('business', 'enum.seller_verification_levels.business', 30);
--> statement-breakpoint

CREATE TABLE public.store_statuses (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_statuses_pk PRIMARY KEY (code),
  CONSTRAINT store_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER store_statuses_set_updated_at BEFORE UPDATE ON public.store_statuses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.store_statuses (code, label_key, sort_order) VALUES
  ('pending_review', 'enum.store_statuses.pending_review', 10),
  ('active',         'enum.store_statuses.active',         20),
  ('suspended',      'enum.store_statuses.suspended',      30),
  ('closed',         'enum.store_statuses.closed',         40);
--> statement-breakpoint

CREATE TABLE public.store_member_roles (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_member_roles_pk PRIMARY KEY (code),
  CONSTRAINT store_member_roles_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER store_member_roles_set_updated_at BEFORE UPDATE ON public.store_member_roles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.store_member_roles (code, label_key, sort_order) VALUES
  ('manager', 'enum.store_member_roles.manager', 10),
  ('staff',   'enum.store_member_roles.staff',   20);
--> statement-breakpoint

-- ============================================================================
-- seller_profiles (§5.1): TENANT-SCOPED, 1:1 with tenant_members
-- ============================================================================

CREATE TABLE public.seller_profiles (
  id                        uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                 uuid          NOT NULL DEFAULT public.current_tenant_id(),
  member_id                 uuid          NOT NULL,
  seller_type_code          text          NOT NULL DEFAULT 'individual',
  business_name             text,
  verification_level_code   text          NOT NULL DEFAULT 'phone',
  rating_avg                numeric(3,2),
  rating_count              integer       NOT NULL DEFAULT 0,
  response_rate_pct         numeric(5,2),
  median_response_seconds   integer,
  active_post_count         integer       NOT NULL DEFAULT 0,
  created_at                timestamptz   NOT NULL DEFAULT now(),
  updated_at                timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT seller_profiles_pk PRIMARY KEY (id),
  CONSTRAINT seller_profiles_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT seller_profiles_tenant_id_member_id_fk FOREIGN KEY (tenant_id, member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT seller_profiles_seller_type_code_fk FOREIGN KEY (seller_type_code)
    REFERENCES public.seller_types (code) ON DELETE RESTRICT,
  CONSTRAINT seller_profiles_verification_level_code_fk FOREIGN KEY (verification_level_code)
    REFERENCES public.seller_verification_levels (code) ON DELETE RESTRICT,
  CONSTRAINT seller_profiles_rating_avg_ck CHECK (rating_avg IS NULL OR rating_avg BETWEEN 0 AND 5),
  CONSTRAINT seller_profiles_rating_count_ck CHECK (rating_count >= 0),
  CONSTRAINT seller_profiles_response_rate_pct_ck
    CHECK (response_rate_pct IS NULL OR response_rate_pct BETWEEN 0 AND 100),
  CONSTRAINT seller_profiles_active_post_count_ck CHECK (active_post_count >= 0),
  -- 1:1 with tenant_members; also the composite-FK target (§0.4).
  CONSTRAINT seller_profiles_tenant_id_member_id_uq UNIQUE (tenant_id, member_id),
  CONSTRAINT seller_profiles_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
CREATE TRIGGER seller_profiles_set_updated_at BEFORE UPDATE ON public.seller_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- Reputation/plan-limit cache columns are system-maintained; an owner INSERT/
-- UPDATE can only ever touch seller_type_code and business_name.
CREATE OR REPLACE FUNCTION public.seller_profiles_protect_cache_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF public.app_is_system() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.verification_level_code := 'phone';
    NEW.rating_avg := NULL;
    NEW.rating_count := 0;
    NEW.response_rate_pct := NULL;
    NEW.median_response_seconds := NULL;
    NEW.active_post_count := 0;
  ELSE
    NEW.verification_level_code := OLD.verification_level_code;
    NEW.rating_avg := OLD.rating_avg;
    NEW.rating_count := OLD.rating_count;
    NEW.response_rate_pct := OLD.response_rate_pct;
    NEW.median_response_seconds := OLD.median_response_seconds;
    NEW.active_post_count := OLD.active_post_count;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER seller_profiles_a_protect_cache_columns BEFORE INSERT OR UPDATE ON public.seller_profiles
  FOR EACH ROW EXECUTE FUNCTION public.seller_profiles_protect_cache_columns();
--> statement-breakpoint

-- ============================================================================
-- stores (§5.2): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.stores (
  id                  uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id           uuid          NOT NULL DEFAULT public.current_tenant_id(),
  owner_member_id     uuid          NOT NULL,
  place_id            uuid,
  slug                text          NOT NULL,
  name_bn             text          NOT NULL,
  name_en             text,
  description         text,
  logo_media_id       uuid,
  cover_media_id      uuid,
  phone_e164          text,
  whatsapp_e164       text,
  address_text        text,
  locality_id         uuid,
  location            geography(Point, 4326),
  status_code         text          NOT NULL DEFAULT 'pending_review',
  current_plan_code   text,  -- FK added with subscription_plans (0007)
  is_verified         boolean       NOT NULL DEFAULT false,
  rating_avg          numeric(3,2),
  rating_count        integer       NOT NULL DEFAULT 0,
  search_synced_at    timestamptz,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  updated_at          timestamptz   NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CONSTRAINT stores_pk PRIMARY KEY (id),
  CONSTRAINT stores_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT stores_tenant_id_owner_member_id_fk FOREIGN KEY (tenant_id, owner_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT stores_tenant_id_place_id_fk FOREIGN KEY (tenant_id, place_id)
    REFERENCES public.places (tenant_id, id) ON DELETE SET NULL (place_id),
  CONSTRAINT stores_tenant_id_logo_media_id_fk FOREIGN KEY (tenant_id, logo_media_id)
    REFERENCES public.media_assets (tenant_id, id) ON DELETE SET NULL (logo_media_id),
  CONSTRAINT stores_tenant_id_cover_media_id_fk FOREIGN KEY (tenant_id, cover_media_id)
    REFERENCES public.media_assets (tenant_id, id) ON DELETE SET NULL (cover_media_id),
  CONSTRAINT stores_tenant_id_locality_id_fk FOREIGN KEY (tenant_id, locality_id)
    REFERENCES public.localities (tenant_id, id) ON DELETE SET NULL (locality_id),
  CONSTRAINT stores_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.store_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT stores_slug_ck CHECK (slug = lower(slug)),
  CONSTRAINT stores_rating_avg_ck CHECK (rating_avg IS NULL OR rating_avg BETWEEN 0 AND 5),
  CONSTRAINT stores_rating_count_ck CHECK (rating_count >= 0),
  -- Composite-FK target (§0.4).
  CONSTRAINT stores_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- Store URLs.
CREATE UNIQUE INDEX stores_tenant_id_slug_uq ON public.stores (tenant_id, slug)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
-- One store per physical place.
CREATE UNIQUE INDEX stores_tenant_id_place_id_uq ON public.stores (tenant_id, place_id)
  WHERE place_id IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint
-- "My stores", plan limits; also the FK index (§0.4).
CREATE INDEX stores_tenant_id_owner_member_id_idx ON public.stores (tenant_id, owner_member_id);
--> statement-breakpoint
-- Nearby stores.
CREATE INDEX stores_location_gist_idx ON public.stores USING gist (location)
  WHERE status_code = 'active';
--> statement-breakpoint
-- Search sync safety-net sweeper.
CREATE INDEX stores_search_sync_idx ON public.stores (updated_at)
  WHERE search_synced_at IS NULL OR search_synced_at < updated_at;
--> statement-breakpoint
CREATE TRIGGER stores_set_updated_at BEFORE UPDATE ON public.stores
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- Status changes are staff-only (service): a plain owner/manager UPDATE
-- leaves status_code untouched; a bare INSERT always starts pending_review.
CREATE OR REPLACE FUNCTION public.stores_protect_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF public.app_is_staff() OR public.app_is_system() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.status_code := 'pending_review';
  ELSE
    NEW.status_code := OLD.status_code;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER stores_a_protect_status BEFORE INSERT OR UPDATE ON public.stores
  FOR EACH ROW EXECUTE FUNCTION public.stores_protect_status();
--> statement-breakpoint

-- ============================================================================
-- store_members (§5.3): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.store_members (
  id                    uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id             uuid        NOT NULL DEFAULT public.current_tenant_id(),
  store_id              uuid        NOT NULL,
  member_id             uuid        NOT NULL,
  role_code             text        NOT NULL DEFAULT 'staff',
  invited_by_member_id  uuid,
  accepted_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_members_pk PRIMARY KEY (id),
  CONSTRAINT store_members_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT store_members_tenant_id_store_id_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT store_members_tenant_id_member_id_fk FOREIGN KEY (tenant_id, member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT store_members_tenant_id_invited_by_member_id_fk FOREIGN KEY (tenant_id, invited_by_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE SET NULL (invited_by_member_id),
  CONSTRAINT store_members_role_code_fk FOREIGN KEY (role_code)
    REFERENCES public.store_member_roles (code) ON DELETE RESTRICT,
  CONSTRAINT store_members_tenant_id_store_id_member_id_uq UNIQUE (tenant_id, store_id, member_id)
);
--> statement-breakpoint
-- "Stores I help manage"; also used by can_manage_store() below.
CREATE INDEX store_members_tenant_id_member_id_idx ON public.store_members (tenant_id, member_id)
  WHERE accepted_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX store_members_invited_by_member_id_idx ON public.store_members (tenant_id, invited_by_member_id)
  WHERE invited_by_member_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER store_members_set_updated_at BEFORE UPDATE ON public.store_members
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- A self-accepting member (not yet a manager) may only move accepted_at;
-- role_code/store_id/member_id only change through an owner/manager write.
CREATE OR REPLACE FUNCTION public.store_members_protect_role()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT public.can_manage_store(NEW.store_id) THEN
    NEW.role_code := OLD.role_code;
    NEW.store_id := OLD.store_id;
    NEW.member_id := OLD.member_id;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER store_members_a_protect_role BEFORE UPDATE ON public.store_members
  FOR EACH ROW EXECUTE FUNCTION public.store_members_protect_role();
--> statement-breakpoint

-- ============================================================================
-- store_follows (§5.4): TENANT-SCOPED (= the store's owning tenant)
-- ============================================================================

CREATE TABLE public.store_follows (
  id                uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id         uuid        NOT NULL DEFAULT public.current_tenant_id(),
  user_id           uuid        NOT NULL,
  store_id          uuid        NOT NULL,
  notify_new_posts  boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_follows_pk PRIMARY KEY (id),
  CONSTRAINT store_follows_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT store_follows_user_id_fk FOREIGN KEY (user_id)
    REFERENCES public.users (id) ON DELETE CASCADE,
  CONSTRAINT store_follows_tenant_id_store_id_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE RESTRICT
);
--> statement-breakpoint
-- Also the tenant_id index.
CREATE UNIQUE INDEX store_follows_tenant_user_store_uq ON public.store_follows (tenant_id, user_id, store_id);
--> statement-breakpoint
-- "Stores I follow" across tenants.
CREATE INDEX store_follows_user_id_idx ON public.store_follows (user_id, id DESC);
--> statement-breakpoint
-- Fan-out when the store publishes; follower count.
CREATE INDEX store_follows_tenant_store_notify_idx ON public.store_follows (tenant_id, store_id)
  WHERE notify_new_posts;
--> statement-breakpoint
CREATE TRIGGER store_follows_set_updated_at BEFORE UPDATE ON public.store_follows
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- can_manage_store(): NOT SECURITY DEFINER — see header. Runs as the caller,
-- relying on stores'/store_members' own SELECT policies (below) to expose
-- the caller's own owner/manager facts.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.can_manage_store(target_store_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.stores s
    WHERE s.id = target_store_id
      AND s.tenant_id = (SELECT public.current_tenant_id())
      AND s.owner_member_id = (SELECT public.current_member_id())
  )
  OR EXISTS (
    SELECT 1 FROM public.store_members sm
    WHERE sm.store_id = target_store_id
      AND sm.tenant_id = (SELECT public.current_tenant_id())
      AND sm.member_id = (SELECT public.current_member_id())
      AND sm.role_code = 'manager'
      AND sm.accepted_at IS NOT NULL
  )
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.can_manage_store(uuid) IS
  'True when the caller is the store''s owner or an accepted manager. Not SECURITY DEFINER (see 0006 header) — only ever resolves the caller''s own facts, never another member''s.';
--> statement-breakpoint

-- ============================================================================
-- Closing deferred items from 0005, now that stores exists.
-- ============================================================================

ALTER TABLE public.posts
  ADD CONSTRAINT posts_tenant_id_store_id_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE SET NULL (store_id);
--> statement-breakpoint
ALTER TABLE public.media_attachments
  ADD CONSTRAINT media_attachments_tenant_id_store_id_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE CASCADE;
--> statement-breakpoint

-- If store_id is set, the author must own or staff that store.
CREATE OR REPLACE FUNCTION public.posts_validate_store_authorship()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  authorized boolean;
BEGIN
  IF NEW.store_id IS NULL OR NEW.author_member_id IS NULL THEN
    RETURN NEW; -- no store, or already scrubbed
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.stores s
    WHERE s.id = NEW.store_id AND s.tenant_id = NEW.tenant_id AND s.owner_member_id = NEW.author_member_id
  ) OR EXISTS (
    SELECT 1 FROM public.store_members sm
    WHERE sm.store_id = NEW.store_id AND sm.tenant_id = NEW.tenant_id
      AND sm.member_id = NEW.author_member_id AND sm.accepted_at IS NOT NULL
  ) INTO authorized;

  IF NOT authorized THEN
    RAISE EXCEPTION 'posts.author_member_id % may not post on behalf of store %', NEW.author_member_id, NEW.store_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER posts_b_validate_store_authorship
  BEFORE INSERT OR UPDATE OF store_id, author_member_id ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.posts_validate_store_authorship();
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
        'seller_types', 'seller_verification_levels', 'store_statuses', 'store_member_roles',
        'seller_profiles', 'stores', 'store_members', 'store_follows'
      )
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.ident);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', obj.ident);
  END LOOP;
END
$$;
--> statement-breakpoint

-- ---- enum tables: read by all, write by platform admin (as 0002-0005) ----

DO $$
DECLARE
  enum_table text;
BEGIN
  FOREACH enum_table IN ARRAY ARRAY[
    'seller_types', 'seller_verification_levels', 'store_statuses', 'store_member_roles'
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

-- ---- seller_profiles: T-PUBLIC-READ (all rows); owner writes 2 columns ---

CREATE POLICY seller_profiles_public_read ON public.seller_profiles
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()));
--> statement-breakpoint
CREATE POLICY seller_profiles_owner_write ON public.seller_profiles
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND member_id = (SELECT public.current_member_id()))
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND member_id = (SELECT public.current_member_id())
  );
--> statement-breakpoint
CREATE POLICY seller_profiles_platform_admin ON public.seller_profiles
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- stores: T-PUBLIC-READ (active) + owner + staff; write graded --------

CREATE POLICY stores_public_read ON public.stores
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND status_code = 'active'
    AND deleted_at IS NULL
  );
--> statement-breakpoint
CREATE POLICY stores_owner_read ON public.stores
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND owner_member_id = (SELECT public.current_member_id()));
--> statement-breakpoint
CREATE POLICY stores_staff_read ON public.stores
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY stores_owner_insert ON public.stores
  FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND owner_member_id = (SELECT public.current_member_id())
  );
--> statement-breakpoint
CREATE POLICY stores_manage_update ON public.stores
  FOR UPDATE
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND ((SELECT public.can_manage_store(id)) OR (SELECT public.app_is_staff()))
  )
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND ((SELECT public.can_manage_store(id)) OR (SELECT public.app_is_staff()))
  );
--> statement-breakpoint
CREATE POLICY stores_platform_admin ON public.stores
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- store_members: T-ISOLATE; self, same-store peers, owner, staff ------

-- Deliberately does NOT call can_manage_store() or self-reference
-- store_members here (via function or subquery): either would make
-- evaluating this policy require re-evaluating this same policy, which
-- Postgres rejects outright ("infinite recursion detected in policy for
-- relation store_members") — found by testing this migration directly, not
-- by reasoning about it. can_manage_store()'s own store_members lookup (for
-- the manager-role branch) only terminates because THIS policy's first
-- branch (member_id = caller) satisfies its candidate rows without ever
-- calling back into can_manage_store(). Net effect versus spec's literal
-- "the store's members" wording: an accepted non-manager staff member sees
-- only their own row here, not the whole roster; the owner and any manager
-- still see everyone via can_manage_store() through the *other* policies
-- below, which don't have this problem because they don't feed back into
-- this one.
CREATE POLICY store_members_read ON public.store_members
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND (
      member_id = (SELECT public.current_member_id())
      OR EXISTS (
        SELECT 1 FROM public.stores s
        WHERE s.id = store_members.store_id AND s.owner_member_id = (SELECT public.current_member_id())
      )
      OR (SELECT public.app_is_staff())
    )
  );
--> statement-breakpoint
CREATE POLICY store_members_manage_insert ON public.store_members
  FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND ((SELECT public.can_manage_store(store_id)) OR (SELECT public.app_is_staff()))
  );
--> statement-breakpoint
CREATE POLICY store_members_manage_delete ON public.store_members
  FOR DELETE
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND ((SELECT public.can_manage_store(store_id)) OR (SELECT public.app_is_staff()))
  );
--> statement-breakpoint
-- Self-accept: the trigger above (store_members_a_protect_role) restricts
-- this to accepted_at only when the caller isn't already a manager/owner.
CREATE POLICY store_members_self_accept ON public.store_members
  FOR UPDATE
  USING (tenant_id = (SELECT public.current_tenant_id()) AND member_id = (SELECT public.current_member_id()))
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND member_id = (SELECT public.current_member_id())
  );
--> statement-breakpoint
CREATE POLICY store_members_manage_update ON public.store_members
  FOR UPDATE
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND ((SELECT public.can_manage_store(store_id)) OR (SELECT public.app_is_staff()))
  )
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND ((SELECT public.can_manage_store(store_id)) OR (SELECT public.app_is_staff()))
  );
--> statement-breakpoint
CREATE POLICY store_members_platform_admin ON public.store_members
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- store_follows: owner, cross-tenant (own rows visible anywhere) ------

CREATE POLICY store_follows_owner_read ON public.store_follows
  FOR SELECT
  USING (user_id = (SELECT public.current_user_id()) AND (SELECT public.app_is_active_user()));
--> statement-breakpoint
CREATE POLICY store_follows_owner_delete ON public.store_follows
  FOR DELETE
  USING (user_id = (SELECT public.current_user_id()) AND (SELECT public.app_is_active_user()));
--> statement-breakpoint
CREATE POLICY store_follows_owner_insert ON public.store_follows
  FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND user_id = (SELECT public.current_user_id())
  );
--> statement-breakpoint
CREATE POLICY store_follows_platform_admin ON public.store_follows
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ============================================================================
-- Grants
-- ============================================================================

GRANT SELECT ON
  public.seller_types, public.seller_verification_levels, public.store_statuses, public.store_member_roles
TO ae_app;
--> statement-breakpoint
GRANT INSERT, UPDATE ON
  public.seller_types, public.seller_verification_levels, public.store_statuses, public.store_member_roles
TO ae_app;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.seller_profiles TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.stores TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_members TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.store_follows TO ae_app;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.can_manage_store(uuid) TO ae_app;
