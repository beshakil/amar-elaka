import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { cleanMetrics, type CounterField, type DayMetrics } from './analytics-metrics';

export type EntityType = 'post' | 'store';

/** Whose unique visitors a sketch counts: a post, a store (its page and posts), or a member's posts. */
export type SketchOwner = { type: 'post' | 'store' | 'member'; id: string };

export interface EntityRef {
  tenantId: string;
  type: EntityType;
  id: string;
}

export interface CounterTtls {
  /** analytics_counter_retention_days, in seconds. */
  counters: number;
  /** analytics_unique_retention_days, in seconds. */
  uniques: number;
}

/**
 * The live half of seller analytics (ADR 055), in Redis:
 *
 *  - `an:c:<day>:<type>:<id>` a hash of the day's counters per post or store;
 *  - `an:i:<day>` the set of entities touched that day (`<tenant>|<type>|<id>`),
 *    so the nightly rollup never scans keys;
 *  - `an:v:` / `an:k:<day>:<owner>` HyperLogLogs of the day's distinct viewers
 *    and contacters, kept long enough for a period and the one before it to be
 *    counted exactly (PFCOUNT over the days);
 *  - `an:d:` one-time claims, for views that need their own dedupe (store pages).
 */
export interface AnalyticsCounterStore {
  increment(
    day: string,
    entity: EntityRef,
    field: CounterField,
    by: number,
    ttls: CounterTtls,
  ): Promise<void>;
  /** Several entities' same field at once (search appearances). */
  incrementMany(
    day: string,
    entities: readonly EntityRef[],
    field: CounterField,
    ttls: CounterTtls,
  ): Promise<void>;
  addUnique(
    day: string,
    kind: 'viewers' | 'contacters',
    owners: readonly SketchOwner[],
    visitor: string,
    ttls: CounterTtls,
    index?: readonly EntityRef[],
  ): Promise<void>;
  claimOnce(key: string, ttlSeconds: number): Promise<boolean>;
  /** The day's counters for each entity (empty object when none). */
  readDay(day: string, entities: readonly EntityRef[]): Promise<DayMetrics[]>;
  /** Distinct visitors across the given days, one count per owner group. */
  countUnique(
    kind: 'viewers' | 'contacters',
    days: readonly string[],
    owners: readonly SketchOwner[],
  ): Promise<number>;
  /** The entities touched on `day`. */
  touched(day: string): Promise<EntityRef[]>;
}

export const ANALYTICS_COUNTER_STORE = Symbol('ANALYTICS_COUNTER_STORE');

const PREFIX = 'an:';
const counterKey = (day: string, e: EntityRef) => `${PREFIX}c:${day}:${e.type}:${e.id}`;
const indexKey = (day: string) => `${PREFIX}i:${day}`;
const sketchKey = (kind: 'viewers' | 'contacters', day: string, o: SketchOwner) =>
  `${PREFIX}${kind === 'viewers' ? 'v' : 'k'}:${day}:${o.type}:${o.id}`;
const indexMember = (e: EntityRef) => `${e.tenantId}|${e.type}|${e.id}`;

@Injectable()
export class RedisAnalyticsCounterStore implements AnalyticsCounterStore, OnModuleDestroy {
  private readonly client: Redis;

  constructor(@Inject(APP_CONFIG) env: Pick<Env, 'REDIS_URL'>) {
    this.client = new Redis(env.REDIS_URL, { lazyConnect: true });
  }

  async increment(
    day: string,
    entity: EntityRef,
    field: CounterField,
    by: number,
    ttls: CounterTtls,
  ): Promise<void> {
    const key = counterKey(day, entity);
    await this.client
      .multi()
      .hincrby(key, field, by)
      .expire(key, ttls.counters, 'NX')
      .sadd(indexKey(day), indexMember(entity))
      .expire(indexKey(day), ttls.counters, 'NX')
      .exec();
  }

  async incrementMany(
    day: string,
    entities: readonly EntityRef[],
    field: CounterField,
    ttls: CounterTtls,
  ): Promise<void> {
    if (entities.length === 0) return;
    const multi = this.client.multi();
    for (const entity of entities) {
      const key = counterKey(day, entity);
      multi.hincrby(key, field, 1).expire(key, ttls.counters, 'NX');
    }
    multi
      .sadd(indexKey(day), ...entities.map(indexMember))
      .expire(indexKey(day), ttls.counters, 'NX');
    await multi.exec();
  }

  async addUnique(
    day: string,
    kind: 'viewers' | 'contacters',
    owners: readonly SketchOwner[],
    visitor: string,
    ttls: CounterTtls,
    index: readonly EntityRef[] = [],
  ): Promise<void> {
    const multi = this.client.multi();
    for (const owner of owners) {
      const key = sketchKey(kind, day, owner);
      multi.pfadd(key, visitor).expire(key, ttls.uniques, 'NX');
    }
    // A store whose only activity is its posts' views still needs its day rolled up.
    if (index.length > 0) {
      multi
        .sadd(indexKey(day), ...index.map(indexMember))
        .expire(indexKey(day), ttls.counters, 'NX');
    }
    await multi.exec();
  }

  async claimOnce(key: string, ttlSeconds: number): Promise<boolean> {
    return (await this.client.set(`${PREFIX}d:${key}`, '1', 'EX', ttlSeconds, 'NX')) === 'OK';
  }

  async readDay(day: string, entities: readonly EntityRef[]): Promise<DayMetrics[]> {
    if (entities.length === 0) return [];
    const multi = this.client.multi();
    for (const entity of entities) multi.hgetall(counterKey(day, entity));
    const results = (await multi.exec()) ?? [];
    return entities.map((_, i) => cleanMetrics(results[i]?.[1] as Record<string, string> | null));
  }

  async countUnique(
    kind: 'viewers' | 'contacters',
    days: readonly string[],
    owners: readonly SketchOwner[],
  ): Promise<number> {
    const keys = days.flatMap((day) => owners.map((owner) => sketchKey(kind, day, owner)));
    if (keys.length === 0) return 0;
    return this.client.pfcount(...keys);
  }

  async touched(day: string): Promise<EntityRef[]> {
    const members = await this.client.smembers(indexKey(day));
    return members.flatMap((m) => {
      const [tenantId, type, id] = m.split('|');
      return tenantId && id && (type === 'post' || type === 'store')
        ? [{ tenantId, type, id }]
        : [];
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }
}
