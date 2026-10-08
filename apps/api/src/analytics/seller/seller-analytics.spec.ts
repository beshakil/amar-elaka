import { bengaliNumber, groupSouthAsian } from '../../common/text/bengali-numerals';
import { bengaliTaka } from '../../seo/og-image/og-image.templates';
import { addDays, daysFrom, localDay, periodWindow } from './analytics-day';
import { addMetrics, cleanMetrics, contactsOf } from './analytics-metrics';
import { analyticsSummary } from './analytics-summary.templates';
import { AnalyticsTracker } from './analytics-tracker.service';
import { percentChange, toApiMetrics } from './seller-analytics.service';

describe('seller analytics (ADR 055)', () => {
  describe('the headline', () => {
    it('says how many people saw and contacted, in Bengali digits', () => {
      expect(
        analyticsSummary({ days: 30, viewers: 1240, contacters: 47, subject: 'posts' }).bn,
      ).toBe('গত ৩০ দিনে ১,২৪০ জন আপনার পোস্ট দেখেছেন, ৪৭ জন যোগাযোগ করেছেন।');
      expect(analyticsSummary({ days: 7, viewers: 12, contacters: 0, subject: 'store' }).bn).toBe(
        'গত ৭ দিনে ১২ জন আপনার দোকান দেখেছেন, এখনও কেউ যোগাযোগ করেননি।',
      );
      expect(analyticsSummary({ days: 90, viewers: 0, contacters: 0, subject: 'posts' }).bn).toBe(
        'গত ৯০ দিনে এখনও কেউ আপনার পোস্ট দেখেননি।',
      );
    });

    it('has an English twin', () => {
      expect(
        analyticsSummary({ days: 30, viewers: 1240, contacters: 1, subject: 'posts' }).en,
      ).toBe('In the last 30 days, 1,240 people saw your posts and 1 person contacted you.');
    });
  });

  describe('Bengali numerals (one helper, shared with the share image)', () => {
    it('groups the South Asian way', () => {
      expect(groupSouthAsian('1234567')).toBe('12,34,567');
      expect(bengaliNumber(1240)).toBe('১,২৪০');
      expect(bengaliNumber(0)).toBe('০');
      expect(bengaliTaka('65000.00')).toBe('৳ ৬৫,০০০');
      expect(bengaliTaka('1500.50')).toBe('৳ ১,৫০০.৫০');
    });
  });

  describe('days', () => {
    it('counts in Dhaka local days', () => {
      // 19:30 UTC is 01:30 the next day in Dhaka.
      expect(localDay(new Date('2026-10-08T19:30:00Z'))).toBe('2026-10-09');
      expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
      expect(daysFrom('2026-10-07', '2026-10-09')).toEqual([
        '2026-10-07',
        '2026-10-08',
        '2026-10-09',
      ]);
    });

    it('a period is the last N days including today, and the N before it', () => {
      expect(periodWindow('2026-10-09', 7)).toEqual({
        days: 7,
        from: '2026-10-03',
        to: '2026-10-09',
        previousFrom: '2026-09-26',
        previousTo: '2026-10-02',
      });
    });
  });

  describe('metrics', () => {
    it('keeps only known whole numbers', () => {
      expect(
        cleanMetrics({ views: '12', saves: -1, unknown: 5, map_taps: 1.5, contacts_call: 3 }),
      ).toEqual({
        views: 12,
        contacts_call: 3,
      });
    });

    it('adds days, counts contacts across channels and their share of views', () => {
      const m = addMetrics(
        { views: 40, contacts_call: 2 },
        { views: 60, contacts_whatsapp: 1, contacts_chat: 1 },
      );
      expect(contactsOf(m)).toBe(4);
      const api = toApiMetrics(m, { viewers: 70, contacters: 3 });
      expect(api).toMatchObject({
        views: 100,
        uniqueViewers: 70,
        contacts: { total: 4, call: 2, whatsapp: 1, sms: 0, chat: 1 },
        uniqueContacters: 3,
        conversionRate: 0.04,
      });
      expect(toApiMetrics({}, { viewers: 0, contacters: 0 }).conversionRate).toBe(0);
    });

    it('a trend is the percent change, null without a previous period', () => {
      expect(percentChange(150, 100)).toBe(50);
      expect(percentChange(50, 200)).toBe(-75);
      expect(percentChange(5, 0)).toBeNull();
      expect(percentChange(1, 3)).toBe(-66.7);
    });
  });
});

describe('the tracker', () => {
  it('counts search appearances for posts and stores only, in one call, and never throws', async () => {
    const calls: { field: string; ids: string[] }[] = [];
    const store = {
      incrementMany: (_day: string, entities: { id: string; type: string }[], field: string) => {
        calls.push({ field, ids: entities.map((e) => `${e.type}:${e.id}`) });
        return Promise.resolve();
      },
      increment: () => Promise.reject(new Error('redis down')),
    };
    const settings = { get: () => Promise.resolve(7) };
    const logger = { setContext: () => undefined, warn: jest.fn() };
    const tracker = new AnalyticsTracker(store as never, settings as never, logger as never);
    tracker.searchAppearances([
      { type: 'posts', id: 'p1', tenantId: 't' },
      { type: 'places', id: 'pl1', tenantId: 't' },
      { type: 'stores', id: 's1', tenantId: 't' },
    ]);
    tracker.mapTap({ tenantId: 't', type: 'post', id: 'p1' });
    await tracker.settle();
    expect(calls).toEqual([{ field: 'search_appearances', ids: ['post:p1', 'store:s1'] }]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
