import { dhakaTime, notificationDue, type NotifyState } from './notification-policy';

// 2026-09-28 10:00 in Dhaka (UTC+6) is 04:00 UTC.
const TEN_AM = new Date('2026-09-28T04:00:00Z');
const EIGHT_AM = new Date('2026-09-28T02:00:00Z');
const YESTERDAY = new Date('2026-09-27T05:00:00Z');
const LIMITS = { perDay: 2, digestHour: 9 };

const state = (over: Partial<NotifyState>): NotifyState => ({
  alert_frequency_code: 'instant',
  last_alerted_at: null,
  notify_day: null,
  notify_count: 0,
  ...over,
});

describe('dhakaTime', () => {
  it('uses the Asia/Dhaka calendar day and hour', () => {
    expect(dhakaTime(TEN_AM)).toEqual({ day: '2026-09-28', hour: 10 });
    // 23:30 UTC is already the next day in Dhaka.
    expect(dhakaTime(new Date('2026-09-27T23:30:00Z'))).toEqual({ day: '2026-09-28', hour: 5 });
  });
});

describe('notificationDue', () => {
  it('never for "off" (the matches still show as new results)', () => {
    expect(notificationDue(state({ alert_frequency_code: 'off' }), TEN_AM, LIMITS)).toBe(false);
  });

  it('instant: until the per-day cap, which resets on a new Dhaka day', () => {
    expect(notificationDue(state({}), TEN_AM, LIMITS)).toBe(true);
    expect(
      notificationDue(state({ notify_day: '2026-09-28', notify_count: 1 }), TEN_AM, LIMITS),
    ).toBe(true);
    expect(
      notificationDue(state({ notify_day: '2026-09-28', notify_count: 2 }), TEN_AM, LIMITS),
    ).toBe(false);
    expect(
      notificationDue(state({ notify_day: '2026-09-27', notify_count: 9 }), TEN_AM, LIMITS),
    ).toBe(true);
    expect(notificationDue(state({}), TEN_AM, { ...LIMITS, perDay: 0 })).toBe(false);
  });

  it('daily: once a day, from the digest hour', () => {
    const daily = (over: Partial<NotifyState> = {}) =>
      state({ alert_frequency_code: 'daily', ...over });
    expect(notificationDue(daily(), EIGHT_AM, LIMITS)).toBe(false);
    expect(notificationDue(daily(), TEN_AM, LIMITS)).toBe(true);
    expect(notificationDue(daily({ last_alerted_at: YESTERDAY }), TEN_AM, LIMITS)).toBe(true);
    expect(
      notificationDue(daily({ last_alerted_at: new Date('2026-09-28T03:30:00Z') }), TEN_AM, LIMITS),
    ).toBe(false);
  });
});
