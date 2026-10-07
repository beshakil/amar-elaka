import { resolveTestDatabaseUrl, testSqlClient } from './test-database';

/**
 * The DB suites share one database with the e2e suites that run after them.
 * A suite that leaves its outbox events behind makes a later suite's relay
 * drain them and time out, which looks like a flaky test somewhere else
 * (month 2 review: one fixture once left 200k). Every suite deletes what it
 * creates; this fails the run when the outbox shows one didn't.
 */
// A full DB run leaves a few hundred (rows its triggers queue that no fixture owns).
const MAX_PENDING_OUTBOX_EVENTS = 5_000;

export default async function globalTeardown(): Promise<void> {
  const sql = testSqlClient(1, resolveTestDatabaseUrl());
  try {
    const rows = await sql<{ aggregate_table: string; n: number }[]>`
      select aggregate_table, count(*)::int as n from public.outbox_events
      where processed_at is null
      group by 1 order by 2 desc`;
    const total = rows.reduce((sum, r) => sum + r.n, 0);
    if (total > MAX_PENDING_OUTBOX_EVENTS) {
      throw new Error(
        `DB suites left ${total} unprocessed outbox events (limit ${MAX_PENDING_OUTBOX_EVENTS}): ` +
          rows.map((r) => `${r.aggregate_table} ${r.n}`).join(', ') +
          ". A fixture isn't deleting its outbox_events (see post-field-filters.db-spec.ts cleanUp).",
      );
    }
  } finally {
    await sql.end();
  }
}
