/** Typed Drizzle client (for migrations, system jobs and tests; request code uses TenantDb). */
export const DB = Symbol('DB');

/** Underlying postgres-js pool, owned by DatabaseModule and closed on shutdown. */
export const SQL_CLIENT = Symbol('SQL_CLIENT');
