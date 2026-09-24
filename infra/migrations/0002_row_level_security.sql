-- 0002_row_level_security
--
-- Turns on row-level security for everything created so far, assigns object
-- ownership to ae_migrator, and grants ae_app exactly what it needs.
-- Model and reasoning: docs/decisions/019-row-level-security.md.
--
-- The safe default, when app.tenant_id is NOT set:
--   current_setting('app.tenant_id', true) is NULL (never set) or '' (set in a
--   transaction that has ended). current_tenant_id() maps both, and any
--   malformed value, to NULL. The policy then compares tenant_id = NULL, which
--   is NULL, which RLS treats as false. So a query with no context reads zero
--   rows and cannot insert. "See nothing" is the default; "see everything"
--   requires either app.is_platform_admin = 'true' (written only by TenantDb)
--   or a SUPERUSER/BYPASSRLS login, which the API refuses to start as.
--
-- This migration must run as a superuser (it reassigns ownership of objects
-- created by 0000/0001). Later migrations run as ae_migrator.
--
-- DEFERRED to the auth step (everything below fails closed until then):
--   - users: self-service UPDATE, and tenant staff reading their own members
--   - tenant_members: "a user sees their own memberships in every tenant"
--     (tenant switcher), staff-only visibility rules
--   - blacklist_entries: tenant_admin may INSERT status 'recommended'
--   - audit_logs: tenant_admin SELECT for its own tenant
--   - graded platform roles (platform_support read-only, platform_finance)

-- ============================================================================
-- Preconditions: the roles must exist and must not be able to bypass RLS
-- ============================================================================

DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(name, ', ')
    INTO missing
  FROM (VALUES ('ae_migrator'), ('ae_app')) AS wanted(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = wanted.name);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Missing role(s): %. Run infra/db/bootstrap-roles.sql first (make db-roles).', missing;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('ae_migrator', 'ae_app') AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'ae_migrator and ae_app must be NOSUPERUSER and NOBYPASSRLS, otherwise RLS is pointless.';
  END IF;
END
$$;
--> statement-breakpoint

-- ============================================================================
-- Session helpers. All three fail closed: unset, empty or malformed -> NULL/false.
-- STABLE so a policy can wrap them in (SELECT …) and have them evaluated once
-- per query instead of once per row.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN raw <> '' AND pg_input_is_valid(raw, 'uuid') THEN raw::uuid END
  FROM (SELECT coalesce(current_setting('app.tenant_id', true), '') AS raw) s
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.current_tenant_id() IS
  'Tenant of the current request from app.tenant_id; NULL when unset, empty or malformed (so RLS sees nothing).';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN raw <> '' AND pg_input_is_valid(raw, 'uuid') THEN raw::uuid END
  FROM (SELECT coalesce(current_setting('app.user_id', true), '') AS raw) s
$$;
--> statement-breakpoint

-- Only the exact string 'true' counts. 'TRUE', '1', 'yes', '' and unset are all false.
CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT coalesce(current_setting('app.is_platform_admin', true), '') = 'true'
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.is_platform_admin() IS
  'True only when app.is_platform_admin is exactly ''true''. Set by TenantDb for platform_admin and system contexts.';
--> statement-breakpoint

-- ============================================================================
-- Ownership: ae_migrator owns every non-extension object in public, plus the
-- drizzle bookkeeping schema. ae_app owns nothing, so it can never ALTER a
-- table, DROP a policy, or TRUNCATE around RLS.
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
      AND c.relkind IN ('r', 'p')
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format('ALTER TABLE %s OWNER TO ae_migrator', obj.ident);
  END LOOP;

  FOR obj IN
    SELECT p.oid::regprocedure AS ident
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO ae_migrator', obj.ident);
  END LOOP;
END
$$;
--> statement-breakpoint
ALTER SCHEMA drizzle OWNER TO ae_migrator;
--> statement-breakpoint
ALTER TABLE drizzle.__drizzle_migrations OWNER TO ae_migrator;
--> statement-breakpoint

-- ============================================================================
-- Enable AND force RLS on every table, including audit_logs partitions.
-- FORCE means the owner (ae_migrator) is subject to policies too, so a data
-- migration that needs to cross tenants has to say so explicitly with
-- set_config('app.is_platform_admin', 'true', true).
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
      AND c.relkind IN ('r', 'p')
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.ident);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', obj.ident);
  END LOOP;
END
$$;
--> statement-breakpoint

-- ============================================================================
-- Policies: tenant-scoped tables (T-ISOLATE + platform admin bypass)
-- ============================================================================

CREATE POLICY tenant_members_tenant_isolation ON public.tenant_members
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()));
--> statement-breakpoint
CREATE POLICY tenant_members_platform_admin ON public.tenant_members
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

CREATE POLICY tenant_settings_tenant_isolation ON public.tenant_settings
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()));
--> statement-breakpoint
CREATE POLICY tenant_settings_platform_admin ON public.tenant_settings
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ============================================================================
-- Policies: global reference tables (enum tables) — read by all, write by admin
-- ============================================================================

DO $$
DECLARE
  enum_table text;
BEGIN
  FOREACH enum_table IN ARRAY ARRAY[
    'tenant_statuses', 'user_statuses', 'platform_roles', 'member_roles',
    'member_statuses', 'moderation_modes', 'ban_severities',
    'blacklist_reasons', 'blacklist_severities', 'blacklist_statuses'
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

-- ============================================================================
-- Policies: tenants — the routing table, public except archived rows
-- ============================================================================

CREATE POLICY tenants_public_read ON public.tenants
  FOR SELECT
  USING (status_code <> 'archived');
--> statement-breakpoint
CREATE POLICY tenants_platform_admin ON public.tenants
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ============================================================================
-- Policies: users — private. A user may read their own row; admin sees all.
-- Public profile data will live in user_profiles, so "readable by all" is
-- deliberately NOT applied here: this table holds phone numbers and emails.
-- ============================================================================

CREATE POLICY users_self_read ON public.users
  FOR SELECT
  USING (id = (SELECT public.current_user_id()));
--> statement-breakpoint
CREATE POLICY users_platform_admin ON public.users
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ============================================================================
-- Policies: blacklist_entries — fraud flags, platform only until auth lands
-- ============================================================================

CREATE POLICY blacklist_entries_platform_admin ON public.blacklist_entries
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ============================================================================
-- Policies: audit_logs — anyone may append (for their own tenant or none),
-- only platform may read. No UPDATE/DELETE policy exists, and the immutability
-- trigger from 0001 still guards the owner.
-- ============================================================================

CREATE POLICY audit_logs_append ON public.audit_logs
  FOR INSERT
  WITH CHECK (
    tenant_id IS NULL
    OR tenant_id = (SELECT public.current_tenant_id())
    OR (SELECT public.is_platform_admin())
  );
--> statement-breakpoint
CREATE POLICY audit_logs_platform_admin_read ON public.audit_logs
  FOR SELECT
  USING ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- Partitions are reached through the parent, where the policies above apply.
-- Direct access gets a deny-all policy (and no grant), so nothing can sneak
-- past the parent's policies by naming a partition.
DO $$
DECLARE
  part record;
BEGIN
  FOR part IN
    SELECT c.oid::regclass AS ident, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relispartition AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('CREATE POLICY %I ON %s FOR ALL USING (false) WITH CHECK (false)',
                   part.relname || '_no_direct_access', part.ident);
  END LOOP;
END
$$;
--> statement-breakpoint

-- New partitions get the same treatment. SECURITY DEFINER so the scheduled job
-- (which runs as ae_app) can create them without CREATE on the schema; the
-- partitions end up owned by ae_migrator.
CREATE OR REPLACE FUNCTION public.ensure_audit_log_partitions(from_month date, months integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  month_start date;
  partition_name text;
  created integer := 0;
BEGIN
  IF months < 1 THEN
    RAISE EXCEPTION 'months must be >= 1 (got %)', months;
  END IF;
  FOR offset_months IN 0 .. months - 1 LOOP
    month_start := (date_trunc('month', from_month) + make_interval(months => offset_months))::date;
    partition_name := format('audit_logs_y%sm%s', to_char(month_start, 'YYYY'), to_char(month_start, 'MM'));
    IF to_regclass(format('public.%I', partition_name)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF public.audit_logs FOR VALUES FROM (%L) TO (%L)',
        partition_name,
        (month_start::timestamp AT TIME ZONE 'Asia/Dhaka'),
        ((month_start + interval '1 month')::timestamp AT TIME ZONE 'Asia/Dhaka')
      );
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', partition_name);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', partition_name);
      EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL USING (false) WITH CHECK (false)',
                     partition_name || '_no_direct_access', partition_name);
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.ensure_audit_log_partitions(date, integer) OWNER TO ae_migrator;
--> statement-breakpoint

-- ============================================================================
-- Grants. ae_app gets no DDL, no DELETE on history-bearing tables, no
-- TRUNCATE anywhere, and no access to partitions or the drizzle schema.
-- Privileges are listed table by table on purpose: no ALTER DEFAULT
-- PRIVILEGES, so a future table is unreachable until its migration says so.
-- ============================================================================

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO ae_app;
--> statement-breakpoint
-- ae_migrator needs USAGE because referential-integrity checks run as the
-- OWNER of the referenced table: without it, every INSERT that checks a
-- foreign key fails with "permission denied for schema public". CREATE is for
-- later migrations, which run as ae_migrator rather than as a superuser.
-- (RI checks themselves bypass RLS by design, so policies do not break FKs.)
GRANT USAGE, CREATE ON SCHEMA public TO ae_migrator;
--> statement-breakpoint
-- ae_rls_bypass (infra/db/bootstrap-roles.sql) owns the handful of
-- SECURITY DEFINER helper functions that must bypass RLS (0009's
-- is_conversation_participant()/is_blocked_between()). ALTER FUNCTION ...
-- OWNER TO ae_rls_bypass requires CREATE on the function's schema for the
-- new owner — granted here, not in bootstrap-roles.sql, because this
-- migration (unlike the roles themselves) reruns every time the schema is
-- reset, which a manual one-time bootstrap script does not.
GRANT USAGE, CREATE ON SCHEMA public TO ae_rls_bypass;
--> statement-breakpoint

GRANT SELECT ON
  public.tenant_statuses, public.user_statuses, public.platform_roles,
  public.member_roles, public.member_statuses, public.moderation_modes,
  public.ban_severities, public.blacklist_reasons, public.blacklist_severities,
  public.blacklist_statuses
TO ae_app;
--> statement-breakpoint
-- Writes are still policy-gated to platform admins.
GRANT INSERT, UPDATE ON
  public.tenant_statuses, public.user_statuses, public.platform_roles,
  public.member_roles, public.member_statuses, public.moderation_modes,
  public.ban_severities, public.blacklist_reasons, public.blacklist_severities,
  public.blacklist_statuses
TO ae_app;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.tenants TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.users TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.tenant_settings TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.tenant_members TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.blacklist_entries TO ae_app;
--> statement-breakpoint
-- Append-only by grant as well as by trigger and policy.
GRANT SELECT, INSERT ON public.audit_logs TO ae_app;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.current_user_id() TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.uuid_generate_v7() TO ae_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.ensure_audit_log_partitions(date, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.ensure_audit_log_partitions(date, integer) TO ae_app;
--> statement-breakpoint
-- Migration bookkeeping is none of the app's business.
REVOKE ALL ON SCHEMA drizzle FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA drizzle FROM PUBLIC;
