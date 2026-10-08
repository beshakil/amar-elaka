-- 0052_store_import_and_catalog
--
-- Seller productivity (ADR 056): bulk upload into a store, and the WhatsApp
-- catalog.
--
--   media_kinds          + import: a CSV, XLSX or ZIP a seller uploads for a
--                          bulk import (private bucket, magic-byte checked at
--                          confirm; never shown to anyone).
--   store_imports        NEW, TENANT-SCOPED. One import: the store, the
--                          category, the sheet and image ZIP, dry run or not,
--                          status (queued → running → succeeded | failed),
--                          progress and the counts.
--   store_import_rows    NEW, TENANT-SCOPED. One outcome per sheet row:
--                          created | valid (dry run) | skipped | failed, the
--                          reason code and the exact reason, the post made.
--                          The downloadable report is these rows.
--   lead_sources         + store_catalog: an order tap on the WhatsApp catalog.
--   settings             store_import_max_rows, store_import_max_file_bytes,
--                          store_import_zip_max_entries,
--                          store_import_zip_max_unpacked_bytes,
--                          store_import_image_fetch_timeout_ms,
--                          store_import_image_fetch_attempts,
--                          store_catalog_page_max.
--   my_post_stats()      CHANGED: counts personal posts only. A store's posts
--                          are bounded by its catalog limit, not by its
--                          staff's personal daily / active limits.
--
-- RLS: a member who may post as the store starts an import and reads their
-- own; the store's owner and managers read every import of the store; the
-- worker (system role) writes progress and rows.
-- No column is dropped or renamed.
-- Tests: apps/api/test/store-import.e2e-spec.ts, rls-store-imports.db-spec.ts,
-- store-catalog.e2e-spec.ts.

SELECT set_config('app.is_platform_admin', 'true', true);
--> statement-breakpoint

INSERT INTO public.media_kinds (code, label_key, sort_order) VALUES
  ('import', 'enum.media_kinds.import', 40);
--> statement-breakpoint

INSERT INTO public.lead_sources (code, label_key, sort_order) VALUES
  ('store_catalog', 'enum.lead_sources.store_catalog', 80);
--> statement-breakpoint

-- ---- store_imports -----------------------------------------------------------------

CREATE TABLE public.store_imports (
  id                    uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id             uuid        NOT NULL DEFAULT public.current_tenant_id(),
  store_id              uuid        NOT NULL,
  category_id           uuid        NOT NULL,
  created_by_member_id  uuid        NOT NULL,
  sheet_media_id        uuid,
  images_media_id       uuid,
  sheet_format          text        NOT NULL,
  dry_run               boolean     NOT NULL DEFAULT false,
  status_code           text        NOT NULL DEFAULT 'queued',
  error_code            text,
  total_rows            integer,
  processed_rows        integer     NOT NULL DEFAULT 0,
  created_count         integer     NOT NULL DEFAULT 0,
  skipped_count         integer     NOT NULL DEFAULT 0,
  failed_count          integer     NOT NULL DEFAULT 0,
  started_at            timestamptz,
  finished_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_imports_pk PRIMARY KEY (id),
  CONSTRAINT store_imports_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT store_imports_tenant_id_store_id_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT store_imports_category_id_fk FOREIGN KEY (category_id)
    REFERENCES public.categories (id) ON DELETE RESTRICT,
  CONSTRAINT store_imports_tenant_id_created_by_member_id_fk FOREIGN KEY (tenant_id, created_by_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT store_imports_tenant_id_sheet_media_id_fk FOREIGN KEY (tenant_id, sheet_media_id)
    REFERENCES public.media_assets (tenant_id, id) ON DELETE SET NULL (sheet_media_id),
  CONSTRAINT store_imports_tenant_id_images_media_id_fk FOREIGN KEY (tenant_id, images_media_id)
    REFERENCES public.media_assets (tenant_id, id) ON DELETE SET NULL (images_media_id),
  CONSTRAINT store_imports_sheet_format_ck CHECK (sheet_format IN ('csv', 'xlsx')),
  CONSTRAINT store_imports_status_code_ck CHECK (status_code IN ('queued', 'running', 'succeeded', 'failed')),
  CONSTRAINT store_imports_counts_ck CHECK (
    processed_rows >= 0 AND created_count >= 0 AND skipped_count >= 0 AND failed_count >= 0
    AND (total_rows IS NULL OR total_rows >= 0)),
  CONSTRAINT store_imports_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
CREATE INDEX store_imports_tenant_store_idx ON public.store_imports (tenant_id, store_id, id DESC);
--> statement-breakpoint
CREATE INDEX store_imports_member_idx ON public.store_imports (tenant_id, created_by_member_id);
--> statement-breakpoint
CREATE INDEX store_imports_sheet_media_idx ON public.store_imports (tenant_id, sheet_media_id)
  WHERE sheet_media_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX store_imports_images_media_idx ON public.store_imports (tenant_id, images_media_id)
  WHERE images_media_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER store_imports_set_updated_at BEFORE UPDATE ON public.store_imports
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ---- store_import_rows -------------------------------------------------------------

CREATE TABLE public.store_import_rows (
  id           uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id    uuid        NOT NULL DEFAULT public.current_tenant_id(),
  import_id    uuid        NOT NULL,
  row_number   integer     NOT NULL,
  outcome      text        NOT NULL,
  reason_code  text,
  reason       text,
  post_id      uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_import_rows_pk PRIMARY KEY (id),
  CONSTRAINT store_import_rows_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT store_import_rows_tenant_id_import_id_fk FOREIGN KEY (tenant_id, import_id)
    REFERENCES public.store_imports (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT store_import_rows_tenant_id_post_id_fk FOREIGN KEY (tenant_id, post_id)
    REFERENCES public.posts (tenant_id, id) ON DELETE SET NULL (post_id),
  CONSTRAINT store_import_rows_outcome_ck CHECK (outcome IN ('created', 'valid', 'skipped', 'failed')),
  CONSTRAINT store_import_rows_row_number_ck CHECK (row_number >= 1),
  CONSTRAINT store_import_rows_reason_ck CHECK (outcome IN ('created', 'valid') OR reason_code IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX store_import_rows_import_row_uq ON public.store_import_rows (tenant_id, import_id, row_number);
--> statement-breakpoint
CREATE INDEX store_import_rows_post_idx ON public.store_import_rows (tenant_id, post_id) WHERE post_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER store_import_rows_set_updated_at BEFORE UPDATE ON public.store_import_rows
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ---- RLS --------------------------------------------------------------------------

ALTER TABLE public.store_imports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.store_imports FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.store_import_rows ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.store_import_rows FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Whoever may post as the store starts an import, as themselves.
CREATE POLICY store_imports_member_insert ON public.store_imports
  FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND created_by_member_id = (SELECT public.current_member_id())
    AND public.member_may_post_as_store(tenant_id, store_id, created_by_member_id)
  );
--> statement-breakpoint
-- Their own imports; every import of a store its owner and managers run; staff.
CREATE POLICY store_imports_read ON public.store_imports
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND (
      created_by_member_id = (SELECT public.current_member_id())
      OR (SELECT public.can_manage_store(store_id))
      OR (SELECT public.app_is_staff())
    )
  );
--> statement-breakpoint
CREATE POLICY store_imports_system ON public.store_imports
  FOR ALL
  USING ((SELECT public.app_is_system()))
  WITH CHECK ((SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY store_imports_platform_admin ON public.store_imports
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

CREATE POLICY store_import_rows_read ON public.store_import_rows
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND EXISTS (SELECT 1 FROM public.store_imports i WHERE i.tenant_id = store_import_rows.tenant_id
                AND i.id = store_import_rows.import_id)
  );
--> statement-breakpoint
CREATE POLICY store_import_rows_system ON public.store_import_rows
  FOR ALL
  USING ((SELECT public.app_is_system()))
  WITH CHECK ((SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY store_import_rows_platform_admin ON public.store_import_rows
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.store_imports TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_import_rows TO ae_app;
--> statement-breakpoint

-- ---- Settings -----------------------------------------------------------------------

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('store_import_max_rows', '500', 'integer', 'rows', 1, 10000, 'platform',
   'The most rows one bulk import may have; a bigger sheet is refused before any row is read.'),
  ('store_import_max_file_bytes', '20971520', 'integer', 'bytes', 1024, 209715200, 'platform',
   'The largest sheet or image ZIP a seller may upload for a bulk import.'),
  ('store_import_zip_max_entries', '1000', 'integer', 'files', 1, 20000, 'platform',
   'The most files an image ZIP may hold (a guard against ZIP bombs).'),
  ('store_import_zip_max_unpacked_bytes', '524288000', 'integer', 'bytes', 1048576, 2147483648, 'platform',
   'The most an image ZIP may unpack to in total (a guard against ZIP bombs).'),
  ('store_import_image_fetch_timeout_ms', '10000', 'integer', 'milliseconds', 1000, 60000, 'none',
   'How long the import waits for an image URL to answer.'),
  ('store_import_image_fetch_attempts', '2', 'integer', 'attempts', 1, 5, 'none',
   'How many times the import tries an image URL before failing the row.'),
  ('store_catalog_page_max', '200', 'integer', 'products', 10, 1000, 'platform',
   'The most products the WhatsApp catalog page lists (newest first).');
--> statement-breakpoint

-- ---- Personal limits are for personal posts (ADR 056) -----------------------------
-- A store's posts are bounded by its catalog limit (store_catalog_max_<tier>,
-- checked on every store post since 0050), not by its staff's personal daily /
-- active limits: an import of a few hundred rows would otherwise stop at the
-- tenth. Personal posts keep the personal limits, uncrowded by store posts.

SET LOCAL ROLE ae_rls_bypass;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.my_post_stats(p_created_since timestamptz)
RETURNS TABLE (active_count integer, created_since_count integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    count(*) FILTER (WHERE p.status_code IN ('pending', 'live') AND p.deleted_at IS NULL)::integer,
    count(*) FILTER (WHERE p.created_at >= p_created_since)::integer
  FROM public.posts p
  JOIN public.tenant_members tm ON tm.tenant_id = p.tenant_id AND tm.id = p.author_member_id
  WHERE tm.user_id = public.current_user_id()
    AND p.store_id IS NULL
$$;
--> statement-breakpoint
RESET ROLE;
