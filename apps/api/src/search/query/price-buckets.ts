/**
 * Price ranges for the filter UI, adapted to the prices actually in the
 * results: a to-let search gets thousands, a vegetables search gets tens,
 * with no per-category configuration. Boundaries are "nice" numbers of taka
 * (1-2-5 × 10ⁿ), so the UI shows ৳0–5,000, ৳5,000–10,000, … ৳20,000+.
 *
 * All values are integer poisha (never floats, CLAUDE.md rule 2). Each range
 * is `min` inclusive, `max` exclusive; the last one is open (`max` null), so
 * the highest price always falls in a range.
 */

export interface PriceBucket {
  min: number;
  /** Exclusive; null on the last (open) bucket. */
  max: number | null;
}

// settings-exempt: currency unit conversion — the smallest step is one taka
const POISHA_PER_TAKA = 100;
// settings-exempt: the 1-2-5 series, a rounding scheme for readable boundaries
const NICE_MULTIPLIERS = [1, 2, 5] as const;
// settings-exempt: decimal base of the series
const BASE = 10;

/** Nice step sizes (poisha), ascending, from the first one ≥ `from`. */
function* niceSteps(from: number): Generator<number> {
  let magnitude = BASE ** Math.floor(Math.log10(from));
  for (;;) {
    for (const m of NICE_MULTIPLIERS) {
      if (m * magnitude >= from) yield m * magnitude;
    }
    magnitude *= BASE;
  }
}

/**
 * At most `count` ranges covering [min, max], using the smallest nice step
 * that fits. One open range when every price is the same; none when
 * `count` is 0 or the bounds are unusable.
 */
export function priceBuckets(min: number, max: number, count: number): PriceBucket[] {
  if (count <= 0 || !Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
    return [];
  }
  if (max === min) return [{ min, max: null }];
  const smallest = Math.max(POISHA_PER_TAKA, Math.ceil((max - min) / count));
  for (const step of niceSteps(smallest)) {
    const start = Math.floor(min / step) * step;
    const needed = Math.floor((max - start) / step) + 1;
    if (needed > count) continue;
    return Array.from({ length: needed }, (_, i) => ({
      min: start + i * step,
      max: i === needed - 1 ? null : start + (i + 1) * step,
    }));
  }
  return [];
}
