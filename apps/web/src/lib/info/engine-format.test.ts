import { describe, expect, it } from 'vitest';
import type { InfoCard } from '../api/schemas';
import { clock, distanceText, infoHref, infoWhen, moment } from './engine-format';

const card = (over: Partial<InfoCard>): InfoCard => ({
  type: 'notice',
  id: 'n1',
  tenantId: 't1',
  title: { bn: 'নোটিশ', en: null },
  summary: null,
  badges: [],
  startsAt: null,
  endsAt: null,
  updatedAt: null,
  isStale: false,
  distanceMeters: null,
  location: null,
  image: null,
  ...over,
});

const words = {
  window: (a: string, b: string) => `${a}|${b}`,
  lastSeen: (w: string) => `seen ${w}`,
  updated: (d: string) => `updated ${d}`,
};

describe('info engine cards on the web', () => {
  it('tells the time in Bengali, never with English AM/PM', () => {
    // 04:41 and 22:10 in Dhaka (UTC+6).
    expect(clock('2026-10-15T22:41:00Z', 'Asia/Dhaka')).toBe('৪:৪১ ভোর');
    expect(clock('2026-10-16T16:10:00Z', 'Asia/Dhaka')).toBe('১০:১০ রাত্রি');
    expect(moment('2026-10-16T16:10:00Z', 'Asia/Dhaka')).not.toMatch(/AM|PM/);
  });

  it('opens each type on its own page; an outage has none', () => {
    expect(infoHref(card({}))).toBe('/info/notices/n1');
    expect(infoHref(card({ type: 'lost_found' }))).toBe('/info/lost-found/n1');
    expect(infoHref(card({ type: 'transport' }))).toBe('/info/transport/n1');
    expect(infoHref(card({ type: 'gov_service' }))).toBe('/info/gov/n1');
    expect(infoHref(card({ type: 'outage' }))).toBeNull();
    expect(infoHref(card({ type: 'directory', location: { lat: 23.75, lng: 90.37 } }))).toBe(
      '/map?lat=23.75000&lng=90.37000&z=17',
    );
  });

  it('says distances in Bengali numerals', () => {
    const w = { m: (d: string) => `${d} মি`, km: (d: string) => `${d} কিমি` };
    expect(distanceText(820, w)).toBe('৮২০ মি');
    expect(distanceText(1500, w)).toBe('১.৫ কিমি');
    expect(distanceText(null, w)).toBeNull();
  });

  it('gives an outage its window and a guide its update date', () => {
    const outage = infoWhen(
      card({ type: 'outage', startsAt: '2026-10-16T04:00:00Z', endsAt: '2026-10-16T06:00:00Z' }),
      'Asia/Dhaka',
      words,
    );
    expect(outage).toContain('|');
    expect(
      infoWhen(
        card({ type: 'gov_service', updatedAt: '2026-10-01T00:00:00Z' }),
        'Asia/Dhaka',
        words,
      ),
    ).toMatch(/^updated /);
    expect(infoWhen(card({ type: 'gov_service' }), 'Asia/Dhaka', words)).toBeNull();
  });
});
