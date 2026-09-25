import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import type { DatabaseTransaction } from '../../database/database.client';
import { TenantContext } from '../../database/tenant-context';
import { TenantDb } from '../../database/tenant-db';
import { SettingsService } from '../../settings/settings.service';
import { postDocument, placeDocument, storeDocument } from '../documents/document-builder';
import {
  SearchDocumentsRepository,
  type ResyncScope,
} from '../documents/search-documents.repository';
import { SEARCH_ENGINE, type SearchEngine } from '../engine/search-engine.port';
import { buildIndexSettings } from '../index-settings';
import { indexUid, SEARCH_TYPES, type SearchDocument, type SearchType } from '../search.types';
import { SYNONYM_LINES } from '../synonyms/search-synonyms.generated';
import { toMeilisearchSynonyms } from '../synonyms/synonym-dictionary';
import { SearchTerms } from '../text/search-terms';

// settings-exempt: work-batch size for indexing (throughput tuning), not a business rule
export const INDEX_BATCH = 500;
// settings-exempt: the outbox's own window for fresh changes; the sweeper leaves them alone
const SWEEP_GRACE_SECONDS = 300;
const REINDEX_SUFFIX = '__reindex';

export interface SyncResult {
  upserted: number;
  removed: number;
}

/**
 * Everything that writes to the search indexes. Only the worker and the
 * reindex command use it — never an HTTP request (ADR 025): if Meilisearch
 * is down, writes wait in the outbox and the app carries on.
 *
 * Every sync reloads the row's *current* state and upserts or removes it,
 * so events are idempotent and their order doesn't matter.
 */
@Injectable()
export class SearchIndexer {
  private readonly terms = new SearchTerms(SYNONYM_LINES);
  private readonly prefix: string;

  constructor(
    @Inject(SEARCH_ENGINE) private readonly engine: SearchEngine,
    private readonly repo: SearchDocumentsRepository,
    private readonly tenantDb: TenantDb,
    private readonly tenantContext: TenantContext,
    private readonly settings: SettingsService,
    @Inject(APP_CONFIG) env: Pick<Env, 'MEILI_INDEX_PREFIX'>,
    private readonly logger: PinoLogger,
  ) {
    this.prefix = env.MEILI_INDEX_PREFIX;
    this.logger.setContext(SearchIndexer.name);
  }

  uid(type: SearchType): string {
    return indexUid(this.prefix, type);
  }

  /** Re-reads the rows and brings the index in line: upsert what's public, remove the rest. */
  async syncByIds(
    type: SearchType,
    ids: readonly string[],
    target = this.uid(type),
  ): Promise<SyncResult> {
    const unique = [...new Set(ids)];
    let upserted = 0;
    let removed = 0;
    for (let i = 0; i < unique.length; i += INDEX_BATCH) {
      const batch = unique.slice(i, i + INDEX_BATCH);
      const { documents, removedIds } = await this.asSystem((tx) => this.load(tx, type, batch));
      await this.engine.upsertDocuments(target, documents);
      await this.engine.deleteDocuments(target, removedIds);
      await this.asSystem((tx) => this.repo.markSynced(tx, type, batch));
      upserted += documents.length;
      removed += removedIds.length;
    }
    return { upserted, removed };
  }

  /** Re-syncs every document a wide change touches, page by page. */
  async resync(scope: ResyncScope): Promise<SyncResult> {
    const total: SyncResult = { upserted: 0, removed: 0 };
    for (const type of SEARCH_TYPES) {
      let after: string | null = null;
      for (;;) {
        const ids = await this.asSystem((tx) =>
          this.repo.idsInScope(tx, type, scope, after, INDEX_BATCH),
        );
        if (ids.length === 0) break;
        const result = await this.syncByIds(type, ids);
        total.upserted += result.upserted;
        total.removed += result.removed;
        after = ids.at(-1)!;
        if (ids.length < INDEX_BATCH) break;
      }
    }
    return total;
  }

  /**
   * Creates the indexes if needed and applies settings: ranking, filters,
   * typo tolerance, and synonyms from the dictionary plus locality aliases.
   * Idempotent; the worker runs it on start and when localities change.
   */
  async applySettings(targets: readonly { type: SearchType; uid: string }[] = this.liveTargets()) {
    const [localityGroups, oneTypo, twoTypos, facetValuesMax, maxTotalHits] = await Promise.all([
      this.asSystem((tx) => this.repo.localitySynonymGroups(tx)),
      this.settings.get('search_typo_one_typo_min_chars'),
      this.settings.get('search_typo_two_typos_min_chars'),
      this.settings.get('search_facet_values_max'),
      this.settings.get('search_max_total_hits'),
    ]);
    const settings = buildIndexSettings(toMeilisearchSynonyms(SYNONYM_LINES, localityGroups), {
      oneTypoMinChars: oneTypo,
      twoTyposMinChars: twoTypos,
      facetValuesMax,
      maxTotalHits,
    });
    for (const { uid } of targets) {
      await this.engine.ensureIndex(uid);
      await this.engine.updateSettings(uid, settings);
    }
  }

  /**
   * Full rebuild with no downtime: fill a fresh index while search keeps
   * serving the old one, swap them atomically, drop the old, then re-sync
   * whatever changed during the build (the outbox wrote those changes to the
   * old index).
   */
  async reindex(types: readonly SearchType[] = SEARCH_TYPES): Promise<Record<SearchType, number>> {
    const counts = { posts: 0, stores: 0, places: 0 };
    for (const type of types) {
      const live = this.uid(type);
      const fresh = `${live}${REINDEX_SUFFIX}`;
      const startedAt = new Date();
      await this.engine.deleteIndex(fresh);
      await this.applySettings([{ type, uid: fresh }]);

      let after: string | null = null;
      for (;;) {
        const ids = await this.asSystem((tx) => this.repo.idsAfter(tx, type, after, INDEX_BATCH));
        if (ids.length === 0) break;
        counts[type] += (await this.syncByIds(type, ids, fresh)).upserted;
        after = ids.at(-1)!;
        if (ids.length < INDEX_BATCH) break;
      }

      await this.engine.ensureIndex(live);
      await this.engine.swapIndexes(live, fresh);
      await this.engine.deleteIndex(fresh);
      await this.catchUp(type, startedAt);
      this.logger.info({ type, documents: counts[type] }, 'search index rebuilt');
    }
    return counts;
  }

  /** The safety net for events that never arrived. */
  async sweep(): Promise<number> {
    let synced = 0;
    for (const type of SEARCH_TYPES) {
      const ids = await this.asSystem((tx) =>
        this.repo.unsyncedIds(tx, type, SWEEP_GRACE_SECONDS, INDEX_BATCH),
      );
      if (ids.length === 0) continue;
      const result = await this.syncByIds(type, ids);
      synced += result.upserted + result.removed;
    }
    if (synced > 0) this.logger.warn({ synced }, 'search sweeper re-synced rows the outbox missed');
    return synced;
  }

  private async catchUp(type: SearchType, since: Date): Promise<void> {
    let after: string | null = null;
    for (;;) {
      const ids = await this.asSystem((tx) =>
        this.repo.idsAfter(tx, type, after, INDEX_BATCH, since),
      );
      if (ids.length === 0) return;
      await this.syncByIds(type, ids);
      after = ids.at(-1)!;
      if (ids.length < INDEX_BATCH) return;
    }
  }

  private async load(
    tx: DatabaseTransaction,
    type: SearchType,
    ids: readonly string[],
  ): Promise<{ documents: SearchDocument[]; removedIds: string[] }> {
    switch (type) {
      case 'posts': {
        const { indexable, removed } = await this.repo.loadPosts(tx, ids);
        return {
          documents: indexable.map((r) => postDocument(r, this.terms)),
          removedIds: removed,
        };
      }
      case 'stores': {
        const { indexable, removed } = await this.repo.loadStores(tx, ids);
        return {
          documents: indexable.map((r) => storeDocument(r, this.terms)),
          removedIds: removed,
        };
      }
      case 'places': {
        const { indexable, removed } = await this.repo.loadPlaces(tx, ids);
        return {
          documents: indexable.map((r) => placeDocument(r, this.terms)),
          removedIds: removed,
        };
      }
    }
  }

  private liveTargets() {
    return SEARCH_TYPES.map((type) => ({ type, uid: this.uid(type) }));
  }

  private asSystem<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.tenantContext.run({ role: 'system' }, () => this.tenantDb.transaction(work));
  }
}
