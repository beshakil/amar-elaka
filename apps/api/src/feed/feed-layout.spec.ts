import { layoutFeedPage, storeSlotsFor } from './feed-layout';

const posts = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => `p${from + i}`);

describe('feed layout', () => {
  it('puts a store card after every N posts', () => {
    const { items, storesUsed } = layoutFeedPage({
      posts: posts(1, 7),
      stores: ['s1', 's2'],
      postsBefore: 0,
      storeInterval: 3,
      info: [],
    });
    expect(items).toEqual(['p1', 'p2', 'p3', 's1', 'p4', 'p5', 'p6', 's2', 'p7']);
    expect(storesUsed).toBe(2);
  });

  it('keeps the rhythm across pages', () => {
    // Page 1 showed 4 posts; with every 3, the next store follows post 6.
    expect(storeSlotsFor(4, 4, 3)).toBe(1);
    const { items } = layoutFeedPage({
      posts: posts(5, 4),
      stores: ['s2'],
      postsBefore: 4,
      storeInterval: 3,
      info: [],
    });
    expect(items).toEqual(['p5', 'p6', 's2', 'p7', 'p8']);
  });

  it('skips the store slot when no store is left', () => {
    const { items, storesUsed } = layoutFeedPage({
      posts: posts(1, 4),
      stores: [],
      postsBefore: 0,
      storeInterval: 2,
      info: [],
    });
    expect(items).toEqual(posts(1, 4));
    expect(storesUsed).toBe(0);
  });

  it('turns store cards off with an interval of 0', () => {
    expect(storeSlotsFor(0, 20, 0)).toBe(0);
    expect(
      layoutFeedPage({
        posts: posts(1, 3),
        stores: ['s1'],
        postsBefore: 0,
        storeInterval: 0,
        info: [],
      }).items,
    ).toEqual(posts(1, 3));
  });

  it('places info cards at their 1-based slots of the final page', () => {
    const { items } = layoutFeedPage({
      posts: posts(1, 4),
      stores: ['s1'],
      postsBefore: 0,
      storeInterval: 2,
      info: [
        { position: 4, cards: ['bazar'] },
        { position: 1, cards: ['emergency'] },
        { position: 0, cards: ['off'] },
        { position: 50, cards: ['landmark1', 'landmark2'] },
      ],
    });
    expect(items).toEqual([
      'emergency',
      'p1',
      'p2',
      'bazar',
      's1',
      'p3',
      'p4',
      'landmark1',
      'landmark2',
    ]);
  });
});
