import type { Sql } from 'postgres';
import { POST_STATUSES, type PostStatus } from '../src/posts/post-state-machine';
import { visibilityOf } from '../src/posts/post-visibility';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * The visibility rules (0049): post_is_listed() for feed, map, search and
 * discovery, post_is_viewable() for the post page. The page's TypeScript
 * check (visibilityOf, on a loaded row) must give the same public answer as
 * the SQL one for every combination, and "listed" must stay a subset of
 * "viewable".
 */

const HOUR_MS = 3_600_000;

interface Combination {
  status: PostStatus;
  deleted: boolean;
  hidden: boolean;
  scrubbed: boolean;
  /** 0050: the post's store is suspended, closed or deleted. */
  storeHidden: boolean;
  expires: 'never' | 'past' | 'future';
}

function* combinations(): Generator<Combination> {
  for (const status of POST_STATUSES) {
    for (const deleted of [false, true]) {
      for (const hidden of [false, true]) {
        for (const scrubbed of [false, true]) {
          for (const storeHidden of [false, true]) {
            for (const expires of ['never', 'past', 'future'] as const) {
              yield { status, deleted, hidden, scrubbed, storeHidden, expires };
            }
          }
        }
      }
    }
  }
}

describe('post visibility: one rule in SQL, the same answer in TypeScript', () => {
  let admin: Sql;
  const now = new Date();

  beforeAll(() => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
  });
  afterAll(() => admin.end());

  async function judge(c: Combination): Promise<{ listed: boolean; viewable: boolean }> {
    const deletedAt = c.deleted ? now : null;
    const scrubbedAt = c.scrubbed ? now : null;
    const expiresAt =
      c.expires === 'never'
        ? null
        : new Date(now.getTime() + (c.expires === 'past' ? -HOUR_MS : HOUR_MS));
    const [row] = await admin<{ listed: boolean; viewable: boolean }[]>`
      select public.post_is_listed(${c.status}, ${deletedAt}::timestamptz, ${scrubbedAt}::timestamptz,
                                   ${c.hidden}, ${c.storeHidden}, ${expiresAt}::timestamptz,
                                   ${now}::timestamptz) as listed,
             public.post_is_viewable(${c.status}, ${deletedAt}::timestamptz, ${c.hidden}) as viewable`;
    return row!;
  }

  it('the post page: SQL and visibilityOf agree for a public viewer, in every combination', async () => {
    const mismatches: Combination[] = [];
    for (const c of combinations()) {
      const { viewable } = await judge(c);
      const ts = visibilityOf(
        { status: c.status, hiddenByOwner: c.hidden, deleted: c.deleted, scrubbed: c.scrubbed },
        'public',
      );
      if (viewable !== (ts !== 'none')) mismatches.push(c);
    }
    expect(mismatches).toEqual([]);
  });

  it('listed: live, not deleted, scrubbed, hidden, store-hidden or past expires_at; always also viewable', async () => {
    for (const c of combinations()) {
      const { listed, viewable } = await judge(c);
      const expected =
        c.status === 'live' &&
        !c.deleted &&
        !c.hidden &&
        !c.scrubbed &&
        !c.storeHidden &&
        c.expires !== 'past';
      expect({ ...c, listed }).toEqual({ ...c, listed: expected });
      if (listed) expect(viewable).toBe(true);
    }
  });

  it('sold stays viewable on its own page but is never listed', async () => {
    const sold = await judge({
      status: 'sold',
      deleted: false,
      hidden: false,
      scrubbed: false,
      storeHidden: false,
      expires: 'never',
    });
    expect(sold).toEqual({ listed: false, viewable: true });
  });
});
