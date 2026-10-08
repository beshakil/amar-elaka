import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import type { TenantDb } from '../database/tenant-db';
import { SearchUnavailableError } from '../search/engine/search-engine.port';
import type { SearchCriteria, SearchMatcher } from '../search/query/search-matcher';
import type { SearchQueryRepository } from '../search/query/search-query.repository';
import type { SettingsService } from '../settings/settings.service';
import { SeoSearchUnavailableException } from './seo.exceptions';
import type { AreaRow, CategoryTreeRow, SeoRepository } from './seo.repository';
import { SeoService } from './seo.service';

const areas: AreaRow[] = [
  {
    id: 'a1',
    slug: 'mirpur-10',
    name_bn: 'মিরপুর ১০',
    name_en: 'Mirpur 10',
    lat: 23.8,
    lng: 90.36,
  },
  { id: 'a2', slug: 'pallabi', name_bn: 'পল্লবী', name_en: 'Pallabi', lat: null, lng: null },
];
const trees: CategoryTreeRow[] = [
  // to-let covers its sub-category too, as a search for it does.
  { slug: 'to-let', name_bn: 'টু-লেট', name_en: 'To-Let', ids: ['c-to-let', 'c-sublet'] },
  { slug: 'mobile-phones', name_bn: 'মোবাইল', name_en: 'Mobiles', ids: ['c-phones'] },
];

function setup(counts: Record<string, number>[] | Error) {
  const asked: SearchCriteria[][] = [];
  const matcher = {
    facetCountsEach: (criteria: SearchCriteria[], attribute: string) => {
      expect(attribute).toBe('category_id');
      asked.push(criteria);
      return counts instanceof Error ? Promise.reject(counts) : Promise.resolve(counts);
    },
  } as unknown as SearchMatcher;
  const context = new TenantContext();
  jest.spyOn(context, 'current').mockReturnValue({ tenantId: 't1', role: 'anon' } as never);
  const service = new SeoService(
    {
      transaction: <T>(work: (tx: DatabaseTransaction) => Promise<T>) =>
        work({} as DatabaseTransaction),
    } as unknown as TenantDb,
    context,
    {
      activeAreas: () => Promise.resolve(areas),
      enabledCategoryTrees: () => Promise.resolve(trees),
    } as unknown as SeoRepository,
    {
      get: (key: string) =>
        Promise.resolve(
          (
            { seo_area_page_min_listings: 5, search_default_radius_km: 10 } as Record<
              string,
              number
            >
          )[key],
        ),
    } as unknown as SettingsService,
    matcher,
    {
      tenantCenter: () => Promise.resolve({ lat: 23.81, lng: 90.41 }),
    } as unknown as SearchQueryRepository,
  );
  return { service, asked };
}

describe('SeoService.categoryAreas', () => {
  it('lists the pairs at the threshold, rolling sub-categories up, most listings first', async () => {
    const { service, asked } = setup([
      { 'c-to-let': 3, 'c-sublet': 2, 'c-phones': 4 },
      { 'c-to-let': 9, 'c-phones': 5 },
    ]);
    expect(await service.categoryAreas()).toEqual({
      minListings: 5,
      items: [
        {
          category: { slug: 'to-let', name: { bn: 'টু-লেট', en: 'To-Let' } },
          area: { slug: 'pallabi', name: { bn: 'পল্লবী', en: 'Pallabi' } },
          count: 9,
        },
        {
          category: { slug: 'to-let', name: { bn: 'টু-লেট', en: 'To-Let' } },
          area: { slug: 'mirpur-10', name: { bn: 'মিরপুর ১০', en: 'Mirpur 10' } },
          count: 5,
        },
        {
          category: { slug: 'mobile-phones', name: { bn: 'মোবাইল', en: 'Mobiles' } },
          area: { slug: 'pallabi', name: { bn: 'পল্লবী', en: 'Pallabi' } },
          count: 5,
        },
      ],
    });
    // The same criteria the landing page searches with: the area's centre (or
    // the tenant's), the area radius, the area filter.
    expect(asked[0]!.map((c) => [c.origin, c.radiusKm, c.localityId])).toEqual([
      [{ lat: 23.8, lng: 90.36 }, 10, 'a1'],
      [{ lat: 23.81, lng: 90.41 }, 10, 'a2'],
    ]);
  });

  it('answers 503 when the engine is down, never an empty list', async () => {
    const { service } = setup(new SearchUnavailableError());
    await expect(service.categoryAreas()).rejects.toThrow(SeoSearchUnavailableException);
  });
});
