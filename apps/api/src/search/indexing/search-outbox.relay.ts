import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import type { DatabaseTransaction } from '../../database/database.client';
import { TenantContext } from '../../database/tenant-context';
import { TenantDb } from '../../database/tenant-db';
import { SettingsService } from '../../settings/settings.service';
import { uuidList, type ResyncScope } from '../documents/search-documents.repository';
import { SEARCH_TYPES, type SearchType } from '../search.types';
import { SearchIndexer } from './search-indexer.service';

// settings-exempt: work-batch size per claim (throughput tuning), not a business rule
const CLAIM_BATCH = 200;
// settings-exempt: caps one relay run so a backlog can't hold the worker forever
const MAX_BATCHES_PER_RUN = 25;
// settings-exempt: lease on claimed events; a worker that dies mid-batch releases them after this
const LEASE_SECONDS = 120;
// settings-exempt: retry backoff curve (2s, 4s, 8s … capped), queue reliability tuning
const BACKOFF_BASE_SECONDS = 2;
// settings-exempt: see above
const BACKOFF_MAX_SECONDS = 600;
// settings-exempt: bounds the stored error text (outbox_events.last_error is internal)
const LAST_ERROR_MAX_CHARS = 500;

/**
 * Event shapes written by the 0020 triggers (schema.md §11.8):
 *   search.sync     — one post/store/place changed; aggregate = the row.
 *   search.resync   — a change that touches many documents; payload.scope says which.
 *   search.settings — locality names/aliases changed: re-apply synonyms.
 */
const scopeSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('category'), category_id: z.string().uuid() }),
  z.object({
    scope: z.literal('tenant_category'),
    tenant_id: z.string().uuid(),
    category_id: z.string().uuid(),
  }),
  z.object({
    scope: z.literal('locality'),
    tenant_id: z.string().uuid(),
    locality_id: z.string().uuid(),
  }),
  z.object({
    scope: z.literal('member'),
    tenant_id: z.string().uuid(),
    member_id: z.string().uuid(),
  }),
  z.object({
    scope: z.literal('place'),
    tenant_id: z.string().uuid(),
    place_id: z.string().uuid(),
  }),
]);

const claimedEvent = z.object({
  id: z.string(),
  aggregate_table: z.string(),
  aggregate_id: z.string(),
  event_type: z.string(),
  payload: z.unknown(),
  attempts: z.coerce.number().int(),
});
type ClaimedEvent = z.infer<typeof claimedEvent>;

export interface RelayPlan {
  sync: Record<SearchType, string[]>;
  scopes: ResyncScope[];
  applySettings: boolean;
  /** Events the relay can't act on (unknown type/shape): marked done and logged, never retried forever. */
  ignored: string[];
}

/** Groups a claimed batch into work, deduplicating ids. Pure, for tests. */
export function planEvents(events: readonly ClaimedEvent[]): RelayPlan {
  const sync = Object.fromEntries(SEARCH_TYPES.map((t) => [t, new Set<string>()])) as Record<
    SearchType,
    Set<string>
  >;
  const scopes = new Map<string, ResyncScope>();
  let applySettings = false;
  const ignored: string[] = [];

  for (const event of events) {
    if (
      event.event_type === 'search.sync' &&
      (SEARCH_TYPES as readonly string[]).includes(event.aggregate_table)
    ) {
      sync[event.aggregate_table as SearchType].add(event.aggregate_id);
    } else if (event.event_type === 'search.resync') {
      const parsed = scopeSchema.safeParse(event.payload);
      if (!parsed.success) {
        ignored.push(event.id);
        continue;
      }
      const scope = toScope(parsed.data);
      scopes.set(JSON.stringify(scope), scope);
    } else if (event.event_type === 'search.settings') {
      applySettings = true;
    } else {
      ignored.push(event.id);
    }
  }
  return {
    sync: Object.fromEntries(SEARCH_TYPES.map((t) => [t, [...sync[t]]])) as Record<
      SearchType,
      string[]
    >,
    scopes: [...scopes.values()],
    applySettings,
    ignored,
  };
}

function toScope(payload: z.infer<typeof scopeSchema>): ResyncScope {
  switch (payload.scope) {
    case 'category':
      return { kind: 'category', categoryId: payload.category_id };
    case 'tenant_category':
      return {
        kind: 'tenant_category',
        tenantId: payload.tenant_id,
        categoryId: payload.category_id,
      };
    case 'locality':
      return { kind: 'locality', tenantId: payload.tenant_id, localityId: payload.locality_id };
    case 'member':
      return { kind: 'member', tenantId: payload.tenant_id, memberId: payload.member_id };
    case 'place':
      return { kind: 'place', tenantId: payload.tenant_id, placeId: payload.place_id };
  }
}

/** Retry delay after the n-th failed attempt. */
export function backoffSeconds(attempts: number): number {
  // settings-exempt: base of the exponential backoff curve
  return Math.min(BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS * 2 ** Math.max(0, attempts - 1));
}

/**
 * Ships `search.*` outbox events to the index. At-least-once:
 *
 *   1. Claim a batch with FOR UPDATE SKIP LOCKED, pushing `available_at`
 *      forward as a lease (a crashed worker's batch comes back by itself) and
 *      counting the attempt.
 *   2. Do the work outside the transaction, so no database transaction is
 *      held open across a network call to Meilisearch.
 *   3. Mark the batch processed — or, on failure, record the error and back
 *      off exponentially. After `search_outbox_max_attempts` an event is
 *      parked (available_at = infinity) for a human to look at; the
 *      search_synced_at sweeper still repairs the documents themselves.
 *
 * Several workers can relay at once: SKIP LOCKED gives each its own batch.
 */
@Injectable()
export class SearchOutboxRelay {
  constructor(
    private readonly indexer: SearchIndexer,
    private readonly settings: SettingsService,
    private readonly tenantDb: TenantDb,
    private readonly tenantContext: TenantContext,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SearchOutboxRelay.name);
  }

  async relay(): Promise<number> {
    let handled = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
      const events = await this.asSystem((tx) => this.claim(tx));
      if (events.length === 0) break;
      const ids = events.map((e) => e.id);
      try {
        await this.process(planEvents(events));
        await this.asSystem((tx) => this.markProcessed(tx, ids));
      } catch (error) {
        await this.fail(events, error);
        break;
      }
      handled += events.length;
      if (events.length < CLAIM_BATCH) break;
    }
    return handled;
  }

  /** Deletes processed search events past `outbox_processed_retention_days`. */
  async purgeProcessed(): Promise<number> {
    const days = await this.settings.get('outbox_processed_retention_days');
    const rows = await this.asSystem((tx) =>
      tx.execute(sql`
        delete from public.outbox_events
        where event_type like 'search.%'
          and processed_at is not null
          and processed_at < now() - make_interval(days => ${days})
        returning id`),
    );
    return [...rows].length;
  }

  private async process(plan: RelayPlan): Promise<void> {
    if (plan.ignored.length > 0) {
      this.logger.warn(
        { eventIds: plan.ignored },
        'ignoring search outbox events with an unknown shape',
      );
    }
    if (plan.applySettings) await this.indexer.applySettings();
    for (const type of SEARCH_TYPES) {
      if (plan.sync[type].length > 0) await this.indexer.syncByIds(type, plan.sync[type]);
    }
    for (const scope of plan.scopes) await this.indexer.resync(scope);
  }

  private async claim(tx: DatabaseTransaction): Promise<ClaimedEvent[]> {
    const rows = await tx.execute(sql`
      update public.outbox_events o
      set attempts = o.attempts + 1,
          available_at = now() + make_interval(secs => ${LEASE_SECONDS})
      where o.id in (
        select id from public.outbox_events
        where processed_at is null
          and available_at <= now()
          and event_type like 'search.%'
        order by available_at, id
        limit ${CLAIM_BATCH}
        for update skip locked
      )
      returning o.id, o.aggregate_table, o.aggregate_id, o.event_type, o.payload, o.attempts`);
    return z.array(claimedEvent).parse([...rows]);
  }

  private async markProcessed(tx: DatabaseTransaction, ids: readonly string[]): Promise<void> {
    await tx.execute(sql`
      update public.outbox_events
      set processed_at = now(), last_error = null
      where id in ${uuidList(ids)}`);
  }

  private async fail(events: readonly ClaimedEvent[], error: unknown): Promise<void> {
    const maxAttempts = await this.settings.get('search_outbox_max_attempts');
    const message = (
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    ).slice(0, LAST_ERROR_MAX_CHARS);
    const parked = events.filter((e) => e.attempts >= maxAttempts).map((e) => e.id);
    const retry = events.filter((e) => e.attempts < maxAttempts);
    await this.asSystem(async (tx) => {
      for (const event of retry) {
        await tx.execute(sql`
          update public.outbox_events
          set last_error = ${message},
              available_at = now() + make_interval(secs => ${backoffSeconds(event.attempts)})
          where id = ${event.id}::uuid`);
      }
      if (parked.length > 0) {
        await tx.execute(sql`
          update public.outbox_events
          set last_error = ${message}, available_at = 'infinity'
          where id in ${uuidList(parked)}`);
      }
    });
    const log = { err: error, events: events.length, parked: parked.length };
    if (parked.length > 0) this.logger.error(log, 'search outbox events parked after max attempts');
    else this.logger.warn(log, 'search outbox batch failed; will retry');
  }

  private asSystem<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.tenantContext.run({ role: 'system' }, () => this.tenantDb.transaction(work));
  }
}
