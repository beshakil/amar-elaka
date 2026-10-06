import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import type { DatabaseTransaction } from '../../database/database.client';
import { TenantContext } from '../../database/tenant-context';
import { TenantDb } from '../../database/tenant-db';
import type { GeoEndpoint } from './geo-provider.port';

export type GeoCallStatus =
  | 'ok'
  | 'empty'
  | 'cache_hit'
  | 'rate_limited'
  | 'unauthorized'
  | 'error'
  | 'timeout'
  | 'over_budget'
  | 'disabled';

export interface GeoCallEntry {
  provider: string;
  endpoint: GeoEndpoint;
  /** What the provider bills (0 for a cache hit or a call that never reached it). */
  callsCounted: number;
  cacheHit: boolean;
  latencyMs: number | null;
  status: GeoCallStatus;
  /** Whose request it was (cost attribution only). */
  tenantId: string | null;
}

const SumRow = z.object({ calls: z.coerce.number() });
const counts = {
  /** Every logged request: calls, cache hits and refusals. */
  requests: z.coerce.number(),
  /** Barikoi calls as billed. */
  calls: z.coerce.number(),
  cache_hits: z.coerce.number(),
  /** Requests that reached the provider (it may bill them). */
  provider_requests: z.coerce.number(),
};
const DayRow = z.object({ day: z.string(), ...counts });
const EndpointRow = z.object({ endpoint: z.string(), ...counts });
const MonthRow = z.object({
  calls: z.coerce.number(),
  days_elapsed: z.coerce.number(),
  days_in_month: z.coerce.number(),
});
const DeletedRow = z.object({ deleted: z.coerce.number() });

export interface GeoUsageRows {
  days: z.infer<typeof DayRow>[];
  endpoints: z.infer<typeof EndpointRow>[];
  month: z.infer<typeof MonthRow>;
}

// The Asia/Dhaka day a timestamp falls on, and the start of today there: the
// budget's day, so reports and the budget agree on what "today" is.
const DHAKA_DAY = sql.raw(`(created_at at time zone 'Asia/Dhaka')::date`);
const DHAKA_TODAY_START = sql.raw(
  `(date_trunc('day', now() at time zone 'Asia/Dhaka') at time zone 'Asia/Dhaka')`,
);
const DHAKA_MONTH_START = sql.raw(
  `(date_trunc('month', now() at time zone 'Asia/Dhaka') at time zone 'Asia/Dhaka')`,
);

/**
 * geo_provider_calls (0039, ADR 044): one row per provider request — a paid
 * call, a cache hit, or one the budget, breaker or settings refused. Written,
 * counted and purged as the system role: the requesting user can neither read
 * the platform's costs nor forge a row. Never what was asked (no query text,
 * no coordinates).
 */
@Injectable()
export class GeoCallLog {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(GeoCallLog.name);
  }

  /** Records a request. Never throws: a lost log row must not fail the request. */
  async record(entry: GeoCallEntry): Promise<void> {
    try {
      await this.asSystem(async (tx) => {
        await tx.execute(sql`
          insert into geo_provider_calls
            (provider, endpoint, calls_counted, cache_hit, latency_ms, status, tenant_id)
          values (${entry.provider}, ${entry.endpoint}, ${entry.callsCounted}, ${entry.cacheHit},
                  ${entry.latencyMs}, ${entry.status}, ${entry.tenantId})`);
      });
    } catch (error) {
      this.logger.error({ err: error, ...entry }, 'could not log a geo provider call');
    }
  }

  /** Calls billed today (Asia/Dhaka): the budget's count when Redis is down. */
  async callsToday(provider: string): Promise<number> {
    return this.asSystem(async (tx) => {
      const rows = await tx.execute(sql`
        select coalesce(sum(calls_counted), 0) as calls
        from geo_provider_calls
        where provider = ${provider} and created_at >= ${DHAKA_TODAY_START}`);
      return SumRow.parse([...rows][0]).calls;
    });
  }

  /** Per-day and per-endpoint usage over the last `days` days, and this month so far. */
  async usage(days: number): Promise<GeoUsageRows> {
    return this.asSystem(async (tx) => {
      const since = sql`${DHAKA_TODAY_START} - make_interval(days => ${days - 1})`;
      const [dayRows, endpointRows, monthRows] = await Promise.all([
        // Every day of the window, a day without requests as zeros.
        tx.execute(sql`
          with logged as (
            select ${DHAKA_DAY} as day, count(*) as requests,
                   coalesce(sum(calls_counted), 0) as calls,
                   count(*) filter (where cache_hit) as cache_hits,
                   count(*) filter (where calls_counted > 0) as provider_requests
            from geo_provider_calls
            where created_at >= ${since}
            group by 1)
          select d.day::date::text as day, coalesce(l.requests, 0) as requests,
                 coalesce(l.calls, 0) as calls, coalesce(l.cache_hits, 0) as cache_hits,
                 coalesce(l.provider_requests, 0) as provider_requests
          from generate_series((now() at time zone 'Asia/Dhaka')::date - ${days - 1}::integer,
                               (now() at time zone 'Asia/Dhaka')::date, interval '1 day') as d(day)
          left join logged l on l.day = d.day::date
          order by 1`),
        tx.execute(sql`
          select endpoint, count(*) as requests, coalesce(sum(calls_counted), 0) as calls,
                 count(*) filter (where cache_hit) as cache_hits,
                 count(*) filter (where calls_counted > 0) as provider_requests
          from geo_provider_calls
          where created_at >= ${since}
          group by endpoint order by calls desc, requests desc, endpoint`),
        tx.execute(sql`
          select coalesce(sum(calls_counted), 0) as calls,
                 extract(day from now() at time zone 'Asia/Dhaka') as days_elapsed,
                 extract(day from (date_trunc('month', now() at time zone 'Asia/Dhaka')
                                   + interval '1 month - 1 day')) as days_in_month
          from geo_provider_calls
          where created_at >= ${DHAKA_MONTH_START}`),
      ]);
      return {
        days: z.array(DayRow).parse([...dayRows]),
        endpoints: z.array(EndpointRow).parse([...endpointRows]),
        month: MonthRow.parse([...monthRows][0]),
      };
    });
  }

  /** Deletes up to `batchSize` rows older than `retentionDays`; returns how many went. */
  async purge(retentionDays: number, batchSize: number): Promise<number> {
    return this.asSystem(async (tx) => {
      const rows = await tx.execute(sql`
        with gone as (
          delete from geo_provider_calls
          where id in (
            select id from geo_provider_calls
            where created_at < now() - make_interval(days => ${retentionDays})
            order by created_at
            limit ${batchSize})
          returning 1)
        select count(*) as deleted from gone`);
      return DeletedRow.parse([...rows][0]).deleted;
    });
  }

  private asSystem<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.context.run({ role: 'system' }, () => this.tenantDb.transaction(work));
  }
}
