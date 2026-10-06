import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { SEARCH_ENGINE, type SearchEngine } from '../../search/engine/search-engine.port';
import { SearchMatcher } from '../../search/query/search-matcher';
import type { SearchDocument } from '../../search/search.types';
import type { AreaSearchRow } from '../locations.repository';
import { LocationsService } from '../locations.service';
import type { GeoPoint } from './geo-provider.port';

export type OwnGeoKind = 'landmark' | 'place' | 'store' | 'area';

export interface OwnGeoResult {
  kind: OwnGeoKind;
  label: string;
  labelBn: string | null;
  location: GeoPoint;
  area: string | null;
  city: string | null;
  /** The place's or store's id, or the area's pcode. */
  ref: string | null;
}

type PlaceHit = Pick<
  SearchDocument,
  'id' | 'name_bn' | 'name_en' | '_geo' | 'is_landmark' | 'area_name_bn' | 'area_name_en'
>;

/**
 * Our own data, asked before any paid provider (CLAUDE.md map rules, ADR
 * 044): published places — landmarks first — and active stores from the
 * search index (public documents only, any tenant, radius-based from the user
 * when we know where they are), then administrative areas by name. The index
 * matches Bengali, Banglish and English alike (its transliterations and
 * synonyms, ADR 025); area names match in both scripts. Any source failing
 * just gives fewer results: the others, or the provider, still answer.
 */
@Injectable()
export class OwnGeoLookup {
  constructor(
    private readonly matcher: SearchMatcher,
    @Inject(SEARCH_ENGINE) private readonly engine: SearchEngine,
    private readonly locations: LocationsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(OwnGeoLookup.name);
  }

  async search(
    query: string,
    near: GeoPoint | null,
    radiusKm: number,
    limit: number,
  ): Promise<OwnGeoResult[]> {
    const [places, stores, areas] = await Promise.all([
      this.directory('places', query, near, radiusKm, limit),
      this.directory('stores', query, near, radiusKm, limit),
      this.areas(query, limit),
    ]);
    return [...places, ...stores, ...areas].slice(0, limit);
  }

  private async directory(
    type: 'places' | 'stores',
    query: string,
    near: GeoPoint | null,
    radiusKm: number,
    limit: number,
  ): Promise<OwnGeoResult[]> {
    try {
      const result = await this.engine.search<PlaceHit>({
        indexUid: this.matcher.indexUid(type),
        q: this.matcher.expandQuery(query),
        filter: this.matcher.filters({
          type,
          q: query,
          origin: near ?? { lat: 0, lng: 0 },
          // Without the user's position: no radius (a typed name can be anywhere).
          radiusKm: near ? radiusKm : null,
          shippableOnly: false,
          localityId: null,
          categoryIds: null,
          fieldFilters: [],
          price: null,
        }),
        limit,
        offset: 0,
      });
      return (
        result.hits
          .filter((hit) => hit._geo !== null)
          .map((hit) => ({
            kind:
              type === 'stores'
                ? ('store' as const)
                : hit.is_landmark
                  ? ('landmark' as const)
                  : ('place' as const),
            label: hit.name_en ?? hit.name_bn ?? '',
            labelBn: hit.name_bn,
            location: { lat: hit._geo!.lat, lng: hit._geo!.lng },
            area: hit.area_name_en,
            city: null,
            ref: hit.id,
          }))
          .filter((r) => r.label !== '')
          // Landmarks first; otherwise the engine's relevance order.
          .sort((a, b) => Number(b.kind === 'landmark') - Number(a.kind === 'landmark'))
      );
    } catch (error) {
      this.logger.warn({ err: error, type }, 'directory search failed during geocoding');
      return [];
    }
  }

  private async areas(query: string, limit: number): Promise<OwnGeoResult[]> {
    try {
      return (await this.locations.searchByName(query, limit)).map(areaResult);
    } catch (error) {
      this.logger.warn({ err: error }, 'area search failed during geocoding');
      return [];
    }
  }
}

/** "Trishal, Mymensingh" at the area's centre, in both scripts. */
function areaResult(row: AreaSearchRow): OwnGeoResult {
  const label = row.parent_name_en ? `${row.name_en}, ${row.parent_name_en}` : row.name_en;
  const labelBn = row.name_bn
    ? row.parent_name_bn
      ? `${row.name_bn}, ${row.parent_name_bn}`
      : row.name_bn
    : null;
  return {
    kind: 'area',
    label,
    labelBn,
    location: { lat: row.lat!, lng: row.lng! },
    area: row.name_en,
    city: row.parent_name_en,
    ref: row.cod_pcode,
  };
}
