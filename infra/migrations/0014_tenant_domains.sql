-- 0014_tenant_domains
--
-- Tenant resolution (Week 2): custom-domain lookup is the third precedence
-- tier after X-Tenant-Id and subdomain (apps/api/src/database/tenant-
-- resolution.middleware.ts). No RLS/grant changes: tenants_public_read
-- (0002) already covers a plain SELECT on this new column for every role,
-- same as slug.
--
-- Also seeds tenant_nearby_max_radius_km (CLAUDE.md rule 9 — the "within
-- 50km" fallback radius for GET /tenants/nearby is a business threshold,
-- not a literal in application code).

ALTER TABLE public.tenants ADD COLUMN custom_domain text;
--> statement-breakpoint
ALTER TABLE public.tenants ADD CONSTRAINT tenants_custom_domain_ck
  CHECK (custom_domain IS NULL OR custom_domain = lower(custom_domain));
--> statement-breakpoint
-- One live tenant per domain. Unlike slug/email/phone, archived tenants
-- don't need the domain released for reuse (custom domains are managed by
-- platform staff, not self-serve), so this isn't a soft-delete-aware index.
CREATE UNIQUE INDEX tenants_custom_domain_uq ON public.tenants (custom_domain)
  WHERE custom_domain IS NOT NULL;
--> statement-breakpoint

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('tenant_nearby_max_radius_km', '50', 'decimal', 'km', 1, 200, 'none',
   'GET /tenants/nearby falls back to the nearest tenant within this radius when the point is outside every tenant boundary.');
