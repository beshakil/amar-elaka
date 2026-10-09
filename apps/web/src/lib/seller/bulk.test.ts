import { describe, expect, it } from 'vitest';
import { bulkEligible, runBulk } from './bulk';

const product = (
  status: 'live' | 'expired' | 'sold' | 'draft',
  extra: { hidden?: boolean; canManage?: boolean } = {},
) => ({
  status,
  hidden: extra.hidden ?? false,
  canManage: extra.canManage ?? true,
});

describe('bulk actions', () => {
  it('offers each action only where the post’s state allows it, and only to whoever may change it', () => {
    expect(bulkEligible(product('live'), 'markSold')).toBe(true);
    expect(bulkEligible(product('expired'), 'markSold')).toBe(false);
    expect(bulkEligible(product('live'), 'repost')).toBe(true); // a renewal
    expect(bulkEligible(product('expired'), 'repost')).toBe(true);
    expect(bulkEligible(product('sold'), 'delete')).toBe(false); // sales history
    expect(bulkEligible(product('live', { hidden: true }), 'unhide')).toBe(true);
    expect(bulkEligible(product('live', { hidden: true }), 'hide')).toBe(false);
    expect(bulkEligible(product('live', { canManage: false }), 'hide')).toBe(false);
  });

  it('runs one at a time, keeps going past a failure and says which failed', async () => {
    const order: string[] = [];
    const progress: number[] = [];
    const outcome = await runBulk(
      ['a', 'b', 'c'],
      (item) => {
        order.push(item);
        return Promise.resolve(
          item === 'b' ? { ok: false as const, error: 'POST_NOT_EDITABLE' } : { ok: true as const },
        );
      },
      (n) => progress.push(n),
    );
    expect(order).toEqual(['a', 'b', 'c']);
    expect(progress).toEqual([1, 2, 3]);
    expect(outcome).toEqual({
      done: ['a', 'c'],
      failed: [{ item: 'b', error: 'POST_NOT_EDITABLE' }],
    });
  });
});
