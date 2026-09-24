# ADR 019: Row-level security: roles, session context, and the fail-closed default

**Status:** Accepted
**Date:** 2026-09-18
**Schema:** [§0.6 RLS model](../specs/schema.md)
**Migration:** `infra/migrations/0002_row_level_security.sql`, `infra/db/bootstrap-roles.sql`
**Tests:** `apps/api/test/rls.db-spec.ts`, `apps/api/test/tenant-db.db-spec.ts`,
`apps/api/src/database/database-privileges.spec.ts`

## Context

Every tenant shares one database and one schema (hard rule 1). Isolation therefore
rests on two things: a per-request session variable, and policies that read it. Both
must fail in the safe direction, because the failure mode is "one upazila's partner
reads another's customers", which is unrecoverable reputationally.

## Decisions

### 1. The default with no context is "see nothing"

`current_tenant_id()` is:

```sql
SELECT CASE WHEN raw <> '' AND pg_input_is_valid(raw, 'uuid') THEN raw::uuid END
FROM (SELECT coalesce(current_setting('app.tenant_id', true), '') AS raw) s
```

Four cases collapse to the same answer:

| `app.tenant_id`                               | `current_tenant_id()` | Effect of `tenant_id = current_tenant_id()` |
| --------------------------------------------- | --------------------- | ------------------------------------------- |
| never set (`current_setting(…, true)` → NULL) | NULL                  | NULL → RLS treats as false → 0 rows         |
| `''` (a finished transaction's reset value)   | NULL                  | 0 rows                                      |
| `'not-a-uuid'`, `"' or true --"`              | NULL                  | 0 rows, **no error**                        |
| a valid uuid                                  | that uuid             | only that tenant's rows                     |

Two details matter. `current_setting('app.tenant_id', true)` with `missing_ok = true`
returns NULL instead of raising, so an unauthenticated request does not turn into a 500. And `pg_input_is_valid` (PG16+) replaces a bare `::uuid` cast: the cast would
raise `22P02` on garbage, which is a louder failure but also a way to distinguish
"garbage" from "no access" from outside. Returning NULL means a caller learns nothing
either way.

The same reasoning gives the insert side its safety: `WITH CHECK (tenant_id =
current_tenant_id())` is NULL → false with no context, so a context-less request
cannot write, not even a row it would then be unable to read.

`is_platform_admin()` compares against the literal string `'true'`. `'TRUE'`,
`'True'`, `'1'`, `'t'`, `'yes'`, `'true '` and `''` are all false — tested case by
case, because a sloppy `::boolean` cast would accept most of them and a truthiness
check in some future helper would accept all of them.

### 2. Two managed roles, and the app is neither owner nor superuser

`infra/db/bootstrap-roles.sql` creates `ae_migrator` and `ae_app`, both
`NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`. Roles are cluster-wide
objects that carry passwords, so they are created by a script run once per server,
not by a migration.

`ae_migrator` owns every table and function in `public` and holds `USAGE, CREATE` on
the schema. `ae_app` owns nothing, has no DDL rights, and receives privileges table
by table — deliberately no `ALTER DEFAULT PRIVILEGES`, so a table added by a future
migration is unreachable until that migration grants access on purpose.

**Why the app must never connect as the table owner.** The owner is exempt from its
own policies unless `FORCE ROW LEVEL SECURITY` is set, and, forced or not, the owner
can `ALTER TABLE … DISABLE ROW LEVEL SECURITY`, `DROP POLICY` or `TRUNCATE` at any
time. A single SQL-injection bug in one endpoint would then be able to delete tenant
isolation permanently for every tenant, instead of leaking one query's rows. With
split roles, isolation is a property of the connection rather than of the
application's good behaviour.

`FORCE ROW LEVEL SECURITY` is set on every table anyway, so `ae_migrator` is subject
to policies too. A data migration that must cross tenants has to say so out loud with
`set_config('app.is_platform_admin', 'true', true)`, which is greppable in review.

The API checks this at boot (`DatabasePrivilegeCheck`) and refuses to start if the
connected role is a superuser, has `BYPASSRLS`, or owns any table in `public` — using
`pg_has_role(…, 'member')`, so being _able to_ `SET ROLE` to the owner counts as
owning. A misconfigured `DATABASE_URL` must crash, not quietly serve everything.

### 3. Policies are additive, and the admin bypass is a policy, not an attribute

Each tenant-scoped table gets two permissive policies: tenant isolation, and a
separate `is_platform_admin()` bypass. Postgres ORs permissive policies, so the
bypass composes without being woven into every predicate, and it is visible in
`pg_policies`, testable, and still subject to audit triggers — unlike `BYPASSRLS`,
which would be invisible and total.

Global tables differ per table rather than by a blanket "readable by all":

- **Enum tables** (10 of them): `SELECT USING (true)`, writes admin-only. They are
  reference data; hiding them would only break dropdowns.
- **`tenants`**: readable when `status_code <> 'archived'`. It is the routing table —
  a visitor must be able to resolve `savar.amarelaka.com` before having any context.
  Archived tenants are admin-only.
- **`users`**: `id = current_user_id()` only. This table holds phone numbers and
  emails; public profile fields will live in `user_profiles`. "Global" means one
  account across tenants, never "world-readable".
- **`blacklist_entries`**: platform admin only for now. A tenant recommending an
  entry (§9, Q15b) needs the auth step's role predicates, so it is deferred rather
  than approximated.
- **`audit_logs`**: `INSERT` allowed when `tenant_id IS NULL`, equals the request
  tenant, or the caller is admin; `SELECT` admin-only; no `UPDATE`/`DELETE` policy at
  all, and `ae_app` has no such grant, on top of 0001's immutability trigger. Its
  partitions each carry a deny-all policy and no grant, so nothing reaches rows by
  naming a partition instead of the parent; `ensure_audit_log_partitions()` applies
  the same treatment to every partition it creates.

### 4. What is deliberately deferred

0002 encodes tenant isolation and the platform-admin bypass only. The graded platform
roles (`platform_support` read-only, `platform_finance` on payment tables), a user
reading their own memberships across tenants for the tenant switcher, staff-only
visibility inside a tenant, and tenant-recommended blacklist entries all need
`app.role` and membership predicates that the auth step introduces. Everything
deferred fails closed in the meantime: the rows are simply invisible.

## Consequences

- Three connection strings in development (superuser, `ae_migrator`, `ae_app`) and a
  `make db-roles` step before the first migration. Documented in `.env.example`.
- Migrations 0000–0002 need the superuser: 0000 creates extensions, 0002 reassigns
  ownership. Migrations 0003+ run as `ae_migrator`, and `rls.db-spec.ts` asserts that
  every table in `public` is owned by `ae_migrator` with RLS enabled and forced, which
  catches a later migration accidentally applied as the superuser.
- Referential-integrity checks run as the _owner of the referenced table_, which is why
  `ae_migrator` needs `USAGE` on `public`: without it every foreign-key check fails with
  "permission denied for schema public". The RI checks themselves bypass RLS by design,
  so policies never break a foreign key.
- Any new table must, in its own migration, enable and force RLS, add policies, and
  grant `ae_app` what it needs. `scripts/audit-schema.sql` (`missing_rls`) fails CI
  otherwise, and the exemption list in `schema-audit.db-spec.ts` is now empty.
