import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FeedCursorInvalidException } from './feed.exceptions';

/**
 * Opaque feed cursor (ADR 035). Carries everything that must stay fixed for
 * one scroll so (score, id) is a strict total order across pages:
 *   - `at`: the scoring clock (as_of). Recency and boost windows are measured
 *     at it, never at now(); posts published or bumped later are left out.
 *   - `o`, `r`: the origin (snapped to the cache cell) and resolved radius.
 *   - `p`: the last ranked post, `s`: the last store card, `n`: post cards
 *     shown so far (keeps the store-card rhythm across pages).
 *   - `k`: a digest of scope, category, filters and radius — a cursor from
 *     another query is rejected instead of silently mixing two feeds.
 * Not signed: it only ever narrows a query over public rows.
 */

const CURSOR_VERSION = 1;
// settings-exempt: digest length of the query key (hex characters), a format detail
const QUERY_KEY_LENGTH = 16;
// settings-exempt: latitude/longitude ranges, facts of the coordinate system
const MAX_LAT = 90;
// settings-exempt: see above
const MAX_LNG = 180;

const cursorSchema = z
  .object({
    v: z.literal(CURSOR_VERSION),
    k: z.string().length(QUERY_KEY_LENGTH),
    at: z.number().int().positive(),
    o: z.object({
      lat: z.number().min(-MAX_LAT).max(MAX_LAT),
      lng: z.number().min(-MAX_LNG).max(MAX_LNG),
    }),
    r: z.number().positive().nullable(),
    p: z.object({ s: z.number(), id: z.string().uuid() }),
    s: z.object({ d: z.number().nonnegative(), id: z.string().uuid() }).nullable(),
    n: z.number().int().nonnegative(),
  })
  .strict();

export type FeedCursor = z.infer<typeof cursorSchema>;

export function encodeFeedCursor(cursor: Omit<FeedCursor, 'v'>): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, ...cursor }), 'utf8').toString(
    'base64url',
  );
}

export function decodeFeedCursor(raw: string, expectedKey: string): FeedCursor {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new FeedCursorInvalidException();
  }
  const parsed = cursorSchema.safeParse(json);
  if (!parsed.success || parsed.data.k !== expectedKey) throw new FeedCursorInvalidException();
  return parsed.data;
}

/** Digest of the parameters a cursor is bound to. */
export function feedQueryKey(parts: Record<string, unknown>): string {
  const canonical = JSON.stringify(
    Object.keys(parts)
      .sort()
      .map((key) => [key, parts[key] ?? null]),
  );
  return createHash('sha256').update(canonical).digest('hex').slice(0, QUERY_KEY_LENGTH);
}
