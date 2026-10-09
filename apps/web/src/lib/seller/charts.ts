/**
 * The seller dashboard's charts as plain SVG geometry (ADR 057: no chart
 * library). Pure functions, so they're unit-tested and render on the server.
 */

/** The smallest 1·2·5×10ⁿ at or above `max` — a round top for the axis; 1 for an empty series. */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5, 10]) {
    if (step * magnitude >= max) return step * magnitude;
  }
  return 10 * magnitude;
}

export interface Plot {
  width: number;
  height: number;
  /** The value at the top of the plot. */
  top: number;
}

/** x of the i-th of n points, spread across the width (a single point sits in the middle). */
export function xAt(i: number, n: number, plot: Plot): number {
  return n <= 1 ? plot.width / 2 : (i / (n - 1)) * plot.width;
}

export function yAt(value: number, plot: Plot): number {
  return plot.height - (Math.max(0, value) / plot.top) * plot.height;
}

const round = (n: number) => Math.round(n * 10) / 10;

/** An SVG path through the values. */
export function linePath(values: readonly number[], plot: Plot): string {
  return values
    .map(
      (v, i) =>
        `${i === 0 ? 'M' : 'L'}${round(xAt(i, values.length, plot))},${round(yAt(v, plot))}`,
    )
    .join(' ');
}

/** The same line closed down to the baseline, for the shaded area under it. */
export function areaPath(values: readonly number[], plot: Plot): string {
  if (values.length === 0) return '';
  const last = round(xAt(values.length - 1, values.length, plot));
  const first = round(xAt(0, values.length, plot));
  return `${linePath(values, plot)} L${last},${plot.height} L${first},${plot.height} Z`;
}

/** Which of n daily labels to print so they don't collide: about `wanted` of them, always the last. */
export function labelIndexes(n: number, wanted: number): number[] {
  if (n <= wanted) return Array.from({ length: n }, (_, i) => i);
  const step = Math.ceil(n / wanted);
  const picked = new Set<number>();
  for (let i = n - 1; i >= 0; i -= step) picked.add(i);
  return [...picked].sort((a, b) => a - b);
}

/** The API's trend (a percent change, one decimal) as a whole percent; null when there's nothing to compare with. */
export function trendPercent(trend: number | null): number | null {
  return trend === null || !Number.isFinite(trend) ? null : Math.round(trend);
}
