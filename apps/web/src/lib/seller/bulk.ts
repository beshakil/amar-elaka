import type { StoreProduct } from '../api/schemas';
import { actionsFor } from '../posts/my-posts';

/** What the product table does to several products at once (ADR 057). */
export const BULK_ACTIONS = ['markSold', 'hide', 'unhide', 'repost', 'delete'] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

/**
 * Whether `action` applies to this product: the caller may change it, and
 * its state allows it — the same rule as "my posts" (actionsFor), where a
 * live post's repost is a renewal.
 */
export function bulkEligible(
  product: Pick<StoreProduct, 'status' | 'hidden' | 'canManage'>,
  action: BulkAction,
): boolean {
  if (!product.canManage) return false;
  const allowed = actionsFor({ status: product.status, hiddenByOwner: product.hidden });
  return action === 'repost'
    ? allowed.includes('repost') || allowed.includes('renew')
    : allowed.includes(action);
}

export interface BulkOutcome<T, E> {
  done: T[];
  failed: { item: T; error: E }[];
}

/**
 * Runs the action on each item in turn (one request at a time: the API's
 * per-user locks serialise them anyway), reporting progress; one failure
 * never stops the rest.
 */
export async function runBulk<T, E>(
  items: readonly T[],
  run: (item: T) => Promise<{ ok: true } | { ok: false; error: E }>,
  onProgress: (finished: number) => void,
): Promise<BulkOutcome<T, E>> {
  const outcome: BulkOutcome<T, E> = { done: [], failed: [] };
  for (const [i, item] of items.entries()) {
    const result = await run(item);
    if (result.ok) outcome.done.push(item);
    else outcome.failed.push({ item, error: result.error });
    onProgress(i + 1);
  }
  return outcome;
}
