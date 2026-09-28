import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SearchCursorInvalidException } from '../search.exceptions';

/**
 * Opaque search cursor (ADR 040). Meilisearch pages by offset, so the cursor
 * is the next offset plus `k`, a digest of everything that decides the
 * result list (query, type, scope, origin, radius, category, filters, price,
 * sort, page size). A cursor from another search is rejected instead of
 * silently paging a different list. Not signed: it only pages public data.
 */

const CURSOR_VERSION = 1;
// settings-exempt: digest length of the query key (hex characters), a format detail
const QUERY_KEY_LENGTH = 16;

const cursorSchema = z
  .object({
    v: z.literal(CURSOR_VERSION),
    k: z.string().length(QUERY_KEY_LENGTH),
    o: z.number().int().positive(),
  })
  .strict();

export function encodeSearchCursor(key: string, offset: number): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, k: key, o: offset }), 'utf8').toString(
    'base64url',
  );
}

/** The offset the cursor points at; throws when it is malformed or from another search. */
export function decodeSearchCursor(raw: string, expectedKey: string): number {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new SearchCursorInvalidException();
  }
  const parsed = cursorSchema.safeParse(json);
  if (!parsed.success || parsed.data.k !== expectedKey) throw new SearchCursorInvalidException();
  return parsed.data.o;
}

/** Canonical digest of a parameter object (key order doesn't matter, undefined = null). */
export function searchDigest(parts: Record<string, unknown>): string {
  const canonical = JSON.stringify(
    Object.keys(parts)
      .sort()
      .map((key) => [key, parts[key] ?? null]),
  );
  return createHash('sha256').update(canonical).digest('hex').slice(0, QUERY_KEY_LENGTH);
}
