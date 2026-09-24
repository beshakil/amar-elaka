-- Creates the two login roles the application and migrations use.
--
-- Roles are cluster-wide objects and carry passwords, so they are NOT created
-- by a migration (docs/decisions/019-row-level-security.md). Run this once per
-- Postgres server as a superuser, then again whenever a password changes.
--
--   psql -v ON_ERROR_STOP=1 \
--        -v app_password='…' -v migrator_password='…' \
--        -f infra/db/bootstrap-roles.sql
--
-- Local development: `make db-roles` and `make db-roles-test` read the
-- passwords from .env (DB_APP_PASSWORD / DB_MIGRATOR_PASSWORD).
--
-- ae_migrator owns every object and runs migrations.
-- ae_app is what the API and workers connect as.
-- Neither is SUPERUSER and neither has BYPASSRLS, so row-level security (and
-- FORCE ROW LEVEL SECURITY) applies to both.
--
-- ae_rls_bypass is a third, NOLOGIN role: nothing ever connects as it, it
-- exists only to OWN the small number of SECURITY DEFINER helper functions
-- that must see rows their caller's own RLS would hide (e.g. 0009's
-- is_blocked_between(), which has to detect a block in the direction the
-- current user can't normally see — "the blocked user has no access", per
-- spec). ae_migrator/ae_app's own FORCE ROW LEVEL SECURITY tables are
-- untouched by this; it only ever applies inside the handful of functions
-- explicitly ALTER FUNCTION ... OWNER TO ae_rls_bypass in a migration.
-- ae_migrator is granted membership so it can perform that ownership
-- transfer (it creates the function, but doesn't own ae_rls_bypass itself).

SELECT format(
  'CREATE ROLE ae_migrator LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT',
  :'migrator_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ae_migrator')
\gexec

SELECT format(
  'CREATE ROLE ae_app LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT',
  :'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ae_app')
\gexec

SELECT 'CREATE ROLE ae_rls_bypass NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ae_rls_bypass')
\gexec

-- Idempotent: re-running rotates the passwords and re-asserts the attributes.
SELECT format('ALTER ROLE ae_migrator PASSWORD %L NOSUPERUSER NOBYPASSRLS', :'migrator_password')
\gexec

SELECT format('ALTER ROLE ae_app PASSWORD %L NOSUPERUSER NOBYPASSRLS', :'app_password')
\gexec

ALTER ROLE ae_rls_bypass NOSUPERUSER BYPASSRLS;

GRANT ae_rls_bypass TO ae_migrator;

-- Let both roles reach this database (run once per database, e.g. dev and test).
SELECT format('GRANT CONNECT ON DATABASE %I TO ae_migrator, ae_app', current_database())
\gexec

-- ae_rls_bypass's schema-level grant (needed for ALTER FUNCTION ... OWNER TO
-- ae_rls_bypass) lives in migration 0002, not here: unlike role creation,
-- it must be re-applied every time the schema is reset, which this
-- one-time bootstrap script is not.

-- drizzle-orm's migrator unconditionally runs `CREATE SCHEMA IF NOT EXISTS
-- drizzle` as its first step on every run, and Postgres checks CREATE-on-
-- database before the IF NOT EXISTS short-circuit, even once the schema
-- exists and is owned by ae_migrator. ae_app never needs this: it never runs
-- migrations.
SELECT format('GRANT CREATE ON DATABASE %I TO ae_migrator', current_database())
\gexec

\echo 'Roles ae_migrator and ae_app are ready. Migration 0002 assigns ownership and grants.'
