import { z } from 'zod';

/** What is_open_at() (0044, ADR 049) answers; the single source of every open/closed label. */
export const OPEN_STATES = ['open', 'closes_soon', 'opens_soon', 'closed', 'unknown'] as const;
export type OpenStateCode = (typeof OPEN_STATES)[number];

/** States that count as "open now" (the open_now filters). */
export const OPEN_NOW_STATES: readonly OpenStateCode[] = ['open', 'closes_soon'];

/**
 * An entity's open state. `changesAt` is when it next opens (closed,
 * opens_soon) or closes (open, closes_soon) — "৯:৩০-এ খুলবে" — or null when
 * nothing is scheduled within hours_lookahead_days; always null for unknown.
 */
export const openStateSchema = z.object({
  state: z.enum(OPEN_STATES),
  changesAt: z.string().nullable(),
});
export type OpenState = z.infer<typeof openStateSchema>;

export function toOpenState(state: string | null, changesAt: Date | null): OpenState | null {
  if (state === null) return null;
  const code = (OPEN_STATES as readonly string[]).includes(state)
    ? (state as OpenStateCode)
    : 'unknown';
  return { state: code, changesAt: changesAt?.toISOString() ?? null };
}
