import { Injectable } from '@nestjs/common';
import { auditLogs } from '../database/schema/audit';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';

export interface AuditLogEntry {
  module: string;
  action: string;
  entityId: string | undefined;
  /** Recorded as { field: [null, newValue] } — this module only ever sees the "after" state, never a true before/after diff. */
  changes: Record<string, unknown> | undefined;
  ipAddress: string | undefined;
  userAgent: string | undefined;
  requestId: string | undefined;
}

/** Thin insert wrapper over the existing audit_logs table (infra/migrations/0001_tenancy_identity.sql) — already partitioned, already RLS'd for "insert your own tenant's rows". */
@Injectable()
export class AuditLogService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly tenantContext: TenantContext,
  ) {}

  async record(entry: AuditLogEntry): Promise<void> {
    const { tenantId, userId, role } = this.tenantContext.require();

    await this.tenantDb.transaction((tx) =>
      tx.insert(auditLogs).values({
        tenantId: tenantId ?? null,
        actorUserId: userId ?? null,
        actorRole: role ?? 'anon',
        action: `${entry.module}.${entry.action}`,
        entityTable: entry.module,
        entityId: entry.entityId ?? null,
        changes: entry.changes ? wrapAsChanges(entry.changes) : null,
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent ?? null,
        requestId: entry.requestId ?? null,
      }),
    );
  }
}

function wrapAsChanges(body: Record<string, unknown>): Record<string, [unknown, unknown]> {
  return Object.fromEntries(Object.entries(body).map(([field, value]) => [field, [null, value]]));
}
