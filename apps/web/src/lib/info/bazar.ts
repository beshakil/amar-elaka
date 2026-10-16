/**
 * The bazar board's drawing arithmetic (ADR 064), pure for unit tests.
 * Money arrives as numeric(12,2) strings and is compared in poisha, never
 * as floats.
 */

export interface TrendDay {
  date: string;
  min: string;
  max: string;
}

/** Items by a key, in first-seen order (the board keeps the API's order). */
export function groupBy<T>(items: readonly T[], key: (item: T) => string): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  return [...groups];
}

/** "45.5" → 4550. */
export function toPoisha(amount: string): number {
  const [whole = '0', fraction = ''] = amount.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));
}

/**
 * The trend as SVG polyline point lists — one per run of days with a price,
 * so a missing day breaks the line instead of inventing a value.
 */
export function sparklineSegments(
  trend: readonly (TrendDay | null)[],
  width: number,
  height: number,
): string[] {
  const mids = trend.map((d) => (d ? toPoisha(d.min) + toPoisha(d.max) : null));
  const known = mids.filter((m): m is number => m !== null);
  if (known.length < 2) return [];
  const lo = Math.min(...known);
  const span = Math.max(...known) - lo || 1;
  const step = trend.length > 1 ? width / (trend.length - 1) : 0;
  const segments: string[] = [];
  let current: string[] = [];
  mids.forEach((m, i) => {
    if (m === null) {
      if (current.length > 1) segments.push(current.join(' '));
      current = [];
      return;
    }
    const y = height - ((m - lo) / span) * height;
    current.push(`${(i * step).toFixed(1)},${y.toFixed(1)}`);
  });
  if (current.length > 1) segments.push(current.join(' '));
  return segments;
}
