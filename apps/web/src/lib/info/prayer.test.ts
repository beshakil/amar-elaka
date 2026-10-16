import { describe, expect, it } from 'vitest';
import { hijriDate, localDate, nextPrayer, prayerTimes, sehriIftar } from './prayer';

/**
 * Shared vectors with the Dart twin (apps/mobile/test/features/info/prayer_test.dart):
 * Dhaka, 2026-10-16, Karachi method, Hanafi Asr. Reference: the Islamic
 * Foundation Bangladesh timetable, within 3 minutes (published tables
 * round and add their own safety minutes).
 */
const DHAKA = { lat: 23.8103, lng: 90.4125 };
const local = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};
const near = (actual: Date, expected: string) =>
  expect(Math.abs(minutes(local(actual)) - minutes(expected))).toBeLessThanOrEqual(3);

describe('prayer times', () => {
  const t = prayerTimes('2026-10-16', DHAKA.lat, DHAKA.lng, {
    method: 'karachi',
    asrSchool: 'hanafi',
  });

  it('matches the Dhaka timetable', () => {
    near(t.fajr, '04:40');
    near(t.sunrise, '05:54');
    near(t.dhuhr, '11:44');
    near(t.asr, '15:56');
    near(t.maghrib, '17:33');
    near(t.isha, '18:47');
  });

  it('follows the seasons (solstices, the same vectors as the Dart twin)', () => {
    const june = prayerTimes('2026-06-21', DHAKA.lat, DHAKA.lng, {
      method: 'karachi',
      asrSchool: 'hanafi',
    });
    near(june.fajr, '03:43');
    near(june.maghrib, '18:48');
    const dec = prayerTimes('2026-12-21', DHAKA.lat, DHAKA.lng, {
      method: 'karachi',
      asrSchool: 'hanafi',
    });
    near(dec.fajr, '05:15');
    near(dec.maghrib, '17:16');
  });

  it('puts the standard Asr before the Hanafi one', () => {
    const standard = prayerTimes('2026-10-16', DHAKA.lat, DHAKA.lng, {
      method: 'karachi',
      asrSchool: 'standard',
    });
    expect(standard.asr.getTime()).toBeLessThan(t.asr.getTime());
  });

  it('keeps the order of the day', () => {
    const order = [t.fajr, t.sunrise, t.dhuhr, t.asr, t.maghrib, t.isha].map((d) => d.getTime());
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('places Umm al-Qura isha 90 minutes after maghrib', () => {
    const u = prayerTimes('2026-10-16', DHAKA.lat, DHAKA.lng, {
      method: 'umm_al_qura',
      asrSchool: 'standard',
    });
    expect(u.isha.getTime() - u.maghrib.getTime()).toBe(90 * 60_000);
  });

  it('moves sehri and iftar by the caution minutes', () => {
    const s = sehriIftar(t, 3, 2);
    expect(t.fajr.getTime() - s.sehriEnds.getTime()).toBe(3 * 60_000);
    expect(s.iftar.getTime() - t.maghrib.getTime()).toBe(2 * 60_000);
  });
});

describe('hijri date', () => {
  it('places Ramadan 1447 in early 2026', () => {
    expect(hijriDate('2026-03-01', 0)).toEqual({ year: 1447, month: 9, day: 12 });
    expect(hijriDate('2026-10-16', 0)).toEqual({ year: 1448, month: 5, day: 4 });
  });

  it('applies the area’s adjustment', () => {
    const base = hijriDate('2026-03-01', 0);
    const next = hijriDate('2026-03-01', 1);
    expect(next.day === base.day + 1 || next.day === 1).toBe(true);
  });
});

describe('nextPrayer', () => {
  const opts = { method: 'karachi', asrSchool: 'hanafi' } as const;
  const today = prayerTimes('2026-10-16', 23.8103, 90.4125, opts);
  const tomorrow = prayerTimes('2026-10-17', 23.8103, 90.4125, opts);

  it('skips sunrise and rolls over to tomorrow after Isha', () => {
    // 06:30 Dhaka (00:30Z): after sunrise, so Dhuhr is next.
    expect(nextPrayer(today, tomorrow, new Date('2026-10-16T00:30:00Z')).prayer).toBe('dhuhr');
    const late = nextPrayer(today, tomorrow, new Date('2026-10-16T17:00:00Z'));
    expect(late).toEqual({ prayer: 'fajr', at: tomorrow.fajr });
  });

  it('gives the area calendar day', () => {
    expect(localDate(new Date('2026-10-16T19:00:00Z'), 'Asia/Dhaka')).toBe('2026-10-17');
  });
});
