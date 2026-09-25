import { backoffSeconds, planEvents } from './search-outbox.relay';

const event = (over: Partial<Parameters<typeof planEvents>[0][number]>) => ({
  id: 'e',
  aggregate_table: 'posts',
  aggregate_id: 'p1',
  event_type: 'search.sync',
  payload: {},
  attempts: 1,
  ...over,
});

describe('planEvents', () => {
  it('deduplicates syncs per type and scopes, and notes settings changes', () => {
    const cat = '0191e3a0-0000-7000-8000-000000000001';
    const plan = planEvents([
      event({ id: '1', aggregate_id: 'p1' }),
      event({ id: '2', aggregate_id: 'p1' }),
      event({ id: '3', aggregate_table: 'stores', aggregate_id: 's1' }),
      event({
        id: '4',
        event_type: 'search.resync',
        payload: { scope: 'category', category_id: cat },
      }),
      event({
        id: '5',
        event_type: 'search.resync',
        payload: { scope: 'category', category_id: cat },
      }),
      event({ id: '6', event_type: 'search.settings', aggregate_table: 'localities' }),
    ]);
    expect(plan).toEqual({
      sync: { posts: ['p1'], stores: ['s1'], places: [] },
      scopes: [{ kind: 'category', categoryId: cat }],
      applySettings: true,
      ignored: [],
    });
  });

  it('ignores (and does not retry forever) events it cannot read', () => {
    const plan = planEvents([
      event({ id: 'bad-scope', event_type: 'search.resync', payload: { scope: 'nope' } }),
      event({ id: 'bad-table', aggregate_table: 'users' }),
      event({ id: 'other', event_type: 'search.unknown' }),
    ]);
    expect(plan.ignored).toEqual(['bad-scope', 'bad-table', 'other']);
  });
});

describe('backoffSeconds', () => {
  it('doubles from 2s and is capped at 10 minutes', () => {
    expect([1, 2, 3, 4].map(backoffSeconds)).toEqual([2, 4, 8, 16]);
    expect(backoffSeconds(30)).toBe(600);
  });
});
