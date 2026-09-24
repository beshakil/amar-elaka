-- 0015_rbac
--
-- Fine-grained module -> action permissions (role & permission system).
-- Deliberately additive: does not touch tenant_members.role_code or any
-- existing RLS policy. role_code stays the RLS baseline (app.role GUC,
-- app_is_staff()/app_is_tenant_admin() in 0003); this migration adds a
-- second, precise layer that NestJS's PermissionGuard reads, with its own
-- tables so a tenant can define genuinely custom roles (impossible with
-- member_roles, a global enum every tenant shares).
--
-- platform_admin needs no row here at all: PermissionsService special-cases
-- it (TenantContext.role === 'platform_admin', set by
-- apps/api/src/rbac/platform-admin.guard.ts) before ever querying these
-- tables, the same way RLS's is_platform_admin() bypasses policies below.

-- ============================================================================
-- member_roles: 3 new codes so every built-in role in the spec is nameable
-- via role_code when no custom role is assigned ('user' = the existing
-- 'member' code).
-- ============================================================================

INSERT INTO public.member_roles (code, label_key, sort_order) VALUES
  ('marketer',  'enum.member_roles.marketer',  60),
  ('executive', 'enum.member_roles.executive', 70),
  ('seller',    'enum.member_roles.seller',    80);
--> statement-breakpoint

-- ============================================================================
-- roles: built-in templates (tenant_id NULL) + one tenant's custom roles.
-- ============================================================================

CREATE TABLE public.roles (
  id           uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id    uuid,
  code         text        NOT NULL,
  name         text        NOT NULL,
  is_builtin   boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roles_pk PRIMARY KEY (id),
  CONSTRAINT roles_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE CASCADE,
  CONSTRAINT roles_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT roles_name_ck CHECK (btrim(name) <> ''),
  -- Only a built-in template has no tenant, and only a non-builtin row has one.
  CONSTRAINT roles_builtin_tenant_ck CHECK (is_builtin = (tenant_id IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX roles_builtin_code_uq ON public.roles (code) WHERE tenant_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX roles_tenant_code_uq ON public.roles (tenant_id, code) WHERE tenant_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER roles_set_updated_at BEFORE UPDATE ON public.roles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- role_permissions: the matrix. module/action = '*' means "all".
-- ============================================================================

CREATE TABLE public.role_permissions (
  id          uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  role_id     uuid        NOT NULL,
  module      text        NOT NULL,
  action      text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_permissions_pk PRIMARY KEY (id),
  CONSTRAINT role_permissions_role_id_fk FOREIGN KEY (role_id)
    REFERENCES public.roles (id) ON DELETE CASCADE,
  CONSTRAINT role_permissions_module_ck CHECK (module ~ '^[a-z][a-z0-9_]*$' OR module = '*'),
  CONSTRAINT role_permissions_action_ck CHECK (action IN ('read', 'write', 'approve', 'delete', '*')),
  CONSTRAINT role_permissions_role_id_module_action_uq UNIQUE (role_id, module, action)
);
--> statement-breakpoint
CREATE INDEX role_permissions_role_id_idx ON public.role_permissions (role_id);
--> statement-breakpoint

-- ============================================================================
-- tenant_members.custom_role_id: optional override. NULL = permissions come
-- from the built-in roles row matching role_code; set = from that role's
-- own matrix instead. role_code itself is untouched (still the RLS baseline).
-- ============================================================================

ALTER TABLE public.tenant_members ADD COLUMN custom_role_id uuid
  REFERENCES public.roles (id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX tenant_members_custom_role_id_idx ON public.tenant_members (custom_role_id)
  WHERE custom_role_id IS NOT NULL;
--> statement-breakpoint

-- A custom role assigned to a member must belong to that member's own
-- tenant — otherwise tenant A's role definitions could leak permissions
-- into tenant B by id guessing.
CREATE OR REPLACE FUNCTION public.check_custom_role_tenant_match()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  role_tenant_id uuid;
BEGIN
  IF NEW.custom_role_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT tenant_id INTO role_tenant_id FROM public.roles WHERE id = NEW.custom_role_id;
  IF role_tenant_id IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'tenant_members.custom_role_id must reference a role belonging to the same tenant'
      USING ERRCODE = 'AE010';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tenant_members_check_custom_role_tenant BEFORE INSERT OR UPDATE OF custom_role_id, tenant_id
  ON public.tenant_members
  FOR EACH ROW EXECUTE FUNCTION public.check_custom_role_tenant_match();
--> statement-breakpoint

-- ============================================================================
-- RLS
-- ============================================================================

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.roles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.role_permissions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Built-ins are visible to everyone (needed to resolve any member's
-- effective permissions); a tenant's own custom roles are visible only
-- within that tenant.
CREATE POLICY roles_read ON public.roles
  FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = (SELECT public.current_tenant_id()));
--> statement-breakpoint
CREATE POLICY roles_tenant_admin_write ON public.roles
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
CREATE POLICY roles_platform_admin ON public.roles
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

CREATE POLICY role_permissions_read ON public.role_permissions
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.roles r
      WHERE r.id = role_permissions.role_id
        AND (r.tenant_id IS NULL OR r.tenant_id = (SELECT public.current_tenant_id()))
    )
  );
--> statement-breakpoint
CREATE POLICY role_permissions_tenant_admin_write ON public.role_permissions
  FOR ALL
  USING (
    (SELECT public.app_is_tenant_admin())
    AND EXISTS (
      SELECT 1 FROM public.roles r
      WHERE r.id = role_permissions.role_id AND r.tenant_id = (SELECT public.current_tenant_id())
    )
  )
  WITH CHECK (
    (SELECT public.app_is_tenant_admin())
    AND EXISTS (
      SELECT 1 FROM public.roles r
      WHERE r.id = role_permissions.role_id AND r.tenant_id = (SELECT public.current_tenant_id())
    )
  );
--> statement-breakpoint
CREATE POLICY role_permissions_platform_admin ON public.role_permissions
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.roles TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.role_permissions TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- Seed: the 7 built-in roles + their matrix (docs: role and permission spec).
-- ============================================================================

INSERT INTO public.roles (code, name, is_builtin, tenant_id) VALUES
  ('platform_admin', 'Platform Admin', true, NULL),
  ('tenant_admin',   'Tenant Admin',   true, NULL),
  ('moderator',      'Moderator',      true, NULL),
  ('marketer',       'Marketer',       true, NULL),
  ('executive',      'Executive',      true, NULL),
  ('seller',         'Seller',         true, NULL),
  -- Code is 'member', not 'user': it must match tenant_members.role_code's
  -- existing enum value for a regular member so the built-in-role lookup
  -- (role_code -> roles.code, when custom_role_id is unset) finds it.
  ('member',         'User',           true, NULL);
--> statement-breakpoint

INSERT INTO public.role_permissions (role_id, module, action)
SELECT r.id, grant_row.module, grant_row.action
FROM public.roles r
JOIN (VALUES
  -- platform_admin: everything, everywhere.
  ('platform_admin', '*', '*'),
  -- tenant_admin: everything within its own tenant (RLS/tenant scoping already confines this).
  ('tenant_admin', '*', '*'),
  -- moderator: posts, reports, complaints — read/write/approve, never delete.
  ('moderator', 'posts', 'read'), ('moderator', 'posts', 'write'), ('moderator', 'posts', 'approve'),
  ('moderator', 'reports', 'read'), ('moderator', 'reports', 'write'), ('moderator', 'reports', 'approve'),
  ('moderator', 'complaints', 'read'), ('moderator', 'complaints', 'write'), ('moderator', 'complaints', 'approve'),
  -- marketer: campaigns/ads/featured read+write, analytics read-only.
  ('marketer', 'campaigns', 'read'), ('marketer', 'campaigns', 'write'),
  ('marketer', 'ads', 'read'), ('marketer', 'ads', 'write'),
  ('marketer', 'featured', 'read'), ('marketer', 'featured', 'write'),
  ('marketer', 'analytics', 'read'),
  -- executive: users, support — read/write.
  ('executive', 'users', 'read'), ('executive', 'users', 'write'),
  ('executive', 'support', 'read'), ('executive', 'support', 'write'),
  -- seller: own store and posts only — the grant is the ability; @RequireOwnership() scopes it to their own rows.
  ('seller', 'stores', 'read'), ('seller', 'stores', 'write'),
  ('seller', 'posts', 'read'), ('seller', 'posts', 'write'), ('seller', 'posts', 'delete'),
  -- user (role_code 'member'): own content only — same ownership scoping.
  ('member', 'posts', 'read'), ('member', 'posts', 'write'), ('member', 'posts', 'delete')
) AS grant_row (role_code, module, action) ON grant_row.role_code = r.code
WHERE r.tenant_id IS NULL;
