import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { TenantRequiredException } from '../database/tenant.exceptions';
import { REQUIRE_OWNERSHIP_KEY, type OwnershipSpec } from './ownership.metadata';
import { OwnershipRequiredException } from './rbac.exceptions';

@Injectable()
export class OwnershipGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantDb: TenantDb,
    private readonly tenantContext: TenantContext,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const spec = this.reflector.getAllAndOverride<OwnershipSpec>(REQUIRE_OWNERSHIP_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!spec) return true;

    const { tenantId, memberId } = this.tenantContext.require();
    if (!tenantId || !memberId) throw new TenantRequiredException();

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const rowId = (request.params as Record<string, string> | undefined)?.[spec.idParam];
    if (!rowId) throw new OwnershipRequiredException();

    // Runs as `system`: this is a structural fact-check ("does row X belong
    // to member Y"), not a read the caller should need their own SELECT
    // policy for — that policy's own visibility rules (published-only,
    // staff-only, etc.) are a different question from ownership.
    const owns = await this.tenantContext.run({ role: 'system' }, () =>
      this.tenantDb.transaction(
        async (tx) => {
          const rows = await tx.execute(sql`
          select 1
          from ${sql.identifier(spec.table)}
          where id = ${rowId}
            and tenant_id = ${tenantId}
            and ${sql.identifier(spec.ownerColumn)} = ${memberId}
          limit 1
        `);
          return rows.length > 0;
        },
        { accessMode: 'read only' },
      ),
    );

    if (!owns) throw new OwnershipRequiredException();
    return true;
  }
}
