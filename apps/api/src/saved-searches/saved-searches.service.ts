import { Injectable } from '@nestjs/common';
import { UnauthenticatedException } from '../auth/exceptions/auth.exceptions';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantRequiredException } from '../database/tenant.exceptions';
import { TenantDb } from '../database/tenant-db';
import { FeedService } from '../feed/feed.service';
import { toRawFieldFilters } from '../search/dto/search.dto';
import { SearchCriteriaService } from '../search/query/search-criteria.service';
import { SettingsService } from '../settings/settings.service';
import type {
  CreateSavedSearch,
  NewResults,
  SavedSearch,
  SavedSearchFilters,
  SavedSearchList,
  UpdateSavedSearch,
} from './dto/saved-searches.dto';
import { storedFields, type StoredSavedSearch } from './saved-search-criteria';
import {
  SavedSearchInvalidException,
  SavedSearchLimitReachedException,
  SavedSearchNotFoundException,
} from './saved-searches.exceptions';
import { SavedSearchesRepository, type SavedSearchWrite } from './saved-searches.repository';

/**
 * /saved-searches (Q25, §8.11, ADR 041). A saved search is global to the user
 * (§13.29): purely a place, a radius and what to look for, matched across
 * tenants. Every change is checked by SearchCriteriaService — the same
 * category, field-filter and radius rules as GET /search — so a search that
 * saves is a search the matcher can run.
 *
 * Limits: saved_search_max_active active searches per user (on create and on
 * resume, under a per-user lock); the name length and radius from settings.
 */
@Injectable()
export class SavedSearchesService {
  constructor(
    private readonly repo: SavedSearchesRepository,
    private readonly criteria: SearchCriteriaService,
    private readonly feed: FeedService,
    private readonly settings: SettingsService,
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
  ) {}

  async create(input: CreateSavedSearch): Promise<SavedSearch> {
    const userId = this.requireUser();
    const write = await this.validate({
      name: input.name,
      q: input.q,
      filters: input.filters,
      center: input.center,
      radiusKm: input.radius_km,
      frequency: input.frequency,
    });
    const maxActive = await this.settings.get('saved_search_max_active');
    const id = await this.tenantDb.transaction(async (tx) => {
      await this.repo.lockUser(tx, userId);
      if ((await this.repo.countActive(tx, userId)) >= maxActive) {
        throw new SavedSearchLimitReachedException(maxActive);
      }
      return this.repo.insert(tx, userId, write);
    });
    return this.get(id);
  }

  async list(): Promise<SavedSearchList> {
    const userId = this.requireUser();
    const maxActive = await this.settings.get('saved_search_max_active');
    return this.readOnly(async (tx) => {
      const rows = await this.repo.list(tx, userId);
      const counts = await this.repo.newCounts(
        tx,
        rows.map((r) => r.id),
      );
      const items = rows.map((row) => toSavedSearch(row, counts.get(row.id) ?? 0));
      return {
        items,
        newResultCount: items.reduce((sum, s) => sum + s.newResultCount, 0),
        maxActive,
        activeCount: items.filter((s) => s.active).length,
      };
    });
  }

  async get(id: string): Promise<SavedSearch> {
    const userId = this.requireUser();
    return this.readOnly(async (tx) => {
      const row = await this.own(tx, userId, id);
      const counts = await this.repo.newCounts(tx, [id]);
      return toSavedSearch(row, counts.get(id) ?? 0);
    });
  }

  async update(id: string, patch: UpdateSavedSearch): Promise<SavedSearch> {
    const userId = this.requireUser();
    const maxActive = await this.settings.get('saved_search_max_active');
    await this.tenantDb.transaction(async (tx) => {
      await this.repo.lockUser(tx, userId);
      const current = await this.own(tx, userId, id);
      const write = await this.validate({
        name: patch.name ?? current.name,
        q: patch.q ?? current.query_text ?? '',
        filters: patch.filters ?? storedFilters(current),
        center: patch.center ?? { lat: current.lat, lng: current.lng },
        radiusKm: patch.radius_km ?? current.radius_km,
        frequency: patch.frequency ?? current.alert_frequency_code,
      });
      const wasActive = current.is_active && current.paused_at === null;
      const active = patch.active ?? current.is_active;
      // `active: true` also lifts an auto-pause.
      const resume = patch.active === true && current.paused_at !== null;
      const willBeActive = active && (current.paused_at === null || resume);
      if (
        willBeActive &&
        !wasActive &&
        (await this.repo.countActive(tx, userId, id)) >= maxActive
      ) {
        throw new SavedSearchLimitReachedException(maxActive);
      }
      await this.repo.update(tx, id, { ...write, active, resume });
    });
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const userId = this.requireUser();
    await this.tenantDb.transaction(async (tx) => {
      await this.own(tx, userId, id);
      await this.repo.softDelete(tx, id);
    });
  }

  /**
   * The new results: unseen matches, newest first, as feed cards read in
   * each post's own tenant (so a card shows only what that tenant makes
   * public, and a post gone since is left out). Opening them marks them seen
   * and counts as opening the search (auto-pause).
   */
  async newResults(id: string): Promise<NewResults> {
    const userId = this.requireUser();
    const max = await this.settings.get('saved_search_new_results_max');
    const unseen = await this.readOnly(async (tx) => {
      await this.own(tx, userId, id);
      return this.repo.unseenMatches(tx, id, max);
    });
    const results = await this.feed.cardsFor(
      unseen.map((m) => ({ id: m.post_id, tenant_id: m.post_tenant_id })),
    );
    await this.tenantDb.transaction((tx) =>
      this.repo.markSeen(
        tx,
        id,
        unseen.map((m) => m.id),
      ),
    );
    return { search: await this.get(id), results };
  }

  /**
   * Checks a saved search exactly as GET /search would check the same
   * parameters (SearchCriteriaService), plus the saved-search limits.
   */
  private async validate(input: {
    name: string;
    q: string;
    filters: SavedSearchFilters;
    center: { lat: number; lng: number };
    radiusKm: number;
    frequency: SavedSearchWrite['frequency'];
  }): Promise<SavedSearchWrite> {
    const tenantId = this.context.require().tenantId;
    if (!tenantId) throw new TenantRequiredException();
    const [nameMax, radiusMax] = await Promise.all([
      this.settings.get('saved_search_name_max_length'),
      this.settings.get('search_max_radius_km'),
    ]);
    if ([...input.name].length > nameMax) throw new SavedSearchInvalidException('name', nameMax);
    if (input.radiusKm > radiusMax) throw new SavedSearchInvalidException('radius_km', radiusMax);

    const fields = input.filters.fields ?? {};
    const { category } = await this.criteria.resolve({
      tenantId,
      type: 'posts',
      q: input.q,
      scope: 'nearby',
      origin: input.center,
      radiusKm: input.radiusKm,
      category: input.filters.category ? { slug: input.filters.category } : null,
      filters: Object.keys(fields).length > 0 ? toRawFieldFilters(fields) : undefined,
      priceMin: input.filters.price_min,
      priceMax: input.filters.price_max,
    });
    return {
      name: input.name,
      queryText: input.q === '' ? null : input.q,
      categoryId: category?.id ?? null,
      fields,
      priceMin: input.filters.price_min ?? null,
      priceMax: input.filters.price_max ?? null,
      center: input.center,
      radiusKm: input.radiusKm,
      frequency: input.frequency,
    };
  }

  private async own(tx: DatabaseTransaction, userId: string, id: string) {
    const [row] = await this.repo.list(tx, userId, id);
    if (!row) throw new SavedSearchNotFoundException();
    return row;
  }

  private readOnly<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.tenantDb.transaction(work, { accessMode: 'read only' });
  }

  private requireUser(): string {
    const userId = this.context.current()?.userId;
    if (!userId) throw new UnauthenticatedException();
    return userId;
  }
}

function storedFilters(row: StoredSavedSearch): SavedSearchFilters {
  const fields = storedFields(row);
  return {
    ...(row.category_slug ? { category: row.category_slug } : {}),
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
    ...(row.price_min ? { price_min: row.price_min } : {}),
    ...(row.price_max ? { price_max: row.price_max } : {}),
  };
}

export function toSavedSearch(row: StoredSavedSearch, newResultCount: number): SavedSearch {
  return {
    id: row.id,
    name: row.name,
    q: row.query_text ?? '',
    filters: {
      category: row.category_slug,
      fields: storedFields(row),
      priceMin: row.price_min,
      priceMax: row.price_max,
    },
    center: { lat: row.lat, lng: row.lng },
    radiusKm: row.radius_km,
    frequency: row.alert_frequency_code,
    active: row.is_active && row.paused_at === null,
    pausedAt: row.paused_at?.toISOString() ?? null,
    newResultCount,
    lastAlertedAt: row.last_alerted_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}
