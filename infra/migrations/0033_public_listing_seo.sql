-- 0033_public_listing_seo
--
-- The public web listing pages (ADR 039):
--
--   post_public_status(post)   what a crawler-facing URL for a post should
--                              answer, before any page renders: live or sold
--                              (with the title, for the canonical slug, and
--                              the owning tenant's slug, for the canonical
--                              host), gone (expired, removed, deleted,
--                              scrubbed: 410) or not found (never existed,
--                              draft, in review, rejected, hidden: 404). It
--                              must see rows the public can't, so it is
--                              SECURITY DEFINER and returns only that — never
--                              a non-public post's title.
--
-- Plus the settings: when a sold listing stops being indexed, the web's page
-- cache windows, and how many URLs one sitemap file holds.

CREATE OR REPLACE FUNCTION public.post_public_status(p_post_id uuid)
RETURNS TABLE (
  state         text,
  tenant_id     uuid,
  tenant_slug   text,
  title         text,
  sold_at       timestamptz,
  updated_at    timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH p AS (
    SELECT p.*,
      CASE
        WHEN p.scrubbed_at IS NOT NULL OR p.deleted_at IS NOT NULL
             OR p.status_code IN ('expired', 'removed') THEN 'gone'
        WHEN p.hidden_by_owner OR p.status_code NOT IN ('live', 'sold') THEN 'not_found'
        ELSE p.status_code
      END AS state
    FROM public.posts p
    WHERE p.id = p_post_id AND p.deletion_reason_code IS DISTINCT FROM 'legal_hold'
  )
  SELECT p.state, p.tenant_id, t.slug,
         CASE WHEN p.state IN ('live', 'sold') THEN p.title END,
         CASE WHEN p.state = 'sold' THEN p.sold_at END,
         p.updated_at
  FROM p JOIN public.tenants t ON t.id = p.tenant_id
$$;
--> statement-breakpoint
ALTER FUNCTION public.post_public_status(uuid) OWNER TO ae_rls_bypass;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.post_public_status(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.post_public_status(uuid) TO ae_app;
--> statement-breakpoint

-- Keyset listing of a tenant's sitemap posts (live, and sold ones still
-- indexable) is a plain SELECT under the public-read policy; this index keeps
-- it an index scan on large tenants.
CREATE INDEX posts_tenant_public_id_idx ON public.posts (tenant_id, id)
  WHERE status_code IN ('live', 'sold') AND deleted_at IS NULL AND NOT hidden_by_owner;
--> statement-breakpoint

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('sold_noindex_days', '90', 'integer', 'days', 0, 3650, 'platform',
   'A sold listing''s page stays up (it carries search value) but is marked noindex this many days after the sale, and leaves the sitemap.'),
  ('web_home_revalidate_seconds', '300', 'integer', 'seconds', 30, 86400, 'platform',
   'How long the web caches what the home page reads from the API before refreshing it.'),
  ('web_category_revalidate_seconds', '300', 'integer', 'seconds', 30, 86400, 'platform',
   'How long the web caches a category listing page''s data.'),
  ('web_listing_revalidate_seconds', '600', 'integer', 'seconds', 30, 86400, 'platform',
   'How long the web caches a listing or store page''s data.'),
  ('sitemap_urls_per_file', '10000', 'integer', 'count', 100, 50000, 'platform',
   'URLs per sitemap file; above it the sitemap index points at several files (the protocol''s cap is 50,000).');
