import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import type { TenantDb } from '../database/tenant-db';
import type { FeedService } from '../feed/feed.service';
import type { SearchCriteriaService } from '../search/query/search-criteria.service';
import type { SettingsService } from '../settings/settings.service';
import { createSavedSearchSchema } from './dto/saved-searches.dto';
import type { StoredSavedSearch } from './saved-search-criteria';
import {
  SavedSearchInvalidException,
  SavedSearchLimitReachedException,
} from './saved-searches.exceptions';
import type { SavedSearchesRepository } from './saved-searches.repository';
import { SavedSearchesService } from './saved-searches.service';

const USER = '0191e3a0-0000-7000-8000-000000000001';
const SETTINGS: Record<string, number> = {
  saved_search_max_active: 2,
  saved_search_name_max_length: 20,
  search_max_radius_km: 50,
  saved_search_new_results_max: 50,
};

function row(over: Partial<StoredSavedSearch> = {}): StoredSavedSearch {
  return {
    id: 's1',
    user_id: USER,
    name: 'Flat',
    query_text: 'flat',
    category_id: null,
    category_slug: null,
    filters: {},
    price_min: null,
    price_max: null,
    lat: 23.8,
    lng: 90.4,
    radius_km: 5,
    alert_frequency_code: 'daily',
    is_active: true,
    paused_at: null,
    last_alerted_at: null,
    last_engaged_at: null,
    notify_day: null,
    notify_count: 0,
    created_at: new Date('2026-09-01T00:00:00Z'),
    ...over,
  };
}

function setup(active: number, existing: StoredSavedSearch = row()) {
  const calls: string[] = [];
  const repo = {
    lockUser: () => {
      calls.push('lock');
      return Promise.resolve();
    },
    countActive: () => Promise.resolve(active),
    insert: () => {
      calls.push('insert');
      return Promise.resolve('s-new');
    },
    update: (_tx: DatabaseTransaction, _id: string, w: { active: boolean; resume: boolean }) => {
      calls.push(`update active=${w.active} resume=${w.resume}`);
      return Promise.resolve();
    },
    list: () => Promise.resolve([existing]),
    newCounts: () => Promise.resolve(new Map()),
  } as unknown as SavedSearchesRepository;
  const resolve = jest.fn().mockResolvedValue({ category: null, criteria: {} });
  const criteria = { resolve } as unknown as SearchCriteriaService;
  const settings = {
    get: (key: string) => Promise.resolve(SETTINGS[key]),
  } as unknown as SettingsService;
  const tenantDb = {
    transaction: <T>(work: (tx: DatabaseTransaction) => Promise<T>) =>
      work({} as DatabaseTransaction),
  } as unknown as TenantDb;
  const context = new TenantContext();
  jest
    .spyOn(context, 'require')
    .mockReturnValue({ tenantId: 't1', userId: USER, role: 'member' } as never);
  jest
    .spyOn(context, 'current')
    .mockReturnValue({ tenantId: 't1', userId: USER, role: 'member' } as never);
  const service = new SavedSearchesService(
    repo,
    criteria,
    {} as FeedService,
    settings,
    tenantDb,
    context,
  );
  return { service, calls, resolve };
}

const create = (over: Record<string, unknown> = {}) =>
  createSavedSearchSchema.parse({
    name: 'Flat in Mirpur',
    q: 'flat',
    center: { lat: 23.8, lng: 90.4 },
    radius_km: 5,
    ...over,
  });

describe('SavedSearchesService limits', () => {
  it('creates while under saved_search_max_active, counting under the per-user lock', async () => {
    const { service, calls, resolve } = setup(1);
    await service.create(
      create({ filters: { category: 'to-let', fields: { bedrooms: { gte: 2 } } } }),
    );
    expect(calls).toEqual(['lock', 'insert']);
    // Checked like GET /search: a nearby search around the centre, its category and filters.
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'nearby',
        radiusKm: 5,
        category: { slug: 'to-let' },
        filters: [{ field: 'bedrooms', op: 'gte', value: '2' }],
      }),
    );
  });

  it('refuses a create at saved_search_max_active', async () => {
    const { service, calls } = setup(2);
    await expect(service.create(create())).rejects.toThrow(SavedSearchLimitReachedException);
    expect(calls).toEqual(['lock']);
  });

  it('refuses resuming a paused search at the limit, allows other changes', async () => {
    const paused = row({ paused_at: new Date('2026-09-20T00:00:00Z') });
    const atLimit = setup(2, paused);
    await expect(atLimit.service.update('s1', { active: true })).rejects.toThrow(
      SavedSearchLimitReachedException,
    );
    await atLimit.service.update('s1', { name: 'Renamed' });
    expect(atLimit.calls).toContain('update active=true resume=false');

    const room = setup(1, paused);
    await room.service.update('s1', { active: true });
    expect(room.calls).toContain('update active=true resume=true');
  });

  it('checks the name length and radius against settings', async () => {
    const { service } = setup(0);
    await expect(service.create(create({ name: 'x'.repeat(21) }))).rejects.toThrow(
      SavedSearchInvalidException,
    );
    await expect(service.create(create({ radius_km: 51 }))).rejects.toThrow(
      SavedSearchInvalidException,
    );
  });

  it('rejects malformed input before any of that', () => {
    for (const bad of [
      { radius_km: 0.2 },
      { frequency: 'hourly' },
      { filters: { fields: { bedrooms: { gte: 2 } } } }, // fields without a category
      { filters: { price_min: '500', price_max: '100' } },
      { center: { lat: 100, lng: 90 } },
      { name: '' },
    ]) {
      expect(createSavedSearchSchema.safeParse({ ...create(), ...bad }).success).toBe(false);
    }
  });
});
