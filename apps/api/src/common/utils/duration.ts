const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  y: 365 * 24 * 60 * 60 * 1000,
};

/** Parses a duration string in the shape validated by env.schema.ts's `durationString` (e.g. `15m`, `60d`). */
export function parseDurationMs(input: string): number {
  const match = /^(\d+)(ms|s|m|h|d|y)$/.exec(input);
  if (!match) {
    throw new Error(`Invalid duration string: ${input}`);
  }
  const [, amount, unit] = match;
  return Number(amount) * UNIT_MS[unit!]!;
}
