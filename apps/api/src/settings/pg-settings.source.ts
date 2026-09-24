import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { withRetry, withTimeout } from '../common/utils/with-timeout';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import type { SettingsSource } from './settings.ports';

const PlatformRowSchema = z.object({ key: z.string(), value: z.unknown() });
const OverridesRowSchema = z.object({ setting_overrides: z.record(z.unknown()) });

/**
 * Reads settings from Postgres through TenantDb, as the `system` role, in a
 * read-only transaction. Using the shared wrapper (instead of a private pool)
 * keeps one connection pool and one place where session context is written.
 */
@Injectable()
export class PgSettingsSource implements SettingsSource {
  private readonly timeoutMs: number;

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    @Inject(APP_CONFIG) env: Pick<Env, 'SETTINGS_SOURCE_TIMEOUT_MS'>,
  ) {
    this.timeoutMs = env.SETTINGS_SOURCE_TIMEOUT_MS;
  }

  loadPlatformSettings(): Promise<ReadonlyMap<string, unknown>> {
    return this.readAsSystem(async (tx) => {
      const rows = await tx.execute(sql`select key, value from platform_settings`);
      const parsed = z.array(PlatformRowSchema).parse([...rows]);
      return new Map(parsed.map((row) => [row.key, row.value]));
    });
  }

  loadTenantOverrides(tenantId: string): Promise<ReadonlyMap<string, unknown>> {
    return this.readAsSystem(async (tx) => {
      const rows = await tx.execute(
        sql`select setting_overrides from tenant_settings where tenant_id = ${tenantId}`,
      );
      const [row] = z.array(OverridesRowSchema).parse([...rows]);
      return new Map(Object.entries(row?.setting_overrides ?? {}));
    });
  }

  private readAsSystem<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return withRetry(() =>
      withTimeout(
        this.context.run({ role: 'system' }, () =>
          this.tenantDb.transaction(work, { accessMode: 'read only' }),
        ),
        this.timeoutMs,
      ),
    );
  }
}
