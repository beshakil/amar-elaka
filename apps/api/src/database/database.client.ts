import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema';

export type Database = PostgresJsDatabase<typeof schema>;

/** A Drizzle transaction handle, as passed to `db.transaction(async (tx) => …)`. */
export type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface DatabaseClientOptions {
  url: string;
  poolMax: number;
  idleTimeoutSeconds: number;
  connectTimeoutSeconds: number;
  statementTimeoutMs: number;
  prepare: boolean;
  applicationName: string;
}

/**
 * postgres-js pool. Each query borrows a connection; a transaction pins one
 * connection from BEGIN to COMMIT/ROLLBACK (see TenantDb for why that matters).
 */
export function createSqlClient(options: DatabaseClientOptions): Sql {
  return postgres(options.url, {
    max: options.poolMax,
    idle_timeout: options.idleTimeoutSeconds,
    connect_timeout: options.connectTimeoutSeconds,
    prepare: options.prepare,
    onnotice: () => undefined,
    connection: {
      application_name: options.applicationName,
      statement_timeout: options.statementTimeoutMs,
    },
  });
}

export function createDatabase(client: Sql): Database {
  return drizzle(client, { schema });
}
