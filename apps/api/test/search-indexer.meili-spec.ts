import { MeiliSearch } from 'meilisearch';
import type { PinoLogger } from 'nestjs-pino';
import { loadDotenv } from '../src/config/load-dotenv';
import type { DatabaseTransaction } from '../src/database/database.client';
import { TenantContext } from '../src/database/tenant-context';
import type { TenantDb } from '../src/database/tenant-db';
import type { PostRow } from '../src/search/documents/document-builder';
import type { LoadedRows, ResyncScope } from '../src/search/documents/search-documents.repository';
import { MeilisearchEngine } from '../src/search/engine/meilisearch-engine';
import { SearchIndexer } from '../src/search/indexing/search-indexer.service';
import { indexUid, SEARCH_TYPES, type SearchType } from '../src/search/search.types';
import type { SettingsService } from '../src/settings/settings.service';

/**
 * SearchIndexer (the worker's write path) against a REAL Meilisearch, with an
 * in-memory stand-in for the SQL repository: sync and removal, the
 * zero-downtime reindex with its catch-up, fan-out resync and locality
 * synonyms. The SQL side is covered by test/search-sync.db-spec.ts.
 */

loadDotenv();

const PREFIX = `test_indexer_${Date.now()}_`;
const HOST = process.env.MEILI_HOST ?? 'http://127.0.0.1:7700';
const KEY = process.env.MEILI_MASTER_KEY ?? '';

interface StoredPost {
  row: PostRow;
  indexable: boolean;
  updatedAt: Date;
  memberId: string;
}

class MemoryRepository {
  posts = new Map<string, StoredPost>();
  synced = new Map<string, number>();
  localities: string[][] = [];
  /** Called between loading a reindex page and swapping: simulates writes during a rebuild. */
  onPageLoaded: (() => void) | null = null;

  loadPosts(_tx: DatabaseTransaction, ids: readonly string[]): Promise<LoadedRows<PostRow>> {
    const found = ids
      .map((id) => this.posts.get(id))
      .filter((p): p is StoredPost => p !== undefined);
    const indexable = found.filter((p) => p.indexable).map((p) => p.row);
    const keep = new Set(indexable.map((r) => r.id));
    return Promise.resolve({ indexable, removed: ids.filter((id) => !keep.has(id)) });
  }
  loadStores = () => Promise.resolve({ indexable: [], removed: [] });
  loadPlaces = () => Promise.resolve({ indexable: [], removed: [] });

  markSynced(_tx: DatabaseTransaction, _type: SearchType, ids: readonly string[]): Promise<void> {
    for (const id of ids) this.synced.set(id, (this.synced.get(id) ?? 0) + 1);
    return Promise.resolve();
  }

  idsAfter(
    _tx: DatabaseTransaction,
    type: SearchType,
    after: string | null,
    limit: number,
    changedSince?: Date,
  ): Promise<string[]> {
    if (type !== 'posts') return Promise.resolve([]);
    const ids = [...this.posts.values()]
      .filter((p) => changedSince === undefined || p.updatedAt >= changedSince)
      .map((p) => p.row.id)
      .filter((id) => after === null || id > after)
      .sort()
      .slice(0, limit);
    if (changedSince === undefined && ids.length > 0) this.onPageLoaded?.();
    return Promise.resolve(ids);
  }

  idsInScope(
    _tx: DatabaseTransaction,
    type: SearchType,
    scope: ResyncScope,
    after: string | null,
  ): Promise<string[]> {
    if (type !== 'posts' || scope.kind !== 'member') return Promise.resolve([]);
    return Promise.resolve(
      [...this.posts.values()]
        .filter((p) => p.memberId === scope.memberId && (after === null || p.row.id > after))
        .map((p) => p.row.id)
        .sort(),
    );
  }

  unsyncedIds = () => Promise.resolve([]);
  localitySynonymGroups = () => Promise.resolve(this.localities);
}

function row(id: string, title: string): PostRow {
  return {
    id,
    tenant_id: 't1',
    title,
    description: null,
    price: null,
    category_id: null,
    category_slug: null,
    category_name_bn: null,
    category_name_en: null,
    locality_id: null,
    area_name_bn: null,
    area_name_en: null,
    lat: null,
    lng: null,
    published_at: 1_790_000_000,
    is_boosted: false,
    cover_thumb_key: null,
    cover_thumbhash: null,
    rating_avg: null,
    json_schema: null,
    ui_schema: null,
    filterable_fields: [],
    searchable_fields: [],
    fields: {},
  };
}

describe('SearchIndexer against a real Meilisearch', () => {
  const engine = new MeilisearchEngine({
    MEILI_HOST: HOST,
    MEILI_MASTER_KEY: KEY,
    MEILI_TIMEOUT_MS: 10_000,
  });
  const client = new MeiliSearch({ host: HOST, apiKey: KEY });
  const repo = new MemoryRepository();
  let indexer: SearchIndexer;
  const posts = indexUid(PREFIX, 'posts');

  const put = (id: string, title: string, indexable = true, memberId = 'm1') =>
    repo.posts.set(id, { row: row(id, title), indexable, updatedAt: new Date(), memberId });
  const hits = async (q: string) =>
    (await engine.search<{ id: string }>({ indexUid: posts, q, limit: 20, offset: 0 })).hits
      .map((h) => h.id)
      .sort();

  beforeAll(async () => {
    const context = new TenantContext();
    const settings = {
      get: (key: string) =>
        Promise.resolve(
          (
            {
              search_typo_one_typo_min_chars: 4,
              search_typo_two_typos_min_chars: 8,
              search_facet_values_max: 100,
              search_max_total_hits: 1000,
            } as Record<string, number>
          )[key],
        ),
    } as unknown as SettingsService;
    indexer = new SearchIndexer(
      engine,
      repo,
      {
        transaction: <T>(work: (tx: DatabaseTransaction) => Promise<T>) =>
          work({} as DatabaseTransaction),
      } as unknown as TenantDb,
      context,
      settings,
      { MEILI_INDEX_PREFIX: PREFIX },
      {
        setContext: () => undefined,
        info: () => undefined,
        warn: () => undefined,
      } as unknown as PinoLogger,
    );
    await indexer.applySettings();
  }, 60_000);

  afterAll(async () => {
    for (const type of SEARCH_TYPES) {
      await engine.deleteIndex(indexUid(PREFIX, type));
      await engine.deleteIndex(`${indexUid(PREFIX, type)}__reindex`);
    }
  }, 60_000);

  it('upserts what is public and removes what is not, marking both synced', async () => {
    put('a', 'ডাক্তার এক');
    put('b', 'ডাক্তার দুই');
    await indexer.syncByIds('posts', ['a', 'b', 'a']);
    expect(await hits('doctor')).toEqual(['a', 'b']);

    put('b', 'ডাক্তার দুই', false); // hidden, deleted, banned, expired …
    repo.posts.delete('a'); // or gone entirely
    const result = await indexer.syncByIds('posts', ['a', 'b']);
    expect(result).toEqual({ upserted: 0, removed: 2 });
    expect(await hits('doctor')).toEqual([]);
    expect(repo.synced.get('b')).toBe(2);
  });

  it('fans a member-wide change out to all their posts', async () => {
    put('m-1', 'বাসা ভাড়া এক', true, 'm-banned');
    put('m-2', 'বাসা ভাড়া দুই', true, 'm-banned');
    await indexer.syncByIds('posts', ['m-1', 'm-2']);
    expect(await hits('basa')).toEqual(['m-1', 'm-2']);

    put('m-1', 'বাসা ভাড়া এক', false, 'm-banned');
    put('m-2', 'বাসা ভাড়া দুই', false, 'm-banned');
    await indexer.resync({ kind: 'member', tenantId: 't1', memberId: 'm-banned' });
    expect(await hits('basa')).toEqual([]);
  });

  it('rebuilds with no downtime, then catches up on writes made during the rebuild', async () => {
    repo.posts.clear();
    put('r-1', 'গরু বিক্রি');
    put('r-2', 'ছাগল বিক্রি');
    put('stale', 'পুরনো'); // in the live index only
    await indexer.syncByIds('posts', ['stale']);
    repo.posts.delete('stale');

    let wroteDuringRebuild = false;
    repo.onPageLoaded = () => {
      if (wroteDuringRebuild) return;
      wroteDuringRebuild = true;
      // Published while the fresh index is being filled, with an id the page
      // cursor has already passed: only the catch-up after the swap can index it.
      put('a-late', 'মুরগি বিক্রি');
    };
    const counts = await indexer.reindex(['posts']);
    repo.onPageLoaded = null;

    expect(counts.posts).toBeGreaterThanOrEqual(2);
    expect(await hits('বিক্রি')).toEqual(['a-late', 'r-1', 'r-2']);
    expect(await hits('পুরনো')).toEqual([]);
    const { results } = await client.getIndexes({ limit: 100 });
    expect(results.map((i) => i.uid)).not.toContain(`${posts}__reindex`);
  });

  it('applies locality names and aliases as synonyms', async () => {
    repo.localities = [['কাজীপাড়া', 'Kazipara', 'kazi para']];
    await indexer.applySettings([{ type: 'posts', uid: posts }]);
    const synonyms = (await client.index(posts).getSynonyms()) as Record<string, string[]>;
    expect(synonyms['kazipara']).toEqual(expect.arrayContaining(['কাজীপাড়া', 'kazi para']));
  });
});
