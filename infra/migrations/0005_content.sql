-- 0005_content
--
-- Content domain (docs/specs/schema.md §4): uploaded media, the post
-- listing itself (the largest table in the schema), the polymorphic media
-- attachment join, the business directory (places, hours, ownership
-- claims), and saved posts. Runs as ae_migrator; RLS and grants are in this
-- same file, as in 0003/0004.
--
-- media_attachments is deliberately created now with all ten owner columns
-- (and the CHECK across all of them), but real FKs only for the four whose
-- target tables exist as of this migration (media_asset_id, post_id,
-- place_id, place_claim_id). The other six get their FK via ALTER TABLE in
-- the migration that creates their target: store_id (0006), review_id and
-- business_verification_id (0010), notice_id and lost_found_item_id (0011),
-- agent_visit_id and ticket_message_id (0012). Same pattern as 0003/0004's
-- deferred FKs.
--
-- New helper this migration: app_is_active_user() (§0.6), needed for
-- saved_posts and places' "any member" INSERT policies.
--
-- What is explicitly NOT attempted here (all documented at the point they'd
-- apply), because each depends on machinery this phase doesn't build yet:
--   - posts: the deferred constraint trigger requiring a matching
--     moderation_actions row before any takedown (Q35) — moderation_actions
--     is created in 0010. Nothing currently enforces "takedown reasons are
--     mandatory" at the DB level; the API must until then.
--   - posts/media_assets: anything that reads `legal_holds` or calls
--     `legal_hold_blocks()` — that table is created in 0012. The RLS rule
--     "legal_hold posts are visible only to platform" IS implemented now
--     (it only needs posts.deletion_reason_code, already on this table);
--     what's deferred is the trigger that would *require* an open
--     legal_holds row before that reason code can be set.
--   - `resolve_owning_tenant()`, `discover_nearby()`,
--     `reveal_contact_phone()`, `neighbour_landmarks()`: per §13.26 these
--     are service-layer operations the API calls before/around a write,
--     not stored procedures — out of scope for a schema migration.
--   - Full status-transition validity (e.g. "live" only reachable via the
--     service's credit-charge path): a state-machine trigger of the same
--     shape as 0003's deferred tenant-lifecycle one. The structural CHECKs
--     spec lists explicitly (e.g. sold_at iff status='sold') are all
--     implemented; a full transition graph is not.
--   - Category schema "reserved field keys" validation (price/bedrooms/
--     seats/area must use the right JSON Schema type) — spec assigns this
--     to publish-time zod validation in the API, not a DB constraint.

-- ============================================================================
-- Session helpers, continued. STABLE, fails closed.
-- ============================================================================

-- Missed in 0002 alongside current_tenant_id()/current_user_id() — this
-- domain is the first to actually need "the author's own row" checks
-- (posts, place_claims, saved_posts' cross-tenant "my memberships" shape).
CREATE OR REPLACE FUNCTION public.current_member_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN raw <> '' AND pg_input_is_valid(raw, 'uuid') THEN raw::uuid END
  FROM (SELECT coalesce(current_setting('app.member_id', true), '') AS raw) s
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.current_member_id() IS
  'The caller''s tenant_members.id in the current tenant, from app.member_id; NULL when unset, empty or malformed.';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.app_is_active_user()
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT (SELECT public.current_user_id()) IS NOT NULL
    AND public.app_role() NOT IN ('restricted_user', 'appeal_public')
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.app_is_active_user() IS
  'True for an authenticated session not under a restricted/banned or appeal-only scope. Required for anything a banned user must not reach.';
--> statement-breakpoint

-- ============================================================================
-- Enum tables
-- ============================================================================

CREATE TABLE public.media_kinds (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_kinds_pk PRIMARY KEY (code),
  CONSTRAINT media_kinds_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER media_kinds_set_updated_at BEFORE UPDATE ON public.media_kinds
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.media_kinds (code, label_key, sort_order) VALUES
  ('image',    'enum.media_kinds.image',    10),
  ('video',    'enum.media_kinds.video',    20),
  ('document', 'enum.media_kinds.document', 30);
--> statement-breakpoint

CREATE TABLE public.media_visibilities (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_visibilities_pk PRIMARY KEY (code),
  CONSTRAINT media_visibilities_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER media_visibilities_set_updated_at BEFORE UPDATE ON public.media_visibilities
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.media_visibilities (code, label_key, sort_order) VALUES
  ('public',  'enum.media_visibilities.public',  10),
  ('private', 'enum.media_visibilities.private', 20);
--> statement-breakpoint

CREATE TABLE public.media_statuses (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_statuses_pk PRIMARY KEY (code),
  CONSTRAINT media_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER media_statuses_set_updated_at BEFORE UPDATE ON public.media_statuses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.media_statuses (code, label_key, sort_order) VALUES
  ('pending_upload', 'enum.media_statuses.pending_upload', 10),
  ('processing',     'enum.media_statuses.processing',     20),
  ('ready',          'enum.media_statuses.ready',          30),
  ('rejected',       'enum.media_statuses.rejected',       40),
  ('quarantined',    'enum.media_statuses.quarantined',    50);
--> statement-breakpoint

CREATE TABLE public.price_types (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT price_types_pk PRIMARY KEY (code),
  CONSTRAINT price_types_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER price_types_set_updated_at BEFORE UPDATE ON public.price_types
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.price_types (code, label_key, sort_order) VALUES
  ('fixed',      'enum.price_types.fixed',      10),
  ('negotiable', 'enum.price_types.negotiable', 20),
  ('free',       'enum.price_types.free',       30),
  ('on_request', 'enum.price_types.on_request', 40),
  ('per_hour',   'enum.price_types.per_hour',   50),
  ('per_day',    'enum.price_types.per_day',    60),
  ('per_month',  'enum.price_types.per_month',  70);
--> statement-breakpoint

CREATE TABLE public.post_statuses (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT post_statuses_pk PRIMARY KEY (code),
  CONSTRAINT post_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER post_statuses_set_updated_at BEFORE UPDATE ON public.post_statuses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.post_statuses (code, label_key, sort_order) VALUES
  ('draft',    'enum.post_statuses.draft',    10),
  ('pending',  'enum.post_statuses.pending',  20),
  ('live',     'enum.post_statuses.live',     30),
  ('sold',     'enum.post_statuses.sold',     40),
  ('expired',  'enum.post_statuses.expired',  50),
  ('rejected', 'enum.post_statuses.rejected', 60),
  ('removed',  'enum.post_statuses.removed',  70);
--> statement-breakpoint

-- Spec names four takedown examples inline (spam / wrong category /
-- duplicate / policy violation); the rest is a reasonable BD-marketplace
-- moderation set, not spec-mandated wording. Easy to extend later (Q2).
CREATE TABLE public.moderation_reasons (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT moderation_reasons_pk PRIMARY KEY (code),
  CONSTRAINT moderation_reasons_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER moderation_reasons_set_updated_at BEFORE UPDATE ON public.moderation_reasons
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.moderation_reasons (code, label_key, sort_order) VALUES
  ('spam',                 'enum.moderation_reasons.spam',                 10),
  ('wrong_category',       'enum.moderation_reasons.wrong_category',       20),
  ('duplicate',            'enum.moderation_reasons.duplicate',            30),
  ('policy_violation',     'enum.moderation_reasons.policy_violation',     40),
  ('prohibited_item',      'enum.moderation_reasons.prohibited_item',      50),
  ('scam_suspected',       'enum.moderation_reasons.scam_suspected',       60),
  ('poor_quality_listing', 'enum.moderation_reasons.poor_quality_listing', 70),
  ('contact_info_exposed', 'enum.moderation_reasons.contact_info_exposed', 80),
  ('other',                'enum.moderation_reasons.other',                90);
--> statement-breakpoint

CREATE TABLE public.post_deletion_reasons (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT post_deletion_reasons_pk PRIMARY KEY (code),
  CONSTRAINT post_deletion_reasons_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER post_deletion_reasons_set_updated_at BEFORE UPDATE ON public.post_deletion_reasons
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.post_deletion_reasons (code, label_key, sort_order) VALUES
  ('user_deleted',      'enum.post_deletion_reasons.user_deleted',      10),
  ('moderator_removed', 'enum.post_deletion_reasons.moderator_removed', 20),
  ('legal_hold',        'enum.post_deletion_reasons.legal_hold',        30),
  ('tenant_terminated', 'enum.post_deletion_reasons.tenant_terminated', 40),
  ('spam_auto',         'enum.post_deletion_reasons.spam_auto',         50);
--> statement-breakpoint

CREATE TABLE public.ownership_resolutions (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ownership_resolutions_pk PRIMARY KEY (code),
  CONSTRAINT ownership_resolutions_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER ownership_resolutions_set_updated_at BEFORE UPDATE ON public.ownership_resolutions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.ownership_resolutions (code, label_key, sort_order) VALUES
  ('inside_boundary',        'enum.ownership_resolutions.inside_boundary',        10),
  ('within_buffer',          'enum.ownership_resolutions.within_buffer',          20),
  ('beyond_buffer_fallback', 'enum.ownership_resolutions.beyond_buffer_fallback', 30),
  ('no_location',            'enum.ownership_resolutions.no_location',            40);
--> statement-breakpoint

CREATE TABLE public.place_sources (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT place_sources_pk PRIMARY KEY (code),
  CONSTRAINT place_sources_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER place_sources_set_updated_at BEFORE UPDATE ON public.place_sources
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.place_sources (code, label_key, sort_order) VALUES
  ('agent_survey',   'enum.place_sources.agent_survey',   10),
  ('user_submitted', 'enum.place_sources.user_submitted', 20),
  ('owner_created',  'enum.place_sources.owner_created',  30),
  ('import',         'enum.place_sources.import',         40);
--> statement-breakpoint

CREATE TABLE public.place_statuses (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT place_statuses_pk PRIMARY KEY (code),
  CONSTRAINT place_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER place_statuses_set_updated_at BEFORE UPDATE ON public.place_statuses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.place_statuses (code, label_key, sort_order) VALUES
  ('pending_review',     'enum.place_statuses.pending_review',     10),
  ('published',          'enum.place_statuses.published',          20),
  ('temporarily_closed', 'enum.place_statuses.temporarily_closed', 30),
  ('permanently_closed', 'enum.place_statuses.permanently_closed', 40),
  ('rejected',           'enum.place_statuses.rejected',           50);
--> statement-breakpoint

CREATE TABLE public.claim_verification_methods (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claim_verification_methods_pk PRIMARY KEY (code),
  CONSTRAINT claim_verification_methods_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER claim_verification_methods_set_updated_at BEFORE UPDATE ON public.claim_verification_methods
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.claim_verification_methods (code, label_key, sort_order) VALUES
  ('otp_to_listed_phone', 'enum.claim_verification_methods.otp_to_listed_phone', 10),
  ('trade_license',       'enum.claim_verification_methods.trade_license',       20),
  ('agent_visit',         'enum.claim_verification_methods.agent_visit',         30),
  ('document',            'enum.claim_verification_methods.document',            40);
--> statement-breakpoint

CREATE TABLE public.claim_statuses (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claim_statuses_pk PRIMARY KEY (code),
  CONSTRAINT claim_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER claim_statuses_set_updated_at BEFORE UPDATE ON public.claim_statuses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.claim_statuses (code, label_key, sort_order) VALUES
  ('pending',   'enum.claim_statuses.pending',   10),
  ('approved',  'enum.claim_statuses.approved',  20),
  ('rejected',  'enum.claim_statuses.rejected',  30),
  ('withdrawn', 'enum.claim_statuses.withdrawn', 40),
  ('revoked',   'enum.claim_statuses.revoked',   50);
--> statement-breakpoint

-- ============================================================================
-- media_assets (§4.1): TENANT-SCOPED, one uploaded file
-- ============================================================================

CREATE TABLE public.media_assets (
  id                  uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id           uuid        NOT NULL DEFAULT public.current_tenant_id(),
  uploaded_by_user_id uuid,
  kind_code           text        NOT NULL,
  visibility_code     text        NOT NULL DEFAULT 'public',
  storage_key         text        NOT NULL,
  mime_type           text        NOT NULL,
  byte_size           bigint      NOT NULL,
  width               integer,
  height              integer,
  duration_ms         integer,
  checksum_sha256     text        NOT NULL,
  blurhash            text,
  variants            jsonb       NOT NULL DEFAULT '{}',
  status_code         text        NOT NULL DEFAULT 'pending_upload',
  evidence_hold       boolean     NOT NULL DEFAULT false,
  purge_due_at        timestamptz,
  purged_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CONSTRAINT media_assets_pk PRIMARY KEY (id),
  CONSTRAINT media_assets_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT media_assets_uploaded_by_user_id_fk FOREIGN KEY (uploaded_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT media_assets_kind_code_fk FOREIGN KEY (kind_code)
    REFERENCES public.media_kinds (code) ON DELETE RESTRICT,
  CONSTRAINT media_assets_visibility_code_fk FOREIGN KEY (visibility_code)
    REFERENCES public.media_visibilities (code) ON DELETE RESTRICT,
  CONSTRAINT media_assets_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.media_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT media_assets_byte_size_ck CHECK (byte_size > 0),
  CONSTRAINT media_assets_variants_ck CHECK (jsonb_typeof(variants) = 'object'),
  CONSTRAINT media_assets_purged_at_ck CHECK (purged_at IS NULL OR deleted_at IS NOT NULL),
  -- Composite-FK target (§0.4).
  CONSTRAINT media_assets_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX media_assets_storage_key_uq ON public.media_assets (storage_key);
--> statement-breakpoint
-- "My uploads", per-user upload quota.
CREATE INDEX media_assets_tenant_id_uploaded_by_user_id_idx
  ON public.media_assets (tenant_id, uploaded_by_user_id, id DESC);
--> statement-breakpoint
-- Cross-tenant system job: delete stale pending uploads.
CREATE INDEX media_assets_pending_upload_idx ON public.media_assets (status_code, created_at)
  WHERE status_code = 'pending_upload';
--> statement-breakpoint
-- Reuse identical uploads; block re-uploads of removed scam images.
CREATE INDEX media_assets_tenant_id_checksum_idx ON public.media_assets (tenant_id, checksum_sha256);
--> statement-breakpoint
-- Cross-tenant system purge job.
CREATE INDEX media_assets_purge_due_idx ON public.media_assets (purge_due_at)
  WHERE purge_due_at IS NOT NULL AND purged_at IS NULL AND NOT evidence_hold;
--> statement-breakpoint
CREATE TRIGGER media_assets_set_updated_at BEFORE UPDATE ON public.media_assets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- Status transitions are system-only: an uploader/staff UPDATE can touch
-- anything else, but status_code only moves via the processing worker.
CREATE OR REPLACE FUNCTION public.media_assets_protect_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT public.app_is_system() THEN
    NEW.status_code := OLD.status_code;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER media_assets_a_protect_status BEFORE UPDATE ON public.media_assets
  FOR EACH ROW EXECUTE FUNCTION public.media_assets_protect_status();
--> statement-breakpoint

-- ============================================================================
-- posts (§4.2): TENANT-SCOPED, the core listing
-- ============================================================================

CREATE TABLE public.posts (
  id                          uuid           NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                   uuid           NOT NULL DEFAULT public.current_tenant_id(),
  author_member_id            uuid,
  store_id                    uuid,  -- FK added with stores (0006)
  category_id                 uuid           NOT NULL,
  field_schema_id             uuid           NOT NULL,
  title                       text           NOT NULL,
  description                 text,
  fields                      jsonb          NOT NULL DEFAULT '{}',
  price                       numeric(12,2)  GENERATED ALWAYS AS (((fields ->> 'price'))::numeric(12,2)) STORED,
  bedrooms                    smallint       GENERATED ALWAYS AS (((fields ->> 'bedrooms'))::smallint) STORED,
  seats                       smallint       GENERATED ALWAYS AS (((fields ->> 'seats'))::smallint) STORED,
  area                        numeric(12,2)  GENERATED ALWAYS AS (((fields ->> 'area'))::numeric(12,2)) STORED,
  price_type_code             text,
  currency                    char(3)        NOT NULL DEFAULT 'BDT',
  locality_id                 uuid,
  geo_area_id                 uuid,
  geo_area_id_coarse          uuid           NOT NULL,
  location                    geography(Point, 4326),
  outside_boundary            boolean        NOT NULL DEFAULT false,
  ownership_resolution_code   text           NOT NULL DEFAULT 'inside_boundary',
  location_is_approximate     boolean        NOT NULL DEFAULT true,
  contact_phone_e164          text,
  contact_name                text,
  show_phone                  boolean        NOT NULL DEFAULT true,
  allow_chat                  boolean        NOT NULL DEFAULT true,
  status_code                 text           NOT NULL DEFAULT 'draft',
  sold_at                     timestamptz,
  sold_price                  numeric(12,2),
  moderation_reason_code      text,
  moderated_by_user_id        uuid,
  moderated_at                timestamptz,
  published_at                timestamptz,
  expires_at                  timestamptz,
  bumped_at                   timestamptz,
  credits_charged             integer        NOT NULL DEFAULT 0,
  view_count                  integer        NOT NULL DEFAULT 0,
  search_synced_at            timestamptz,
  hidden_by_owner             boolean        NOT NULL DEFAULT false,
  scrubbed_at                 timestamptz,
  scrub_reason                text,
  deletion_reason_code        text,
  deleted_by_user_id          uuid,
  created_at                  timestamptz    NOT NULL DEFAULT now(),
  updated_at                  timestamptz    NOT NULL DEFAULT now(),
  deleted_at                  timestamptz,
  CONSTRAINT posts_pk PRIMARY KEY (id),
  CONSTRAINT posts_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  -- Members are never deleted; this is only ever nulled by the scrub.
  CONSTRAINT posts_tenant_id_author_member_id_fk FOREIGN KEY (tenant_id, author_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE SET NULL (author_member_id),
  CONSTRAINT posts_category_id_fk FOREIGN KEY (category_id)
    REFERENCES public.categories (id) ON DELETE RESTRICT,
  CONSTRAINT posts_field_schema_id_fk FOREIGN KEY (field_schema_id)
    REFERENCES public.category_field_schemas (id) ON DELETE RESTRICT,
  CONSTRAINT posts_price_type_code_fk FOREIGN KEY (price_type_code)
    REFERENCES public.price_types (code) ON DELETE RESTRICT,
  CONSTRAINT posts_tenant_id_locality_id_fk FOREIGN KEY (tenant_id, locality_id)
    REFERENCES public.localities (tenant_id, id) ON DELETE SET NULL (locality_id),
  CONSTRAINT posts_geo_area_id_fk FOREIGN KEY (geo_area_id)
    REFERENCES public.geo_areas (id) ON DELETE RESTRICT,
  CONSTRAINT posts_geo_area_id_coarse_fk FOREIGN KEY (geo_area_id_coarse)
    REFERENCES public.geo_areas (id) ON DELETE RESTRICT,
  CONSTRAINT posts_ownership_resolution_code_fk FOREIGN KEY (ownership_resolution_code)
    REFERENCES public.ownership_resolutions (code) ON DELETE RESTRICT,
  CONSTRAINT posts_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.post_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT posts_moderation_reason_code_fk FOREIGN KEY (moderation_reason_code)
    REFERENCES public.moderation_reasons (code) ON DELETE RESTRICT,
  CONSTRAINT posts_moderated_by_user_id_fk FOREIGN KEY (moderated_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT posts_deletion_reason_code_fk FOREIGN KEY (deletion_reason_code)
    REFERENCES public.post_deletion_reasons (code) ON DELETE RESTRICT,
  CONSTRAINT posts_deleted_by_user_id_fk FOREIGN KEY (deleted_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT posts_author_or_scrubbed_ck CHECK (author_member_id IS NOT NULL OR scrubbed_at IS NOT NULL),
  CONSTRAINT posts_title_ck CHECK (title <> '' OR scrubbed_at IS NOT NULL),
  CONSTRAINT posts_fields_ck CHECK (jsonb_typeof(fields) = 'object'),
  CONSTRAINT posts_price_ck CHECK (price IS NULL OR price >= 0),
  CONSTRAINT posts_free_price_ck CHECK (price_type_code <> 'free' OR price IS NULL OR price = 0),
  CONSTRAINT posts_geo_area_id_coarse_scrub_ck
    CHECK (scrubbed_at IS NULL OR (location IS NULL AND geo_area_id IS NULL)),
  CONSTRAINT posts_outside_boundary_ck
    CHECK (outside_boundary = (ownership_resolution_code IN ('within_buffer', 'beyond_buffer_fallback'))),
  CONSTRAINT posts_sold_at_ck CHECK ((status_code = 'sold') = (sold_at IS NOT NULL)),
  CONSTRAINT posts_sold_price_ck
    CHECK (sold_price IS NULL OR (status_code = 'sold' AND sold_price >= 0)),
  CONSTRAINT posts_published_at_ck
    CHECK (status_code NOT IN ('live', 'sold') OR published_at IS NOT NULL),
  CONSTRAINT posts_credits_charged_ck CHECK (credits_charged >= 0),
  CONSTRAINT posts_scrub_reason_ck CHECK ((scrubbed_at IS NULL) = (scrub_reason IS NULL)),
  CONSTRAINT posts_deletion_reason_ck CHECK ((deleted_at IS NULL) = (deletion_reason_code IS NULL)),
  CONSTRAINT posts_moderator_removed_scrubbed_ck
    CHECK (deletion_reason_code <> 'moderator_removed' OR scrubbed_at IS NOT NULL),
  -- Composite-FK target (§0.4).
  CONSTRAINT posts_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- Category feed (DB fallback; primary listing search is Meilisearch).
CREATE INDEX posts_tenant_id_category_id_bumped_at_idx
  ON public.posts (tenant_id, category_id, bumped_at DESC)
  WHERE status_code = 'live' AND deleted_at IS NULL AND NOT hidden_by_owner;
--> statement-breakpoint
-- "Latest in my area" home feed.
CREATE INDEX posts_tenant_id_bumped_at_idx ON public.posts (tenant_id, bumped_at DESC)
  WHERE status_code = 'live' AND deleted_at IS NULL AND NOT hidden_by_owner;
--> statement-breakpoint
-- "My posts": every status incl. sold and removed-with-reason.
CREATE INDEX posts_tenant_id_author_member_id_idx
  ON public.posts (tenant_id, author_member_id, hidden_by_owner, id DESC)
  WHERE author_member_id IS NOT NULL;
--> statement-breakpoint
-- Store page: live listings plus sold ones with a badge.
CREATE INDEX posts_tenant_id_store_id_bumped_at_idx
  ON public.posts (tenant_id, store_id, bumped_at DESC)
  WHERE store_id IS NOT NULL AND status_code IN ('live', 'sold') AND deleted_at IS NULL AND NOT hidden_by_owner;
--> statement-breakpoint
-- Moderation queue.
CREATE INDEX posts_tenant_id_pending_idx ON public.posts (tenant_id, id)
  WHERE status_code = 'pending';
--> statement-breakpoint
-- "Posted far outside any tenant" moderation queue.
CREATE INDEX posts_beyond_buffer_pending_idx ON public.posts (tenant_id, id)
  WHERE ownership_resolution_code = 'beyond_buffer_fallback' AND status_code = 'pending';
--> statement-breakpoint
-- Cross-tenant radius discovery fallback (discover_nearby(), §13.26).
-- Deliberately not tenant-leading.
CREATE INDEX posts_location_gist_idx ON public.posts USING gist (location)
  WHERE status_code = 'live' AND deleted_at IS NULL AND NOT hidden_by_owner;
--> statement-breakpoint
-- Cross-tenant system job: move live posts to expired.
CREATE INDEX posts_expires_at_idx ON public.posts (expires_at)
  WHERE status_code = 'live';
--> statement-breakpoint
-- Cross-tenant system job: price suggestions and demand insights. Includes
-- hidden and scrubbed posts on purpose.
CREATE INDEX posts_category_geo_area_coarse_sold_idx
  ON public.posts (category_id, geo_area_id_coarse, sold_at)
  WHERE status_code = 'sold';
--> statement-breakpoint
-- Cross-tenant list of posts currently hidden under a hold.
CREATE INDEX posts_legal_hold_idx ON public.posts (deletion_reason_code, id)
  WHERE deletion_reason_code = 'legal_hold';
--> statement-breakpoint
-- Per-tenant price history by area.
CREATE INDEX posts_tenant_category_geo_area_coarse_sold_idx
  ON public.posts (tenant_id, category_id, geo_area_id_coarse, sold_at)
  WHERE status_code = 'sold';
--> statement-breakpoint
-- Search sync sweeper that catches missed outbox events.
CREATE INDEX posts_search_sync_idx ON public.posts (updated_at)
  WHERE search_synced_at IS NULL OR search_synced_at < updated_at;
--> statement-breakpoint
-- Containment filters on custom fields; DB fallback when Meilisearch is
-- unavailable.
CREATE INDEX posts_fields_gin_idx ON public.posts USING gin (fields jsonb_path_ops);
--> statement-breakpoint
-- Range filters (hot query, per instructions): price / bedrooms / seats / area.
CREATE INDEX posts_tenant_category_price_idx ON public.posts (tenant_id, category_id, price)
  WHERE status_code = 'live' AND deleted_at IS NULL AND NOT hidden_by_owner;
--> statement-breakpoint
CREATE INDEX posts_tenant_category_bedrooms_idx ON public.posts (tenant_id, category_id, bedrooms)
  WHERE bedrooms IS NOT NULL AND status_code = 'live' AND deleted_at IS NULL AND NOT hidden_by_owner;
--> statement-breakpoint
CREATE INDEX posts_tenant_category_seats_idx ON public.posts (tenant_id, category_id, seats)
  WHERE seats IS NOT NULL AND status_code = 'live' AND deleted_at IS NULL AND NOT hidden_by_owner;
--> statement-breakpoint
CREATE INDEX posts_tenant_category_area_idx ON public.posts (tenant_id, category_id, area)
  WHERE area IS NOT NULL AND status_code = 'live' AND deleted_at IS NULL AND NOT hidden_by_owner;
--> statement-breakpoint
-- Hot query (instructions): (tenant_id, category_id, status, created_at DESC).
-- Complements bumped_at-ordered indexes above with a creation-order view
-- (e.g. moderation/admin listings sorted by newest first regardless of bumps).
CREATE INDEX posts_tenant_category_status_created_idx
  ON public.posts (tenant_id, category_id, status_code, created_at DESC);
--> statement-breakpoint
CREATE TRIGGER posts_set_updated_at BEFORE UPDATE ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- category_id must not be a place-kind category, and field_schema_id must
-- be a schema version of that same category.
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
  IF category_kind = 'place' THEN
    RAISE EXCEPTION 'posts.category_id % is a place-kind category; posts cannot use it', NEW.category_id
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
CREATE TRIGGER posts_a_validate_category_and_schema
  BEFORE INSERT OR UPDATE OF category_id, field_schema_id ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.posts_validate_category_and_schema();
--> statement-breakpoint

-- geo_area_id_coarse (Q52): the upazila-level ancestor of geo_area_id, or
-- the owning tenant's own area when there's no location.
CREATE OR REPLACE FUNCTION public.posts_maintain_geo_area_id_coarse()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  candidate public.geo_areas%ROWTYPE;
  tenant_area_id uuid;
BEGIN
  IF NEW.geo_area_id IS NULL THEN
    SELECT geo_area_id INTO tenant_area_id FROM public.tenants WHERE id = NEW.tenant_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'posts.tenant_id % does not exist', NEW.tenant_id;
    END IF;
    NEW.geo_area_id_coarse := tenant_area_id;
    RETURN NEW;
  END IF;

  SELECT * INTO candidate FROM public.geo_areas WHERE id = NEW.geo_area_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'posts.geo_area_id % does not exist', NEW.geo_area_id;
  END IF;

  IF candidate.level_code = 'upazila' THEN
    NEW.geo_area_id_coarse := candidate.id;
  ELSE
    SELECT ga.id INTO NEW.geo_area_id_coarse
    FROM public.geo_areas ga
    WHERE ga.id = ANY (candidate.ancestor_ids) AND ga.level_code = 'upazila'
    LIMIT 1;
    -- No upazila ancestor (e.g. a metro_thana branch) falls back to the
    -- area itself rather than leaving geo_area_id_coarse unset.
    IF NEW.geo_area_id_coarse IS NULL THEN
      NEW.geo_area_id_coarse := candidate.id;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER posts_a_maintain_geo_area_id_coarse
  BEFORE INSERT OR UPDATE OF geo_area_id, tenant_id ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.posts_maintain_geo_area_id_coarse();
--> statement-breakpoint

-- ============================================================================
-- places (§4.4): TENANT-SCOPED, local business directory entry
-- ============================================================================

CREATE TABLE public.places (
  id                    uuid           NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id             uuid           NOT NULL DEFAULT public.current_tenant_id(),
  category_id           uuid           NOT NULL,
  field_schema_id       uuid,
  slug                  text           NOT NULL,
  name_bn               text           NOT NULL,
  name_en               text,
  description           text,
  fields                jsonb          NOT NULL DEFAULT '{}',
  phones                text[]         NOT NULL DEFAULT '{}',
  website_url           text,
  facebook_url          text,
  address_text          text,
  locality_id           uuid,
  geo_area_id           uuid,
  location              geography(Point, 4326) NOT NULL,
  outside_boundary      boolean        NOT NULL DEFAULT false,
  is_landmark           boolean        NOT NULL DEFAULT false,
  landmark_radius_km    numeric(6,2),
  source_code           text           NOT NULL,
  created_by_user_id    uuid,
  claimed_by_member_id  uuid,
  field_verified_at     timestamptz,
  status_code           text           NOT NULL DEFAULT 'pending_review',
  rating_avg            numeric(3,2),
  rating_count          integer        NOT NULL DEFAULT 0,
  search_synced_at      timestamptz,
  created_at            timestamptz    NOT NULL DEFAULT now(),
  updated_at            timestamptz    NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  CONSTRAINT places_pk PRIMARY KEY (id),
  CONSTRAINT places_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT places_category_id_fk FOREIGN KEY (category_id)
    REFERENCES public.categories (id) ON DELETE RESTRICT,
  CONSTRAINT places_field_schema_id_fk FOREIGN KEY (field_schema_id)
    REFERENCES public.category_field_schemas (id) ON DELETE RESTRICT,
  CONSTRAINT places_tenant_id_locality_id_fk FOREIGN KEY (tenant_id, locality_id)
    REFERENCES public.localities (tenant_id, id) ON DELETE SET NULL (locality_id),
  CONSTRAINT places_geo_area_id_fk FOREIGN KEY (geo_area_id)
    REFERENCES public.geo_areas (id) ON DELETE RESTRICT,
  CONSTRAINT places_source_code_fk FOREIGN KEY (source_code)
    REFERENCES public.place_sources (code) ON DELETE RESTRICT,
  CONSTRAINT places_created_by_user_id_fk FOREIGN KEY (created_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT places_tenant_id_claimed_by_member_id_fk FOREIGN KEY (tenant_id, claimed_by_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE SET NULL (claimed_by_member_id),
  CONSTRAINT places_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.place_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT places_slug_ck CHECK (slug = lower(slug)),
  CONSTRAINT places_fields_ck CHECK (jsonb_typeof(fields) = 'object'),
  CONSTRAINT places_landmark_radius_km_ck CHECK (landmark_radius_km IS NULL OR landmark_radius_km > 0),
  CONSTRAINT places_rating_avg_ck CHECK (rating_avg IS NULL OR rating_avg BETWEEN 0 AND 5),
  CONSTRAINT places_rating_count_ck CHECK (rating_count >= 0),
  -- Composite-FK target (§0.4).
  CONSTRAINT places_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- Place URLs.
CREATE UNIQUE INDEX places_tenant_id_slug_uq ON public.places (tenant_id, slug)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
-- Directory browsing (DB fallback to Meilisearch).
CREATE INDEX places_tenant_id_category_id_status_idx ON public.places (tenant_id, category_id, status_code);
--> statement-breakpoint
-- "Pharmacies near me" (cross-tenant radius discovery), plus duplicate
-- detection across tenants near a boundary.
CREATE INDEX places_location_gist_idx ON public.places USING gist (location)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
-- Neighbour landmark lookup (neighbour_landmarks()).
CREATE INDEX places_landmark_location_gist_idx ON public.places USING gist (location)
  WHERE is_landmark AND status_code = 'published' AND deleted_at IS NULL;
--> statement-breakpoint
-- "Did you mean this existing place?" — directory duplicates are the #1
-- data-quality problem.
CREATE INDEX places_name_bn_trgm_idx ON public.places USING gin (name_bn gin_trgm_ops);
--> statement-breakpoint
-- "My businesses".
CREATE INDEX places_tenant_id_claimed_by_member_id_idx ON public.places (tenant_id, claimed_by_member_id)
  WHERE claimed_by_member_id IS NOT NULL;
--> statement-breakpoint
-- Search sync safety-net sweeper.
CREATE INDEX places_search_sync_idx ON public.places (updated_at)
  WHERE search_synced_at IS NULL OR search_synced_at < updated_at;
--> statement-breakpoint
CREATE TRIGGER places_set_updated_at BEFORE UPDATE ON public.places
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.places_validate_category()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  category_kind text;
BEGIN
  SELECT kind_code INTO category_kind FROM public.categories WHERE id = NEW.category_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'places.category_id % does not exist', NEW.category_id;
  END IF;
  IF category_kind <> 'place' THEN
    RAISE EXCEPTION 'places.category_id % must be a place-kind category', NEW.category_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER places_a_validate_category BEFORE INSERT OR UPDATE OF category_id ON public.places
  FOR EACH ROW EXECUTE FUNCTION public.places_validate_category();
--> statement-breakpoint

-- is_landmark / landmark_radius_km are staff-only: any other caller's
-- attempt to change them is silently reverted to the previous (or default,
-- on insert) value rather than rejected outright, matching
-- user_profiles_protect_system_columns's pattern from 0003.
CREATE OR REPLACE FUNCTION public.places_protect_landmark_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF public.app_is_staff() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.is_landmark := false;
    NEW.landmark_radius_km := NULL;
  ELSE
    NEW.is_landmark := OLD.is_landmark;
    NEW.landmark_radius_km := OLD.landmark_radius_km;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER places_a_protect_landmark_columns BEFORE INSERT OR UPDATE ON public.places
  FOR EACH ROW EXECUTE FUNCTION public.places_protect_landmark_columns();
--> statement-breakpoint

-- ============================================================================
-- place_hours (§4.5): TENANT-SCOPED, weekly opening hours
-- ============================================================================

CREATE TABLE public.place_hours (
  id                uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id         uuid        NOT NULL DEFAULT public.current_tenant_id(),
  place_id          uuid        NOT NULL,
  iso_day_of_week   smallint    NOT NULL,
  opens_at          time        NOT NULL,
  closes_at         time        NOT NULL,
  closes_next_day   boolean     NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT place_hours_pk PRIMARY KEY (id),
  CONSTRAINT place_hours_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT place_hours_tenant_id_place_id_fk FOREIGN KEY (tenant_id, place_id)
    REFERENCES public.places (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT place_hours_iso_day_of_week_ck CHECK (iso_day_of_week BETWEEN 1 AND 7),
  CONSTRAINT place_hours_closes_at_ck CHECK (closes_next_day OR closes_at > opens_at)
);
--> statement-breakpoint
-- Render hours, compute "open now". No row for a day = closed that day.
CREATE INDEX place_hours_tenant_place_day_idx
  ON public.place_hours (tenant_id, place_id, iso_day_of_week, opens_at);
--> statement-breakpoint
CREATE TRIGGER place_hours_set_updated_at BEFORE UPDATE ON public.place_hours
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- place_claims (§4.6): TENANT-SCOPED, a member's ownership request
-- ============================================================================

CREATE TABLE public.place_claims (
  id                          uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                   uuid        NOT NULL DEFAULT public.current_tenant_id(),
  place_id                    uuid        NOT NULL,
  claimant_member_id          uuid        NOT NULL,
  verification_method_code    text        NOT NULL,
  status_code                 text        NOT NULL DEFAULT 'pending',
  claimant_note                text,
  agent_visit_id               uuid,  -- FK added with agent_visits (0012)
  reviewed_by_user_id          uuid,
  reviewed_at                  timestamptz,
  rejection_reason_code        text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT place_claims_pk PRIMARY KEY (id),
  CONSTRAINT place_claims_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT place_claims_tenant_id_place_id_fk FOREIGN KEY (tenant_id, place_id)
    REFERENCES public.places (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT place_claims_tenant_id_claimant_member_id_fk FOREIGN KEY (tenant_id, claimant_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT place_claims_verification_method_code_fk FOREIGN KEY (verification_method_code)
    REFERENCES public.claim_verification_methods (code) ON DELETE RESTRICT,
  CONSTRAINT place_claims_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.claim_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT place_claims_reviewed_by_user_id_fk FOREIGN KEY (reviewed_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT place_claims_rejection_reason_code_fk FOREIGN KEY (rejection_reason_code)
    REFERENCES public.moderation_reasons (code) ON DELETE RESTRICT,
  -- Composite-FK target (§0.4).
  CONSTRAINT place_claims_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- One open claim per person per place; competing claims from different
-- people are allowed and resolved by staff.
CREATE UNIQUE INDEX place_claims_open_uq ON public.place_claims (tenant_id, place_id, claimant_member_id)
  WHERE status_code = 'pending';
--> statement-breakpoint
-- Review queue.
CREATE INDEX place_claims_pending_idx ON public.place_claims (tenant_id, id)
  WHERE status_code = 'pending';
--> statement-breakpoint
-- "My claims".
CREATE INDEX place_claims_tenant_claimant_idx ON public.place_claims (tenant_id, claimant_member_id, id DESC);
--> statement-breakpoint
-- FK index (§0.4).
CREATE INDEX place_claims_agent_visit_id_idx ON public.place_claims (agent_visit_id)
  WHERE agent_visit_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER place_claims_set_updated_at BEFORE UPDATE ON public.place_claims
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- saved_posts (§4.7): TENANT-SCOPED (= the post's owning tenant)
-- ============================================================================

CREATE TABLE public.saved_posts (
  id          uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id   uuid        NOT NULL DEFAULT public.current_tenant_id(),
  user_id     uuid        NOT NULL,
  post_id     uuid        NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_posts_pk PRIMARY KEY (id),
  CONSTRAINT saved_posts_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT saved_posts_user_id_fk FOREIGN KEY (user_id)
    REFERENCES public.users (id) ON DELETE CASCADE,
  -- Saved items survive post deletion (§13.31); posts are never hard-deleted.
  CONSTRAINT saved_posts_tenant_id_post_id_fk FOREIGN KEY (tenant_id, post_id)
    REFERENCES public.posts (tenant_id, id) ON DELETE RESTRICT
);
--> statement-breakpoint
-- One save per post; also the tenant_id index.
CREATE UNIQUE INDEX saved_posts_tenant_user_post_uq ON public.saved_posts (tenant_id, user_id, post_id);
--> statement-breakpoint
-- "My saved posts" across tenants.
CREATE INDEX saved_posts_user_id_idx ON public.saved_posts (user_id, id DESC);
--> statement-breakpoint
-- FK index (§0.4); "saved by N people".
CREATE INDEX saved_posts_tenant_id_post_id_idx ON public.saved_posts (tenant_id, post_id);
--> statement-breakpoint
CREATE TRIGGER saved_posts_set_updated_at BEFORE UPDATE ON public.saved_posts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- media_attachments (§4.3): TENANT-SCOPED, polymorphic; see header for the
-- deferred-FK plan on the six owner columns whose targets don't exist yet.
-- ============================================================================

CREATE TABLE public.media_attachments (
  id                          uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                   uuid        NOT NULL DEFAULT public.current_tenant_id(),
  media_asset_id               uuid        NOT NULL,
  post_id                      uuid,
  place_id                     uuid,
  store_id                     uuid,  -- FK added with stores (0006)
  review_id                    uuid,  -- FK added with reviews (0010)
  place_claim_id                uuid,
  business_verification_id      uuid,  -- FK added with business_verifications (0010)
  notice_id                     uuid,  -- FK added with notices (0011)
  lost_found_item_id            uuid,  -- FK added with lost_found_items (0011)
  agent_visit_id                uuid,  -- FK added with agent_visits (0012)
  ticket_message_id             uuid,  -- FK added with ticket_messages (0012)
  sort_order                  smallint    NOT NULL DEFAULT 0,
  caption                     text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_attachments_pk PRIMARY KEY (id),
  CONSTRAINT media_attachments_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT media_attachments_tenant_id_media_asset_id_fk FOREIGN KEY (tenant_id, media_asset_id)
    REFERENCES public.media_assets (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT media_attachments_tenant_id_post_id_fk FOREIGN KEY (tenant_id, post_id)
    REFERENCES public.posts (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT media_attachments_tenant_id_place_id_fk FOREIGN KEY (tenant_id, place_id)
    REFERENCES public.places (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT media_attachments_tenant_id_place_claim_id_fk FOREIGN KEY (tenant_id, place_claim_id)
    REFERENCES public.place_claims (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT media_attachments_exactly_one_owner_ck CHECK (
    num_nonnulls(
      post_id, place_id, store_id, review_id, place_claim_id,
      business_verification_id, notice_id, lost_found_item_id,
      agent_visit_id, ticket_message_id
    ) = 1
  )
);
--> statement-breakpoint
-- FK index for media_asset_id (§0.4); "where is this image used".
CREATE INDEX media_attachments_tenant_id_media_asset_id_idx
  ON public.media_attachments (tenant_id, media_asset_id);
--> statement-breakpoint
-- One partial ordering index and one partial uniqueness index per owner
-- column (spec: "the same pattern applies to each of the other nine owner
-- columns and doubles as their FK index").
DO $$
DECLARE
  owner_col text;
BEGIN
  FOREACH owner_col IN ARRAY ARRAY[
    'post_id', 'place_id', 'store_id', 'review_id', 'place_claim_id',
    'business_verification_id', 'notice_id', 'lost_found_item_id',
    'agent_visit_id', 'ticket_message_id'
  ]
  LOOP
    EXECUTE format(
      'CREATE INDEX %I ON public.media_attachments (tenant_id, %I, sort_order) WHERE %I IS NOT NULL',
      'media_attachments_' || owner_col || '_sort_idx', owner_col, owner_col
    );
    EXECUTE format(
      'CREATE UNIQUE INDEX %I ON public.media_attachments (%I, media_asset_id) WHERE %I IS NOT NULL',
      'media_attachments_' || owner_col || '_media_asset_id_uq', owner_col, owner_col
    );
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE TRIGGER media_attachments_set_updated_at BEFORE UPDATE ON public.media_attachments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
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
        'media_kinds', 'media_visibilities', 'media_statuses', 'price_types', 'post_statuses',
        'moderation_reasons', 'post_deletion_reasons', 'ownership_resolutions', 'place_sources',
        'place_statuses', 'claim_verification_methods', 'claim_statuses',
        'media_assets', 'posts', 'places', 'place_hours', 'place_claims', 'saved_posts',
        'media_attachments'
      )
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.ident);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', obj.ident);
  END LOOP;
END
$$;
--> statement-breakpoint

-- ---- enum tables: read by all, write by platform admin (as 0002-0004) ----

DO $$
DECLARE
  enum_table text;
BEGIN
  FOREACH enum_table IN ARRAY ARRAY[
    'media_kinds', 'media_visibilities', 'media_statuses', 'price_types', 'post_statuses',
    'moderation_reasons', 'post_deletion_reasons', 'ownership_resolutions', 'place_sources',
    'place_statuses', 'claim_verification_methods', 'claim_statuses'
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

-- ---- media_assets: T-ISOLATE, visibility-graded --------------------------

CREATE POLICY media_assets_public_read ON public.media_assets
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND visibility_code = 'public'
    AND status_code = 'ready'
    AND deleted_at IS NULL
  );
--> statement-breakpoint
CREATE POLICY media_assets_private_read ON public.media_assets
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND (uploaded_by_user_id = (SELECT public.current_user_id()) OR (SELECT public.app_is_staff()))
  );
--> statement-breakpoint
CREATE POLICY media_assets_member_insert ON public.media_assets
  FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND uploaded_by_user_id = (SELECT public.current_user_id())
  );
--> statement-breakpoint
CREATE POLICY media_assets_owner_or_staff_update ON public.media_assets
  FOR UPDATE
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND (uploaded_by_user_id = (SELECT public.current_user_id()) OR (SELECT public.app_is_staff()))
  )
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND (uploaded_by_user_id = (SELECT public.current_user_id()) OR (SELECT public.app_is_staff()))
  );
--> statement-breakpoint
CREATE POLICY media_assets_platform_admin ON public.media_assets
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- posts: T-PUBLIC-READ + author (excl. legal_hold) + staff + platform -

CREATE POLICY posts_public_read ON public.posts
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND status_code IN ('live', 'sold')
    AND deleted_at IS NULL
    AND NOT hidden_by_owner
  );
--> statement-breakpoint
-- The author reads/updates their own posts in any status, including their
-- own deleted ones (for appeals) — except legal_hold, which is platform-only.
CREATE POLICY posts_author_access ON public.posts
  FOR ALL
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND author_member_id = (SELECT public.current_member_id())
    AND deletion_reason_code IS DISTINCT FROM 'legal_hold'
  )
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND author_member_id = (SELECT public.current_member_id())
  );
--> statement-breakpoint
CREATE POLICY posts_staff_access ON public.posts
  FOR ALL
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND (SELECT public.app_is_staff())
    AND deletion_reason_code IS DISTINCT FROM 'legal_hold'
  )
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY posts_platform_admin ON public.posts
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- media_attachments: T-ISOLATE; SELECT follows the asset's visibility -

CREATE POLICY media_attachments_read ON public.media_attachments
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND EXISTS (
      SELECT 1 FROM public.media_assets ma
      WHERE ma.id = media_attachments.media_asset_id
        AND (
          (ma.visibility_code = 'public' AND ma.status_code = 'ready' AND ma.deleted_at IS NULL)
          OR ma.uploaded_by_user_id = (SELECT public.current_user_id())
          OR (SELECT public.app_is_staff())
        )
    )
  );
--> statement-breakpoint
CREATE POLICY media_attachments_write ON public.media_attachments
  FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND EXISTS (
      SELECT 1 FROM public.media_assets ma
      WHERE ma.id = media_attachments.media_asset_id
        AND (ma.uploaded_by_user_id = (SELECT public.current_user_id()) OR (SELECT public.app_is_staff()))
    )
  );
--> statement-breakpoint
CREATE POLICY media_attachments_delete ON public.media_attachments
  FOR DELETE
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND EXISTS (
      SELECT 1 FROM public.media_assets ma
      WHERE ma.id = media_attachments.media_asset_id
        AND (ma.uploaded_by_user_id = (SELECT public.current_user_id()) OR (SELECT public.app_is_staff()))
    )
  );
--> statement-breakpoint
CREATE POLICY media_attachments_platform_admin ON public.media_attachments
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- places: T-PUBLIC-READ; insert any active member; update staff/agent/owner

CREATE POLICY places_public_read ON public.places
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND status_code IN ('published', 'temporarily_closed', 'permanently_closed')
    AND deleted_at IS NULL
  );
--> statement-breakpoint
CREATE POLICY places_member_insert ON public.places
  FOR INSERT
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_active_user()));
--> statement-breakpoint
CREATE POLICY places_staff_agent_or_owner_update ON public.places
  FOR UPDATE
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND (
      (SELECT public.app_is_staff())
      OR public.app_role() = 'agent'
      OR claimed_by_member_id = (SELECT public.current_member_id())
    )
  )
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND (
      (SELECT public.app_is_staff())
      OR public.app_role() = 'agent'
      OR claimed_by_member_id = (SELECT public.current_member_id())
    )
  );
--> statement-breakpoint
-- Staff/agents also need direct SELECT on non-public rows (e.g.
-- pending_review before the public_read policy would show it).
CREATE POLICY places_staff_agent_read ON public.places
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND ((SELECT public.app_is_staff()) OR public.app_role() = 'agent')
  );
--> statement-breakpoint
CREATE POLICY places_platform_admin ON public.places
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- place_hours: same visibility/writers as the parent place -----------

CREATE POLICY place_hours_public_read ON public.place_hours
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND EXISTS (
      SELECT 1 FROM public.places p
      WHERE p.id = place_hours.place_id
        AND p.status_code IN ('published', 'temporarily_closed', 'permanently_closed')
        AND p.deleted_at IS NULL
    )
  );
--> statement-breakpoint
CREATE POLICY place_hours_write ON public.place_hours
  FOR ALL
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND (
      (SELECT public.app_is_staff())
      OR public.app_role() = 'agent'
      OR EXISTS (
        SELECT 1 FROM public.places p
        WHERE p.id = place_hours.place_id AND p.claimed_by_member_id = (SELECT public.current_member_id())
      )
    )
  )
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND (
      (SELECT public.app_is_staff())
      OR public.app_role() = 'agent'
      OR EXISTS (
        SELECT 1 FROM public.places p
        WHERE p.id = place_hours.place_id AND p.claimed_by_member_id = (SELECT public.current_member_id())
      )
    )
  );
--> statement-breakpoint
CREATE POLICY place_hours_platform_admin ON public.place_hours
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- place_claims: T-ISOLATE; claimant + staff -----------------------

CREATE POLICY place_claims_claimant_read ON public.place_claims
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND claimant_member_id = (SELECT public.current_member_id()));
--> statement-breakpoint
CREATE POLICY place_claims_claimant_insert ON public.place_claims
  FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND claimant_member_id = (SELECT public.current_member_id())
  );
--> statement-breakpoint
-- The claimant may only withdraw, never approve/reject their own claim.
CREATE POLICY place_claims_claimant_withdraw ON public.place_claims
  FOR UPDATE
  USING (tenant_id = (SELECT public.current_tenant_id()) AND claimant_member_id = (SELECT public.current_member_id()))
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND claimant_member_id = (SELECT public.current_member_id())
    AND status_code = 'withdrawn'
  );
--> statement-breakpoint
CREATE POLICY place_claims_staff_access ON public.place_claims
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY place_claims_platform_admin ON public.place_claims
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- saved_posts: owner, cross-tenant (own rows visible in any context) --

CREATE POLICY saved_posts_owner_read ON public.saved_posts
  FOR SELECT
  USING (user_id = (SELECT public.current_user_id()) AND (SELECT public.app_is_active_user()));
--> statement-breakpoint
CREATE POLICY saved_posts_owner_delete ON public.saved_posts
  FOR DELETE
  USING (user_id = (SELECT public.current_user_id()) AND (SELECT public.app_is_active_user()));
--> statement-breakpoint
CREATE POLICY saved_posts_owner_insert ON public.saved_posts
  FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND user_id = (SELECT public.current_user_id())
  );
--> statement-breakpoint
CREATE POLICY saved_posts_platform_admin ON public.saved_posts
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ============================================================================
-- Grants
-- ============================================================================

GRANT SELECT ON
  public.media_kinds, public.media_visibilities, public.media_statuses, public.price_types,
  public.post_statuses, public.moderation_reasons, public.post_deletion_reasons,
  public.ownership_resolutions, public.place_sources, public.place_statuses,
  public.claim_verification_methods, public.claim_statuses
TO ae_app;
--> statement-breakpoint
GRANT INSERT, UPDATE ON
  public.media_kinds, public.media_visibilities, public.media_statuses, public.price_types,
  public.post_statuses, public.moderation_reasons, public.post_deletion_reasons,
  public.ownership_resolutions, public.place_sources, public.place_statuses,
  public.claim_verification_methods, public.claim_statuses
TO ae_app;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.media_assets TO ae_app;
--> statement-breakpoint
-- No DELETE: "no DELETE policy or grant on posts" (§4.2) — soft delete only.
GRANT SELECT, INSERT, UPDATE ON public.posts TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.media_attachments TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.places TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.place_hours TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.place_claims TO ae_app;
--> statement-breakpoint
-- No UPDATE: spec lists exactly SELECT/DELETE (owner) and INSERT (§4.7).
GRANT SELECT, INSERT, DELETE ON public.saved_posts TO ae_app;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.app_is_active_user() TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.current_member_id() TO ae_app;
