import { createHmac } from 'node:crypto';
import { viewerKey, type ViewerSignals } from '../../engagement/viewer-key';

/**
 * search_queries.searcher_hash: who searched, only well enough to count
 * distinct searchers for trending (so one person can't make a query trend).
 * Keyed with a server secret like every viewer key, and salted with the UTC
 * day, so it changes daily and can't follow an anonymous person across days
 * or be turned back into a user id or an IP.
 */
export function searcherHash(secret: string, signals: ViewerSignals, at: Date): string {
  const day = at.toISOString().slice(0, 'yyyy-mm-dd'.length);
  return createHmac('sha256', secret)
    .update(`search|${day}|${viewerKey(secret, signals)}`)
    .digest('hex');
}
