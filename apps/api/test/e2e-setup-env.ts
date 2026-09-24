import { resolveTestAppDatabaseUrl } from './db/test-database';

/**
 * Runs before any module is imported, which matters because src/config/env.ts
 * parses process.env at import time.
 *
 * e2e specs boot the real DatabaseModule, and its privilege check refuses to
 * start on a superuser, a BYPASSRLS role, or the schema owner. So the app under
 * test connects to the TEST database as ae_app — exactly like production.
 */
process.env.DATABASE_URL = resolveTestAppDatabaseUrl();
