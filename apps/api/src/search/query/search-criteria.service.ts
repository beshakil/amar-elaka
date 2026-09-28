import { Injectable } from '@nestjs/common';
import { parseFieldFilters, toPoisha, type RawFieldFilter } from '../../categories/field-schema';
import type { DatabaseTransaction } from '../../database/database.client';
import { TenantDb } from '../../database/tenant-db';
import { SettingsService } from '../../settings/settings.service';
import type { SearchScope } from '../dto/search.dto';
import {
  SearchAreaNotFoundException,
  SearchCategoryNotFoundException,
  SearchCategoryNotShippableException,
  SearchFiltersNeedFieldsException,
} from '../search.exceptions';
import type { SearchType } from '../search.types';
import type { PriceRange } from './filter-builder';
import type { SearchCriteria } from './search-matcher';
import {
  SearchQueryRepository,
  type ResolvedArea,
  type ResolvedCategory,
} from './search-query.repository';

/** A search as asked for: by a GET /search request or a stored saved search. */
export interface CriteriaInput {
  /** Whose radius settings apply (the request's tenant; for a saved search, any tenant: see radiusKm). */
  tenantId: string;
  type: SearchType;
  q: string;
  scope: SearchScope;
  origin: { lat: number; lng: number };
  /** Kilometres asked for; scope=nearby only, capped at search_max_radius_km. */
  radiusKm: number | undefined;
  category: { slug: string } | { id: string } | null;
  /** One of the request tenant's areas, by URL slug (landing pages); it centres the search. */
  area?: { slug: string } | null;
  filters: readonly RawFieldFilter[] | undefined;
  /** Money strings (two decimals), inclusive / exclusive. */
  priceMin: string | undefined;
  priceMax: string | undefined;
}

export interface ResolvedCriteria {
  criteria: SearchCriteria;
  category: ResolvedCategory | null;
  area: ResolvedArea | null;
}

/**
 * Turns a search as asked for into SearchCriteria, the one meaning both
 * GET /search and saved searches use (ADR 041):
 *
 *  - the category and its active descendants (shippable ones only in the
 *    country scope, which refuses a category that never ships);
 *  - custom-field filters checked against the category's current schema
 *    (parseFieldFilters: an unknown field or a bad value is a 400);
 *  - the feed's scopes: area = search_default_radius_km, nearby = the asked
 *    radius capped at search_max_radius_km, country = no radius;
 *  - the price range in poisha (price is a post column only).
 */
@Injectable()
export class SearchCriteriaService {
  constructor(
    private readonly repo: SearchQueryRepository,
    private readonly settings: SettingsService,
    private readonly tenantDb: TenantDb,
  ) {}

  async resolve(input: CriteriaInput): Promise<ResolvedCriteria> {
    const [defaultRadius, maxRadius] = await Promise.all([
      this.settings.get('search_default_radius_km', input.tenantId),
      this.settings.get('search_max_radius_km'),
    ]);

    const category =
      input.category === null
        ? null
        : ((await this.readOnly((tx) =>
            'slug' in input.category!
              ? this.repo.resolveCategory(tx, input.category.slug)
              : this.repo.resolveCategoryById(tx, input.category!.id),
          )) ?? null);
    if (input.category !== null && category === null) throw new SearchCategoryNotFoundException();

    const area = input.area
      ? ((await this.readOnly((tx) =>
          this.repo.areaBySlug(tx, input.tenantId, input.area!.slug),
        )) ?? null)
      : null;
    if (input.area && area === null) throw new SearchAreaNotFoundException();

    let fieldFilters: SearchCriteria['fieldFilters'] = [];
    if (input.filters && input.filters.length > 0) {
      if (!category?.definition) throw new SearchFiltersNeedFieldsException();
      fieldFilters = parseFieldFilters(category.definition, input.filters);
    }

    let categoryIds = category?.ids ?? null;
    if (input.scope === 'country' && category) {
      if (category.shippableIds.length === 0) throw new SearchCategoryNotShippableException();
      categoryIds = category.shippableIds;
    }

    const radiusKm =
      input.scope === 'country'
        ? null
        : input.scope === 'nearby'
          ? Math.min(input.radiusKm ?? defaultRadius, maxRadius)
          : defaultRadius;
    const price: PriceRange | null =
      input.type !== 'posts' || (input.priceMin === undefined && input.priceMax === undefined)
        ? null
        : {
            min: input.priceMin === undefined ? null : toPoisha(input.priceMin),
            max: input.priceMax === undefined ? null : toPoisha(input.priceMax),
          };

    return {
      category,
      area,
      criteria: {
        type: input.type,
        q: input.q,
        // An area's search is centred on the area itself.
        origin: area?.center ?? input.origin,
        radiusKm,
        shippableOnly: input.scope === 'country' && input.type === 'posts',
        localityId: area?.id ?? null,
        categoryIds,
        fieldFilters,
        price,
      },
    };
  }

  private readOnly<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.tenantDb.transaction(work, { accessMode: 'read only' });
  }
}
