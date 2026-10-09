-- 0053_store_seller_tools
--
-- Store and seller UI (ADR 057): what the seller screens need that the API
-- did not have yet.
--
--   stock_statuses       NEW lookup: in_stock | out_of_stock | on_order.
--   posts                + stock_status_code (nullable). Only a store's
--                          products carry it; null on a store post reads as
--                          in_stock, and a personal post has none.
--   posts                + RLS posts_store_manager_read / _update: the
--                          store's owner and accepted managers read and
--                          update every post of their store (an editor's
--                          too), never a legal hold; no insert in another's
--                          name. Editors keep author-only access.
--   file_moderation_item CHANGED: the store's owner and managers may file the
--                          re-review an edit of the store's post causes.
--   settings             store_counter_card_dpi, store_counter_sticker_mm.
--
-- No column is dropped or renamed; no backfill (null = in stock).
-- Tests: apps/api/test/rls-store-managers.db-spec.ts, store-seller.e2e-spec.ts.

SELECT set_config('app.is_platform_admin', 'true', true);
--> statement-breakpoint

CREATE TABLE public.stock_statuses (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_statuses_pk PRIMARY KEY (code),
  CONSTRAINT stock_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER stock_statuses_set_updated_at BEFORE UPDATE ON public.stock_statuses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
ALTER TABLE public.stock_statuses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.stock_statuses FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY stock_statuses_read_all ON public.stock_statuses FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY stock_statuses_platform_admin ON public.stock_statuses
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.stock_statuses TO ae_app;
--> statement-breakpoint
GRANT SELECT ON public.stock_statuses TO ae_rls_bypass;
--> statement-breakpoint
INSERT INTO public.stock_statuses (code, label_key, sort_order) VALUES
  ('in_stock',     'enum.stock_statuses.in_stock',     10),
  ('out_of_stock', 'enum.stock_statuses.out_of_stock', 20),
  ('on_order',     'enum.stock_statuses.on_order',     30);
--> statement-breakpoint

ALTER TABLE public.posts
  ADD COLUMN stock_status_code text,
  ADD CONSTRAINT posts_stock_status_code_fk FOREIGN KEY (stock_status_code)
    REFERENCES public.stock_statuses (code) ON DELETE RESTRICT;
--> statement-breakpoint

-- The store's owner and managers run its catalog: they read and update
-- every post of the store, whoever wrote it (can_manage_store, 0006). Not
-- INSERT (nobody posts in an editor's name) and not DELETE (deletion is a
-- soft delete, an UPDATE). The row must stay a post of a store they manage.
-- Legal holds stay platform-only, as for authors.
CREATE POLICY posts_store_manager_read ON public.posts
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND store_id IS NOT NULL
    AND public.can_manage_store(store_id)
    AND deletion_reason_code IS DISTINCT FROM 'legal_hold'
  );
--> statement-breakpoint
CREATE POLICY posts_store_manager_update ON public.posts
  FOR UPDATE
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND store_id IS NOT NULL
    AND public.can_manage_store(store_id)
    AND deletion_reason_code IS DISTINCT FROM 'legal_hold'
  )
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND store_id IS NOT NULL
    AND public.can_manage_store(store_id)
  );
--> statement-breakpoint

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('store_counter_card_dpi', '300', 'integer', 'dpi', 150, 600, 'none',
   'Print resolution of the shop-counter card PDF (QR code and text are drawn at it).'),
  ('store_counter_sticker_mm', '100', 'integer', 'millimetres', 40, 200, 'platform',
   'Side of the square shop-counter sticker PDF.');
--> statement-breakpoint

-- A price or text edit by the store's owner or a manager can send the post
-- back for review, like the author's own edit: they may file its queue item
-- too. The item still names the post's author (whose trust it concerns).
SET LOCAL ROLE ae_rls_bypass;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.file_moderation_item(
  p_post_id uuid,
  p_source text,
  p_reasons text[],
  p_author_trust_score smallint
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_author uuid;
  v_store uuid;
BEGIN
  SELECT p.author_member_id, p.store_id INTO v_author, v_store FROM public.posts p
  WHERE p.id = p_post_id AND p.tenant_id = v_tenant;
  IF v_author IS NULL THEN
    RAISE EXCEPTION 'file_moderation_item: no post % in this tenant', p_post_id USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT (
    v_author = public.current_member_id()
    OR (v_store IS NOT NULL AND public.can_manage_store(v_store))
    OR public.app_is_staff()
    OR public.app_is_system()
  ) THEN
    RAISE EXCEPTION 'file_moderation_item: not your post' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.moderation_queue_items (tenant_id, post_id, author_member_id, source_code, reasons, author_trust_score)
  VALUES (v_tenant, p_post_id, v_author, p_source, p_reasons, p_author_trust_score)
  ON CONFLICT (post_id) WHERE status_code = 'open' DO NOTHING;
END;
$$;
--> statement-breakpoint
RESET ROLE;
