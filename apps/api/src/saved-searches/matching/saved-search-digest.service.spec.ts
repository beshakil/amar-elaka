import { dhakaWeekday, digestDue } from './saved-search-digest.service';

describe('weekly saved-search digest timing (ADR 059)', () => {
  it('reads the weekday in Asia/Dhaka', () => {
    // Thursday 20:00 UTC is already Friday 02:00 in Dhaka.
    expect(dhakaWeekday(new Date('2026-10-08T20:00:00Z'))).toBe(5);
    expect(dhakaWeekday(new Date('2026-10-11T06:00:00Z'))).toBe(7);
  });

  it('is due on the weekday from the hour, not before and not on other days', () => {
    const friday = (utcHour: number) => new Date(Date.UTC(2026, 9, 9, utcHour));
    expect(digestDue(friday(3), 5, 10)).toBe(false); // 09:00 Dhaka
    expect(digestDue(friday(4), 5, 10)).toBe(true); // 10:00
    expect(digestDue(friday(15), 5, 10)).toBe(true); // 21:00, a run that missed 10:00
    expect(digestDue(new Date('2026-10-10T04:00:00Z'), 5, 10)).toBe(false); // Saturday
  });
});
