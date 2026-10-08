import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { UnauthenticatedException } from '../../auth/exceptions/auth.exceptions';
import { sqlStateOf } from '../../common/utils/sql-state';
import { TenantContext } from '../../database/tenant-context';
import { TenantDb } from '../../database/tenant-db';
import { PostOwnershipService } from '../../posts/post-ownership.service';
import { SettingsService } from '../../settings/settings.service';
import {
  addDays,
  ANALYTICS_TIMEZONE,
  daysFrom,
  localDay,
  periodWindow,
  type PeriodWindow,
} from './analytics-day';
import {
  ANALYTICS_COUNTER_STORE,
  type AnalyticsCounterStore,
  type EntityRef,
  type SketchOwner,
} from './analytics-counter.store';
import { addMetrics, cleanMetrics, contactsOf, type DayMetrics } from './analytics-metrics';
import { analyticsSummary } from './analytics-summary.templates';
import type { AnalyticsMetrics, AnalyticsQuery, SellerAnalytics } from './dto/seller-analytics.dto';
import {
  AnalyticsForbiddenException,
  AnalyticsPeriodInvalidException,
  AnalyticsStoreNotFoundException,
} from './seller-analytics.exceptions';
import { SellerAnalyticsRepository, type ScopePostRow } from './seller-analytics.repository';

// settings-exempt: rounding of a displayed ratio and percentage, not a business number
const RATIO_DECIMALS = 4;
// settings-exempt: see above
const PERCENT_DECIMALS = 1;
// settings-exempt: percent
const PERCENT = 100;

const round = (n: number, decimals: number) => Number(n.toFixed(decimals));
const entityKey = (type: string, id: string) => `${type}|${id}`;

/** The API shape of a set of day metrics (+ the period's distinct people). */
export function toApiMetrics(
  m: DayMetrics,
  uniques: { viewers: number; contacters: number },
): AnalyticsMetrics {
  const views = m.views ?? 0;
  const contacts = contactsOf(m);
  return {
    views,
    uniqueViewers: uniques.viewers,
    contacts: {
      total: contacts,
      call: m.contacts_call ?? 0,
      whatsapp: m.contacts_whatsapp ?? 0,
      sms: m.contacts_sms ?? 0,
      chat: m.contacts_chat ?? 0,
    },
    uniqueContacters: uniques.contacters,
    saves: m.saves ?? 0,
    shares: m.share_opens ?? 0,
    searchAppearances: m.search_appearances ?? 0,
    mapTaps: m.map_taps ?? 0,
    conversionRate: views === 0 ? 0 : round(contacts / views, RATIO_DECIMALS),
  };
}

/** Percent change; null when the previous period had nothing to compare with. */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return round(((current - previous) / previous) * PERCENT, PERCENT_DECIMALS);
}

/**
 * GET /stores/:id/analytics and GET /posts/me/analytics (ADR 055): "people
 * found you, and this many contacted you". Finished days come from
 * analytics_daily (seller_daily_metrics, 0051); today — and yesterday until
 * the nightly rollup has run — live from the Redis counters. Distinct people
 * are counted exactly across the period from the per-day sketches. Never a
 * read of lead_events; never a scrubbed post.
 */
@Injectable()
export class SellerAnalyticsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: SellerAnalyticsRepository,
    private readonly ownership: PostOwnershipService,
    private readonly settings: SettingsService,
    @Inject(ANALYTICS_COUNTER_STORE) private readonly store: AnalyticsCounterStore,
  ) {}

  async forStore(
    storeId: string,
    query: AnalyticsQuery,
    now: Date = new Date(),
  ): Promise<SellerAnalytics> {
    this.requireUserId();
    const tenantId = await this.tenantDb.transaction(
      async (tx) => {
        const rows = await tx.execute(
          sql`select public.item_tenant_of('store', ${storeId}::uuid) as tenant_id`,
        );
        return z.array(z.object({ tenant_id: z.string().nullable() })).parse([...rows])[0]
          ?.tenant_id;
      },
      { accessMode: 'read only' },
    );
    if (!tenantId) throw new AnalyticsStoreNotFoundException();
    const days = await this.periodDays(query, tenantId);
    return this.ownership.inTenant(tenantId, 'lookup', () =>
      this.build({ tenantId, storeId }, days, now),
    );
  }

  async forMyPosts(query: AnalyticsQuery, now: Date = new Date()): Promise<SellerAnalytics> {
    this.requireUserId();
    const days = await this.periodDays(query, undefined);
    return this.build(null, days, now);
  }

  private async build(
    store: { tenantId: string; storeId: string } | null,
    periodLength: number,
    now: Date,
  ): Promise<SellerAnalytics> {
    const storeId = store?.storeId ?? null;
    const today = localDay(now, ANALYTICS_TIMEZONE);
    const yesterday = addDays(today, -1);
    const window = periodWindow(today, periodLength);
    const [minSearchers, queryLimit, postLimit, available] = await Promise.all([
      this.settings.get('analytics_query_min_searchers', store?.tenantId),
      this.settings.get('analytics_top_queries', store?.tenantId),
      this.settings.get('analytics_top_posts', store?.tenantId),
      this.availablePeriods(store?.tenantId),
    ]);

    const { scope, rows, queries } = await this.tenantDb.transaction(
      async (tx) => {
        try {
          const posts = await this.repo.scope(tx, storeId);
          return {
            scope: posts,
            rows: await this.repo.daily(tx, storeId, window.previousFrom, yesterday),
            queries: await this.repo.topQueries(
              tx,
              storeId,
              { from: window.from, toExclusive: addDays(today, 1), timeZone: ANALYTICS_TIMEZONE },
              minSearchers,
              queryLimit,
            ),
          };
        } catch (error) {
          if (sqlStateOf(error) === 'AE250') throw new AnalyticsForbiddenException();
          throw error;
        }
      },
      { accessMode: 'read only' },
    );

    // entity → day → metrics: the rolled-up days, then the live ones not rolled up yet.
    const byEntity = new Map<string, Map<string, DayMetrics>>();
    const put = (key: string, day: string, m: DayMetrics) => {
      const days = byEntity.get(key) ?? new Map<string, DayMetrics>();
      days.set(day, m);
      byEntity.set(key, days);
    };
    for (const row of rows)
      put(entityKey(row.entity_type, row.entity_id), row.stat_date, cleanMetrics(row.metrics));

    const entities: EntityRef[] = [
      ...scope.map((p): EntityRef => ({ tenantId: p.tenant_id, type: 'post', id: p.post_id })),
      ...(store ? [{ tenantId: store.tenantId, type: 'store' as const, id: store.storeId }] : []),
    ];
    for (const day of [yesterday, today]) {
      const live = await this.store.readDay(day, entities);
      for (const [i, entity] of entities.entries()) {
        const key = entityKey(entity.type, entity.id);
        if (byEntity.get(key)?.has(day)) continue; // rolled up: the database's count wins
        if (Object.keys(live[i] ?? {}).length > 0) put(key, day, live[i]!);
      }
    }

    const sum = (keys: Iterable<string>, from: string, to: string): DayMetrics => {
      let total: DayMetrics = {};
      for (const key of keys) {
        for (const [day, m] of byEntity.get(key) ?? []) {
          if (day >= from && day <= to) total = addMetrics(total, m);
        }
      }
      return total;
    };
    const allKeys = [...byEntity.keys()];
    const owners: SketchOwner[] = store
      ? [{ type: 'store', id: store.storeId }]
      : [
          ...new Set(
            scope.map((p) => p.author_member_id).filter((id): id is string => id !== null),
          ),
        ].map((id) => ({ type: 'member' as const, id }));

    const current = sum(allKeys, window.from, window.to);
    const previous = sum(allKeys, window.previousFrom, window.previousTo);
    const [currentUniques, previousUniques] = await Promise.all([
      this.uniques(owners, window.from, window.to, current),
      this.uniques(owners, window.previousFrom, window.previousTo, previous),
    ]);
    const totals = toApiMetrics(current, currentUniques);
    const before = toApiMetrics(previous, previousUniques);

    return {
      scope: store ? 'store' : 'posts',
      period: { ...window, available },
      summary: analyticsSummary({
        days: window.days,
        viewers: totals.uniqueViewers,
        contacters: totals.uniqueContacters,
        subject: store ? 'store' : 'posts',
      }),
      totals,
      previous: before,
      trend: {
        views: percentChange(totals.views, before.views),
        uniqueViewers: percentChange(totals.uniqueViewers, before.uniqueViewers),
        contacts: percentChange(totals.contacts.total, before.contacts.total),
        uniqueContacters: percentChange(totals.uniqueContacters, before.uniqueContacters),
        saves: percentChange(totals.saves, before.saves),
        shares: percentChange(totals.shares, before.shares),
        searchAppearances: percentChange(totals.searchAppearances, before.searchAppearances),
        mapTaps: percentChange(totals.mapTaps, before.mapTaps),
        conversionRate: percentChange(totals.conversionRate, before.conversionRate),
      },
      daily: daysFrom(window.from, window.to).map((day) => {
        const m = sum(allKeys, day, day);
        return { date: day, views: m.views ?? 0, contacts: contactsOf(m) };
      }),
      topPosts: await this.topPosts(
        scope,
        (key) => sum([key], window.from, window.to),
        window,
        postLimit,
      ),
      topQueries: queries.map((q) => ({
        query: q.q_normalized,
        searchers: q.searchers,
        clicks: q.clicks,
      })),
      generatedAt: now.toISOString(),
    };
  }

  /** The period's busiest posts: most views, then most contacts. */
  private async topPosts(
    scope: readonly ScopePostRow[],
    metricsOf: (key: string) => DayMetrics,
    window: PeriodWindow,
    limit: number,
  ): Promise<SellerAnalytics['topPosts']> {
    const ranked = scope
      .map((post) => ({ post, m: metricsOf(entityKey('post', post.post_id)) }))
      .filter((r) => (r.m.views ?? 0) + contactsOf(r.m) > 0)
      .sort(
        (a, b) =>
          (b.m.views ?? 0) - (a.m.views ?? 0) ||
          contactsOf(b.m) - contactsOf(a.m) ||
          a.post.post_id.localeCompare(b.post.post_id),
      )
      .slice(0, limit);
    return Promise.all(
      ranked.map(async ({ post, m }) => ({
        postId: post.post_id,
        tenantId: post.tenant_id,
        title: post.title,
        status: post.status_code,
        metrics: toApiMetrics(
          m,
          await this.uniques([{ type: 'post', id: post.post_id }], window.from, window.to, m),
        ),
      })),
    );
  }

  /**
   * Distinct people across the days, from the day sketches; when those are
   * gone (older than analytics_unique_retention_days, or Redis lost them),
   * the sum of each day's distinct count — an upper bound, never zero by
   * accident.
   */
  private async uniques(
    owners: readonly SketchOwner[],
    from: string,
    to: string,
    summed: DayMetrics,
  ): Promise<{ viewers: number; contacters: number }> {
    if (owners.length === 0) return { viewers: 0, contacters: 0 };
    const days = daysFrom(from, to);
    const [viewers, contacters] = await Promise.all([
      this.store.countUnique('viewers', days, owners),
      this.store.countUnique('contacters', days, owners),
    ]);
    return {
      viewers: viewers > 0 ? viewers : (summed.unique_viewers ?? 0),
      contacters: contacters > 0 ? contacters : (summed.unique_contacters ?? 0),
    };
  }

  private async availablePeriods(tenantId: string | undefined): Promise<number[]> {
    const raw = await this.settings.get('analytics_periods_days', tenantId);
    return raw.filter((d): d is number => typeof d === 'number' && d > 0);
  }

  private async periodDays(query: AnalyticsQuery, tenantId: string | undefined): Promise<number> {
    const available = await this.availablePeriods(tenantId);
    if (!query.period) return available[0] ?? 0;
    const days = Number(query.period.slice(0, -1));
    if (!available.includes(days)) throw new AnalyticsPeriodInvalidException(available);
    return days;
  }

  private requireUserId(): string {
    const userId = this.context.require().userId;
    if (!userId) throw new UnauthenticatedException();
    return userId;
  }
}
