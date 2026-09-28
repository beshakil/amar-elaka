-- 0036_area_landing_pages
--
-- Category + area landing pages on the web (ADR 042): /category/<slug>/<area>
-- for every area of a tenant with enough listings in the category.
--
--   localities.slug        the area's URL segment: from its English name
--                          ("Mirpur 10" → mirpur-10), unique per tenant, set
--                          once and kept on rename, so a ranking URL never
--                          moves. An area without an English name gets
--                          area-<8 hex of its id>.
--   locality_slug_base()   the rule, shared by the backfill and the trigger.
--   seo_area_page_min_listings
--                          how many listings an area needs in a category
--                          before its landing page exists (and is in the
--                          sitemap): fewer would be a thin page.
--
-- No new table (so no new RLS). Seeds: the setting; slugs are derived.

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('seo_area_page_min_listings', '5', 'integer', 'count', 1, 1000, 'tenant_admin',
   'Listings an area needs in a category before its category + area landing page exists (thin pages are not published).');
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.locality_slug_base(p_name_en text, p_id uuid)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT coalesce(
    nullif(trim(BOTH '-' FROM regexp_replace(lower(coalesce(p_name_en, '')), '[^a-z0-9]+', '-', 'g')), ''),
    'area-' || left(replace(p_id::text, '-', ''), 8)
  )
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.locality_slug_base(text, uuid) TO ae_app;
--> statement-breakpoint

ALTER TABLE public.localities ADD COLUMN slug text;
--> statement-breakpoint
-- Backfill: the base, and -2, -3… for a name repeated in one tenant (oldest keeps the plain one).
UPDATE public.localities l SET slug = numbered.slug
FROM (
  SELECT id,
         CASE WHEN row_number() OVER w = 1 THEN base ELSE base || '-' || row_number() OVER w END AS slug
  FROM (SELECT id, tenant_id, public.locality_slug_base(name_en, id) AS base FROM public.localities) b
  WINDOW w AS (PARTITION BY tenant_id, base ORDER BY id)
) numbered
WHERE numbered.id = l.id;
--> statement-breakpoint
ALTER TABLE public.localities ALTER COLUMN slug SET NOT NULL;
--> statement-breakpoint
ALTER TABLE public.localities ADD CONSTRAINT localities_slug_ck CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
--> statement-breakpoint
CREATE UNIQUE INDEX localities_tenant_slug_uq ON public.localities (tenant_id, slug);
--> statement-breakpoint

-- New areas get a slug on insert; an existing slug is never rewritten.
-- SECURITY DEFINER only to see the tenant's other slugs whatever the
-- inserter's policies (it reads slugs of one tenant, writes nothing else).
CREATE OR REPLACE FUNCTION public.localities_assign_slug()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  base text;
  candidate text;
  n integer := 1;
BEGIN
  IF NEW.slug IS NOT NULL THEN
    RETURN NEW;
  END IF;
  base := public.locality_slug_base(NEW.name_en, NEW.id);
  candidate := base;
  WHILE EXISTS (
    SELECT 1 FROM public.localities x WHERE x.tenant_id = NEW.tenant_id AND x.slug = candidate
  ) LOOP
    n := n + 1;
    candidate := base || '-' || n;
  END LOOP;
  NEW.slug := candidate;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.localities_assign_slug() OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.localities TO ae_rls_bypass;
--> statement-breakpoint
CREATE TRIGGER localities_assign_slug
  BEFORE INSERT ON public.localities
  FOR EACH ROW EXECUTE FUNCTION public.localities_assign_slug();
