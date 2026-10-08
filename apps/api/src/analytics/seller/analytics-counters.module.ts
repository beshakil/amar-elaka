import { Module } from '@nestjs/common';
import { SettingsModule } from '../../settings/settings.module';
import { ANALYTICS_COUNTER_STORE, RedisAnalyticsCounterStore } from './analytics-counter.store';
import { AnalyticsRollupService } from './analytics-rollup.service';
import { AnalyticsTracker } from './analytics-tracker.service';
import { SellerAnalyticsRepository } from './seller-analytics.repository';

/**
 * The counting side of seller analytics (ADR 055): the tracker the request
 * paths call (views, contacts, saves, shares, search, map) and the nightly
 * rollup. No module imports — anything may import this one without a cycle.
 */
@Module({
  imports: [SettingsModule],
  providers: [
    { provide: ANALYTICS_COUNTER_STORE, useClass: RedisAnalyticsCounterStore },
    AnalyticsTracker,
    AnalyticsRollupService,
    SellerAnalyticsRepository,
  ],
  exports: [
    AnalyticsTracker,
    AnalyticsRollupService,
    SellerAnalyticsRepository,
    ANALYTICS_COUNTER_STORE,
  ],
})
export class AnalyticsCountersModule {}
