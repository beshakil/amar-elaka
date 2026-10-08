import { SCHEDULE_TIMEZONE } from '../../common/schedule-timezone';

/**
 * Seller analytics count in local days of the platform's schedule zone (ADR
 * 055): the nightly rollup closes a day at the same midnight the dashboard
 * calls "today". Every tenant is in Bangladesh; a tenant in another zone
 * would get its own day boundaries here first.
 */
export const ANALYTICS_TIMEZONE = SCHEDULE_TIMEZONE;

// settings-exempt: calendar arithmetic, not a business number
const MS_PER_DAY = 24 * 60 * 60 * 1_000;
// settings-exempt: the length of an ISO date, "YYYY-MM-DD"
const ISO_DATE_CHARS = 10;

/** "2026-10-09": the local date at `at`. */
export function localDay(at: Date, timeZone: string = ANALYTICS_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(at);
}

/** `day` moved by `days` (negative: earlier). Plain calendar dates, no zone involved. */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * MS_PER_DAY)
    .toISOString()
    .slice(0, ISO_DATE_CHARS);
}

/** Every day from `from` to `to`, both included. */
export function daysFrom(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

export interface PeriodWindow {
  days: number;
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
}

/** The last `days` local days including today, and the same length just before. */
export function periodWindow(today: string, days: number): PeriodWindow {
  const from = addDays(today, -(days - 1));
  return {
    days,
    from,
    to: today,
    previousFrom: addDays(from, -days),
    previousTo: addDays(from, -1),
  };
}
