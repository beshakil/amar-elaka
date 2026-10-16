/**
 * The bazar board's arithmetic (ADR 064), kept pure so it is tested alone.
 * Prices are numeric(12,2) strings; they are compared in poisha (integers),
 * never as floats.
 */

export interface DayPrice {
  /** YYYY-MM-DD in the area's zone. */
  date: string;
  min: string;
  max: string;
}

export type Direction = 'up' | 'down' | 'same';

// settings-exempt: currency arithmetic — 100 poisha to a taka, two decimals
const POISHA_PER_TAKA = 100;
// settings-exempt: see above
const FRACTION_DIGITS = 2;
// settings-exempt: length of YYYY-MM-DD
const ISO_DATE_LENGTH = 10;

/** "45.5" → 4550 poisha. */
export function toPoisha(amount: string): number {
  const [whole, fraction = ''] = amount.split('.');
  return (
    Number(whole) * POISHA_PER_TAKA +
    Number(fraction.padEnd(FRACTION_DIGITS, '0').slice(0, FRACTION_DIGITS))
  );
}

/** Twice the mid-price, in poisha: min + max, so no halving and no rounding. */
function midTwice(p: { min: string; max: string }): number {
  return toPoisha(p.min) + toPoisha(p.max);
}

/** Today's mid-price against yesterday's; null unless both days have one. */
export function directionOf(
  today: { min: string; max: string } | null,
  yesterday: { min: string; max: string } | null,
): Direction | null {
  if (!today || !yesterday) return null;
  const diff = midTwice(today) - midTwice(yesterday);
  return diff > 0 ? 'up' : diff < 0 ? 'down' : 'same';
}

/** A calendar date (YYYY-MM-DD) moved by whole days. */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, ISO_DATE_LENGTH);
}

/** `days` dates ending at `today` (inclusive), oldest first. */
export function trendDates(today: string, days: number): string[] {
  return Array.from({ length: days }, (_, i) => shiftDate(today, i - (days - 1)));
}

/** The day before `date` (YYYY-MM-DD). */
export function previousDate(date: string): string {
  return shiftDate(date, -1);
}

/** One slot per date, null where nothing was entered. */
export function fillTrend(
  dates: readonly string[],
  prices: readonly DayPrice[],
): (DayPrice | null)[] {
  const byDate = new Map(prices.map((p) => [p.date, p]));
  return dates.map((d) => byDate.get(d) ?? null);
}
