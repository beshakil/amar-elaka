import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { sqlStateOf } from '../common/utils/sql-state';
import type { Database, DatabaseTransaction } from './database.client';
import { DB } from './database.tokens';
import { TenantContext, type TenantContextStore } from './tenant-context';

/** Serialization failure and deadlock: safe to retry the whole transaction. */
const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']);

/**
 * Roles whose transactions may cross tenant boundaries. Everything else is
 * confined to `app.tenant_id` by the RLS policies in migration 0002.
 *
 * `system` is here because platform-wide background work (settings loader,
 * settlement runs, retention jobs) has no single tenant. It is never reachable
 * from an HTTP request: TenantContextMiddleware never assigns it.
 */
const RLS_BYPASS_ROLES = new Set(['platform_admin', 'system']);

/**
 * Writes the request context into the transaction's session settings.
 *
 * `set_config(name, value, true)` is exactly `SET LOCAL name = value`, but it
 * accepts bind parameters, so no value is ever interpolated into SQL text.
 * Empty string means "unset"; the RLS helpers read it as NULL.
 *
 * `app.is_platform_admin` is written as the literal string 'true' only for the
 * roles above, and as '' otherwise — `is_platform_admin()` accepts nothing else,
 * so a missing or misspelled value fails closed.
 */
export async function applyTransactionContext(
  tx: DatabaseTransaction,
  store: Readonly<TenantContextStore>,
): Promise<void> {
  const role = store.role ?? 'anon';
  await tx.execute(sql`
    select set_config('app.tenant_id', ${store.tenantId ?? ''}, true),
           set_config('app.user_id', ${store.userId ?? ''}, true),
           set_config('app.member_id', ${store.memberId ?? ''}, true),
           set_config('app.role', ${role}, true),
           set_config('app.is_platform_admin', ${RLS_BYPASS_ROLES.has(role) ? 'true' : ''}, true)
  `);
}

/**
 * The only way request code should reach the database.
 *
 * Why the context can't leak between requests on a pooled connection:
 *  1. `db.transaction()` pins ONE pooled connection from BEGIN to
 *     COMMIT/ROLLBACK; every statement in `work` runs on it.
 *  2. The settings are transaction-local (`is_local = true`). Postgres discards
 *     them at COMMIT and at ROLLBACK (including rollback on an exception),
 *     before postgres-js returns the connection to the pool.
 *  3. The next borrower of that connection therefore starts with every
 *     `app.*` setting empty. Proven in test/tenant-db.db-spec.ts.
 *  4. The only real leak would be a session-level `SET app.x` or
 *     `set_config(…, false)`; src/database/no-session-settings.spec.ts forbids
 *     both anywhere in the codebase.
 *  5. Transaction-local settings are also safe behind PgBouncer in transaction
 *     mode (set DB_PREPARE=false there); session settings would not be.
 */
@Injectable()
export class TenantDb {
  private readonly maxRetries: number;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly context: TenantContext,
    @Inject(APP_CONFIG) env: Pick<Env, 'DB_TX_MAX_RETRIES'>,
  ) {
    this.maxRetries = env.DB_TX_MAX_RETRIES;
  }

  async transaction<T>(
    work: (tx: DatabaseTransaction) => Promise<T>,
    config?: PgTransactionConfig,
  ): Promise<T> {
    const store = this.context.require();
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.db.transaction(async (tx) => {
          await applyTransactionContext(tx, store);
          return work(tx);
        }, config);
      } catch (error) {
        const state = sqlStateOf(error);
        const retryable = state !== undefined && RETRYABLE_SQLSTATES.has(state);
        if (!retryable || attempt >= this.maxRetries) {
          throw error;
        }
      }
    }
  }
}
