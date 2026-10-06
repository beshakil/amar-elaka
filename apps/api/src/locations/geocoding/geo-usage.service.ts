import { Injectable } from '@nestjs/common';
import { SettingsService } from '../../settings/settings.service';
import { GeoCallLog } from './geo-call-log';
import type { GeoUsageQuery, GeoUsageResponse } from './geo.dto';

const PERCENT = 100; // settings-exempt: unit conversion
// settings-exempt: rates and percentages are shown to one decimal place
const ONE_DECIMAL = 10;

/** Of the requests that needed a provider answer, the share the cache gave; null with none. */
const rate = (cacheHits: number, providerRequests: number): number | null => {
  const needed = cacheHits + providerRequests;
  return needed === 0
    ? null
    : Math.round((cacheHits / needed) * PERCENT * ONE_DECIMAL) / ONE_DECIMAL;
};

/**
 * What the geo provider costs (ADR 044), from geo_provider_calls: calls and
 * requests per day, cache hit rate, the endpoints that cost the most, today's
 * share of the budget, and this month so far with a straight-line projection.
 */
@Injectable()
export class GeoUsageService {
  constructor(
    private readonly log: GeoCallLog,
    private readonly settings: SettingsService,
  ) {}

  async report(query: GeoUsageQuery): Promise<GeoUsageResponse> {
    const [maxDays, budget, provider] = await Promise.all([
      this.settings.get('geo_usage_report_days_max'),
      this.settings.get('barikoi_daily_call_budget'),
      this.settings.get('geo_provider'),
    ]);
    const days = Math.min(query.days ?? maxDays, maxDays);
    const [usage, today] = await Promise.all([this.log.usage(days), this.log.callsToday(provider)]);
    const counts = (r: {
      requests: number;
      calls: number;
      cache_hits: number;
      provider_requests: number;
    }) => ({
      requests: r.requests,
      calls: r.calls,
      cacheHits: r.cache_hits,
      cacheHitRate: rate(r.cache_hits, r.provider_requests),
    });
    const { month } = usage;
    return {
      provider,
      days: usage.days.map((d) => ({ day: d.day, ...counts(d) })),
      topEndpoints: usage.endpoints.map((e) => ({ endpoint: e.endpoint, ...counts(e) })),
      today: {
        calls: today,
        budget,
        usedPct:
          budget > 0 ? Math.round((today / budget) * PERCENT * ONE_DECIMAL) / ONE_DECIMAL : null,
      },
      month: {
        callsSoFar: month.calls,
        projectedCalls:
          month.days_elapsed > 0
            ? Math.round((month.calls / month.days_elapsed) * month.days_in_month)
            : month.calls,
      },
    };
  }
}
