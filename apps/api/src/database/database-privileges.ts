import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { DomainException } from '../common/exceptions/domain-exception';
import type { Database } from './database.client';
import { DB } from './database.tokens';

/**
 * Row-level security is only as strong as the login role. Three attributes
 * silently switch it off:
 *
 *  - SUPERUSER      — policies are never applied.
 *  - BYPASSRLS      — same, without the other superuser powers to hint at it.
 *  - table ownership — the owner skips policies unless the table also has
 *                     FORCE ROW LEVEL SECURITY, and can ALTER … DISABLE ROW
 *                     LEVEL SECURITY or DROP POLICY at will. An SQL-injection
 *                     bug in one endpoint would then be able to remove the
 *                     isolation for every tenant, permanently.
 *
 * So the API refuses to start unless it is connected as an unprivileged,
 * non-owning role (ae_app). A misconfigured DATABASE_URL must fail loudly at
 * boot, not quietly serve every tenant's data.
 */
const PrivilegeRowSchema = z.object({
  role: z.string(),
  is_superuser: z.boolean(),
  can_bypass_rls: z.boolean(),
  owned_tables: z.array(z.string()),
  unprotected_tables: z.array(z.string()),
});

export interface RolePrivileges {
  role: string;
  isSuperuser: boolean;
  canBypassRls: boolean;
  /** Tables in `public` owned by the connected role (or a role it can assume). */
  ownedTables: readonly string[];
  /** Tables in `public` with row-level security not enabled, or enabled but not forced. */
  unprotectedTables: readonly string[];
}

export class UnsafeDatabaseRoleException extends DomainException {
  readonly code = 'UNSAFE_DATABASE_ROLE';
  readonly httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;

  constructor(violations: readonly string[]) {
    super(`Refusing to start: the database role is not safe for RLS. ${violations.join(' ')}`);
  }
}

/**
 * `pg_has_role(…, 'member')` covers both inherited privileges and roles the
 * login can reach with SET ROLE, so granting ae_app membership in the owner
 * would be caught too.
 */
const PRIVILEGE_QUERY = sql`
  with assumable as (
    select oid, rolname, rolsuper, rolbypassrls
    from pg_roles
    where pg_has_role(current_user, oid, 'member')
  )
  select current_user::text as role,
         (select bool_or(rolsuper) from assumable) as is_superuser,
         (select bool_or(rolbypassrls) from assumable) as can_bypass_rls,
         coalesce((
           select array_agg(c.relname order by c.relname)
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public'
             and c.relkind in ('r', 'p')
             and c.relowner in (select oid from assumable)
             -- PostGIS ships spatial_ref_sys and owns it; that is not ours.
             and not exists (
               select 1 from pg_depend d
               where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'
             )
         ), '{}') as owned_tables,
         coalesce((
           select array_agg(c.relname order by c.relname)
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public'
             and c.relkind in ('r', 'p')
             and not (c.relrowsecurity and c.relforcerowsecurity)
             and not exists (
               select 1 from pg_depend d
               where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'
             )
         ), '{}') as unprotected_tables`;

export async function inspectRolePrivileges(db: Database): Promise<RolePrivileges> {
  const rows = await db.execute(PRIVILEGE_QUERY);
  const row = PrivilegeRowSchema.parse([...rows][0]);
  return {
    role: row.role,
    isSuperuser: row.is_superuser,
    canBypassRls: row.can_bypass_rls,
    ownedTables: row.owned_tables,
    unprotectedTables: row.unprotected_tables,
  };
}

/** Empty means the connection is safe. Pure, so it is unit-testable. */
export function describePrivilegeViolations(privileges: RolePrivileges): string[] {
  const violations: string[] = [];
  if (privileges.isSuperuser) {
    violations.push(`Role "${privileges.role}" is SUPERUSER, which ignores every RLS policy.`);
  }
  if (privileges.canBypassRls) {
    violations.push(`Role "${privileges.role}" has BYPASSRLS, which ignores every RLS policy.`);
  }
  if (privileges.ownedTables.length > 0) {
    violations.push(
      `Role "${privileges.role}" owns ${privileges.ownedTables.length} table(s) in public ` +
        // settings-exempt: how many names fit in one log line, governs nothing
        `(${privileges.ownedTables.slice(0, 5).join(', ')}…); the owner can drop policies. ` +
        'Connect as ae_app and let ae_migrator own the schema.',
    );
  }
  return violations;
}

@Injectable()
export class DatabasePrivilegeCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger(DatabasePrivilegeCheck.name);

  constructor(@Inject(DB) private readonly db: Database) {}

  async onApplicationBootstrap(): Promise<void> {
    const privileges = await inspectRolePrivileges(this.db);
    const violations = describePrivilegeViolations(privileges);
    if (violations.length > 0) {
      throw new UnsafeDatabaseRoleException(violations);
    }
    // Not fatal: a new domain's migration may legitimately not have landed yet
    // on a developer machine. scripts/audit-schema.sql fails the build for it.
    if (privileges.unprotectedTables.length > 0) {
      this.logger.warn(
        `Tables without FORCE ROW LEVEL SECURITY: ${privileges.unprotectedTables.join(', ')}`,
      );
    }
    this.logger.log(`Connected as "${privileges.role}" (no superuser, no bypassrls, owns nothing)`);
  }
}
