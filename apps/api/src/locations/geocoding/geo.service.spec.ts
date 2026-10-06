import type { PinoLogger } from 'nestjs-pino';
import type { KeyValueCache } from '../../cache/cache.service';
import type { TenantContext } from '../../database/tenant-context';
import type { SettingsService } from '../../settings/settings.service';
import type { LocationArea } from '../dto/locations.dto';
import type { LocationsService } from '../locations.service';
import type { GeoBudgetAlerts } from './geo-budget-alerts';
import type { GeoBudgetStore, Reservation } from './geo-budget.store';
import type { GeoCallEntry, GeoCallLog } from './geo-call-log';
import { GeoRateLimitedException } from './geo.exceptions';
import { GeoProviderError } from './geo-provider.port';
import { dhakaDay, GeoService, normalizeQuery, roundPoint } from './geo.service';
import type { OwnGeoLookup, OwnGeoResult } from './own-geo-lookup';
import { FakeProvider } from './providers/fake.provider';
import { NullProvider } from './providers/null.provider';

const SETTINGS: Record<string, unknown> = {
  geo_provider: 'fake',
  geocode_autocomplete_min_chars: 3,
  geocode_results_max: 5,
  geo_own_results_min: 2,
  geo_own_radius_km: 30,
  geo_autocomplete_per_client_per_minute: 100,
  barikoi_daily_call_budget: 10,
  barikoi_budget_warn_pct: 80,
  barikoi_cost_autocomplete: 1,
  barikoi_cost_reverse_base: 1,
  barikoi_cost_reverse_per_field: 1,
  barikoi_cost_rupantor: 2,
  barikoi_cost_route: 2,
  geo_cache_ttl_hours: 24,
  reverse_geocode_cache_precision: 7,
  geo_reverse_fields_post_location: ['bangla'],
  geo_reverse_fields_store_setup: ['post_code', 'bangla'],
  geo_reverse_fields_place_marking: ['bangla'],
  geo_breaker_cooldown_seconds: 60,
  route_point_decimals: 4,
  route_requests_per_client_per_hour: 2,
};

class MemoryCache implements KeyValueCache {
  store = new Map<string, { value: unknown; ttl: number }>();
  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.store.get(key)?.value as T | undefined);
  }
  set<T>(key: string, value: T, ttl: number): Promise<void> {
    this.store.set(key, { value, ttl });
    return Promise.resolve();
  }
  del = () => Promise.resolve();
  remember = <T>(_k: string, _t: number, load: () => Promise<T>) => load();
}

/** Redis's behaviour, in memory; `down` makes every call answer null (unreachable). */
class MemoryBudget implements GeoBudgetStore {
  used = new Map<string, number>();
  hits = new Map<string, number>();
  flags = new Set<string>();
  down = false;
  reserve(key: string, cost: number, budget: number): Promise<Reservation | null> {
    if (this.down) return Promise.resolve(null);
    const used = this.used.get(key) ?? 0;
    if (used + cost > budget) return Promise.resolve({ ok: false });
    this.used.set(key, used + cost);
    return Promise.resolve({ ok: true, total: used + cost });
  }
  release(key: string, cost: number) {
    this.used.set(key, (this.used.get(key) ?? 0) - cost);
    return Promise.resolve();
  }
  hit(key: string, limit: number) {
    if (this.down) return Promise.resolve(null);
    const n = (this.hits.get(key) ?? 0) + 1;
    this.hits.set(key, n);
    return Promise.resolve(n <= limit);
  }
  once(key: string) {
    const first = !this.flags.has(key);
    this.flags.add(key);
    return Promise.resolve(first);
  }
  total() {
    return [...this.used.values()].reduce((a, b) => a + b, 0);
  }
}

class MemoryCallLog {
  entries: GeoCallEntry[] = [];
  callsTodayValue = 0;
  record(entry: GeoCallEntry) {
    this.entries.push(entry);
    return Promise.resolve();
  }
  callsToday() {
    return Promise.resolve(this.callsTodayValue);
  }
}

const OWN_LANDMARK: OwnGeoResult = {
  kind: 'landmark',
  label: 'Crescent Lake',
  labelBn: 'ক্রিসেন্ট লেক',
  location: { lat: 23.7629, lng: 90.3787 },
  area: 'Sher-e-Bangla Nagar',
  city: null,
  ref: 'place-1',
};
const OWN_STORE: OwnGeoResult = {
  kind: 'store',
  label: 'Rahim Electronics',
  labelBn: 'রহিম ইলেকট্রনিক্স',
  location: { lat: 23.807, lng: 90.368 },
  area: 'Mirpur',
  city: null,
  ref: 'store-1',
};
const OWN_AREA: OwnGeoResult = {
  kind: 'area',
  label: 'Mirpur, Dhaka',
  labelBn: 'মিরপুর, ঢাকা',
  location: { lat: 23.8, lng: 90.36 },
  area: 'Mirpur',
  city: 'Dhaka',
  ref: 'BD3026',
};
const AREAS: LocationArea[] = [
  {
    id: 'dhaka',
    parentId: null,
    level: 'district',
    pcode: 'BD3026',
    name: { bn: 'ঢাকা', en: 'Dhaka' },
    center: null,
    hasChildren: true,
  },
];

function setup(options: { own?: OwnGeoResult[]; settings?: Record<string, unknown> } = {}) {
  const fake = new FakeProvider();
  const none = new NullProvider();
  const cache = new MemoryCache();
  const budget = new MemoryBudget();
  const log = new MemoryCallLog();
  const alerts = {
    afterReserve: jest.fn(() => Promise.resolve()),
    exhausted: jest.fn(() => Promise.resolve()),
  };
  const own = { search: jest.fn(() => Promise.resolve(options.own ?? [])) };
  const locations = {
    areasAt: jest.fn(() => Promise.resolve(AREAS)),
    straightLineMeters: jest.fn(() => Promise.resolve(871.4)),
  };
  const values = { ...SETTINGS, ...options.settings };
  const settings = { get: jest.fn((key: string) => Promise.resolve(values[key])) };
  const context = { current: () => ({ tenantId: 'tenant-1' }) };
  const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const service = new GeoService(
    [fake, none],
    none,
    cache,
    budget,
    log as unknown as GeoCallLog,
    alerts as unknown as GeoBudgetAlerts,
    own as unknown as OwnGeoLookup,
    locations as unknown as LocationsService,
    settings as unknown as SettingsService,
    context as unknown as TenantContext,
    logger as unknown as PinoLogger,
  );
  return { service, fake, cache, budget, log, alerts, own, locations };
}

const ROUTE = {
  from: { lat: 23.75561, lng: 90.37471 },
  to: { lat: 23.7629, lng: 90.3787 },
  mode: 'foot' as const,
};

describe('GeoService', () => {
  describe('autocomplete: own data first', () => {
    it('an own-data hit makes zero provider calls (and logs none)', async () => {
      const { service, fake, log } = setup({ own: [OWN_LANDMARK, OWN_STORE, OWN_AREA] });
      const response = await service.autocomplete(
        { q: 'crescent', lat: 23.76, lng: 90.37 },
        'user:1',
      );
      expect(fake.callCount).toBe(0);
      expect(log.entries).toEqual([]);
      expect(response.degraded).toBe(false);
      expect(response.results.map((r) => [r.source, r.kind, r.refId])).toEqual([
        ['own', 'landmark', 'place-1'],
        ['own', 'store', 'store-1'],
        ['own', 'area', null],
      ]);
      expect(response.results[0]!.distanceMeters).toBeGreaterThan(0);
    });

    it('below geo_own_results_min asks Barikoi, own results first, each tagged', async () => {
      const { service, fake, log } = setup({ own: [OWN_LANDMARK] });
      const response = await service.autocomplete({ q: 'mirpur 10' }, 'user:1');
      expect(fake.calls).toEqual([{ endpoint: 'autocomplete', q: 'mirpur 10', bangla: false }]);
      expect(response.results.map((r) => r.source)).toEqual(['own', 'barikoi']);
      expect(log.entries).toEqual([
        expect.objectContaining({
          provider: 'fake',
          endpoint: 'autocomplete',
          callsCounted: 1,
          cacheHit: false,
          status: 'ok',
          tenantId: 'tenant-1',
        }),
      ]);
    });

    it('asks for the Bengali variant when the query is Bengali', async () => {
      const { service, fake } = setup();
      await service.autocomplete({ q: 'মিরপুর ১০' }, 'user:1');
      expect(fake.calls[0]).toMatchObject({ endpoint: 'autocomplete', bangla: true });
    });

    it('enforces the minimum length (nothing asked) and the per-client rate limit', async () => {
      const { service, fake, own } = setup({
        settings: { geo_autocomplete_per_client_per_minute: 1 },
      });
      await expect(service.autocomplete({ q: 'mi' }, 'user:1')).resolves.toMatchObject({
        results: [],
      });
      expect(own.search).not.toHaveBeenCalled();
      await service.autocomplete({ q: 'mirpur' }, 'user:1');
      await expect(service.autocomplete({ q: 'mirpur 1' }, 'user:1')).rejects.toBeInstanceOf(
        GeoRateLimitedException,
      );
      await expect(service.autocomplete({ q: 'mirpur 1' }, 'user:2')).resolves.toBeDefined();
      expect(fake.callCount).toBe(2);
    });
  });

  describe('cache', () => {
    it('a cache hit makes zero provider calls and is logged as one', async () => {
      const { service, fake, log } = setup();
      await service.autocomplete({ q: 'Shewrapara  ' }, 'user:1');
      await service.autocomplete({ q: 'shewrapara' }, 'user:2');
      expect(fake.callCount).toBe(1);
      expect(log.entries.map((e) => [e.status, e.cacheHit, e.callsCounted])).toEqual([
        ['ok', false, 1],
        ['cache_hit', true, 0],
      ]);
    });

    it('reverse answers are cached per geohash cell: a nearby pin in the same block reuses one', async () => {
      const { service, fake } = setup();
      await service.reverse({ lat: 23.7629, lng: 90.3787, purpose: 'post_location' });
      await service.reverse({ lat: 23.76295, lng: 90.37875, purpose: 'post_location' }); // ~7 m away
      expect(fake.callCount).toBe(1);
      await service.reverse({ lat: 23.7655, lng: 90.3787, purpose: 'post_location' }); // next block
      expect(fake.callCount).toBe(2);
    });
  });

  describe('reverse geocoding', () => {
    it('purpose=area: areas from geo_areas only, zero provider calls', async () => {
      const { service, fake, log } = setup();
      await expect(service.reverse({ lat: 23.8, lng: 90.4, purpose: 'area' })).resolves.toEqual({
        location: { lat: 23.8, lng: 90.4 },
        purpose: 'area',
        address: null,
        areas: AREAS,
        degraded: false,
      });
      expect(fake.callCount).toBe(0);
      expect(log.entries).toEqual([]);
    });

    it.each([
      ['post_location', ['bangla'], 2],
      ['store_setup', ['bangla', 'post_code'], 3],
      ['place_marking', ['bangla'], 2],
    ] as const)(
      'purpose=%s requests only its mapped fields %j, counted as %d calls',
      async (purpose, fields, calls) => {
        const { service, fake, budget, log } = setup();
        const response = await service.reverse({ lat: 23.8, lng: 90.4, purpose });
        expect(fake.calls).toEqual([{ endpoint: 'reverse', lat: 23.8, lng: 90.4, fields }]);
        expect(budget.total()).toBe(calls);
        expect(log.entries[0]).toMatchObject({ endpoint: 'reverse', callsCounted: calls });
        expect(response.address).toMatchObject({
          source: 'barikoi',
          labelBn: 'বাড়ি ৮, রোড ২, মিরপুর, ঢাকা',
        });
        expect(response.areas).toEqual(AREAS);
      },
    );
  });

  describe('daily budget, in Barikoi calls', () => {
    it('exhausted: NullProvider (no call), the refusal is logged, and reverse still returns area names', async () => {
      const { service, fake, log, alerts } = setup({ settings: { barikoi_daily_call_budget: 3 } });
      await service.reverse({ lat: 23.8, lng: 90.4, purpose: 'post_location' }); // 2 of 3
      const over = await service.reverse({ lat: 23.9, lng: 90.5, purpose: 'post_location' }); // +2 > 3
      expect(fake.callCount).toBe(1);
      expect(over).toMatchObject({ address: null, areas: AREAS, degraded: true });
      expect(log.entries.at(-1)).toMatchObject({ status: 'over_budget', callsCounted: 0 });
      expect(alerts.exhausted).toHaveBeenCalledWith('fake', expect.any(String), 3);
    });

    it('warns at barikoi_budget_warn_pct with the day total', async () => {
      const { service, alerts } = setup({ settings: { barikoi_daily_call_budget: 5 } });
      await service.reverse({ lat: 23.8, lng: 90.4, purpose: 'store_setup' }); // 3 of 5
      await service.reverse({ lat: 23.9, lng: 90.5, purpose: 'post_location' }); // 5 of 5
      expect(alerts.afterReserve).toHaveBeenLastCalledWith('fake', expect.any(String), 5, 5, 80);
    });

    it('a budget of 0 or geo_provider=null never calls a provider', async () => {
      for (const settings of [{ barikoi_daily_call_budget: 0 }, { geo_provider: 'null' }]) {
        const { service, fake } = setup({ settings, own: [OWN_AREA] });
        const response = await service.autocomplete({ q: 'mirpur 10' }, 'user:1');
        expect(fake.callCount).toBe(0);
        expect(response).toMatchObject({ degraded: true, results: [{ kind: 'area' }] });
      }
    });

    it('counts from geo_provider_calls when Redis is down', async () => {
      const { service, fake, budget, log } = setup();
      budget.down = true;
      log.callsTodayValue = 9;
      await service.autocomplete({ q: 'mirpur 10' }, 'user:1'); // 9 + 1 <= 10
      expect(fake.callCount).toBe(1);
      log.callsTodayValue = 10;
      const refused = await service.autocomplete({ q: 'mirpur 11' }, 'user:1');
      expect(fake.callCount).toBe(1);
      expect(refused.degraded).toBe(true);
    });

    it('counts the day in Bangladesh time', () => {
      expect(dhakaDay(new Date('2026-10-05T20:00:00Z'))).toBe('2026-10-06');
      expect(dhakaDay(new Date('2026-10-05T17:00:00Z'))).toBe('2026-10-05');
    });
  });

  describe('never fatal', () => {
    it('on 429: own data answers, billed and logged, breaker opens, nothing cached', async () => {
      const { service, fake, cache, log } = setup({ own: [OWN_AREA] });
      fake.failure = new GeoProviderError('rate_limited', 429);
      const response = await service.autocomplete({ q: 'mirpur 10' }, 'user:1');
      expect(response).toMatchObject({ degraded: true, results: [{ kind: 'area' }] });
      expect(log.entries[0]).toMatchObject({ status: 'rate_limited', callsCounted: 1 });
      expect(cache.store.size).toBe(0);
      fake.failure = null;
      await service.autocomplete({ q: 'mirpur 11' }, 'user:1');
      expect(fake.callCount).toBe(1); // breaker open
      expect(log.entries.at(-1)).toMatchObject({ status: 'disabled', callsCounted: 0 });
    });

    it('a timeout gives the reservation back and opens the breaker', async () => {
      const { service, fake, budget, log } = setup();
      fake.failure = new GeoProviderError('timeout');
      await service.autocomplete({ q: 'mirpur 10' }, 'user:1');
      expect(budget.total()).toBe(0);
      expect(log.entries[0]).toMatchObject({ status: 'timeout', callsCounted: 0 });
      fake.failure = null;
      await service.autocomplete({ q: 'mirpur 11' }, 'user:1');
      expect(fake.callCount).toBe(1);
    });

    it('a 401 does not open the breaker (it is a key problem, not a struggling provider)', async () => {
      const { service, fake } = setup();
      fake.failure = new GeoProviderError('unauthorized', 401);
      await service.autocomplete({ q: 'mirpur 10' }, 'user:1');
      fake.failure = null;
      await service.autocomplete({ q: 'mirpur 11' }, 'user:1');
      expect(fake.callCount).toBe(2);
    });

    it('without a key the provider is never called', async () => {
      const { service, fake } = setup({ own: [OWN_AREA] });
      fake.configured = false;
      await service.autocomplete({ q: 'mirpur 10' }, 'user:1');
      expect(fake.callCount).toBe(0);
    });
  });

  describe('routes', () => {
    it('routes between rounded points, costs barikoi_cost_route, cached', async () => {
      const { service, fake, budget } = setup();
      const route = await service.route(ROUTE, 'user:1');
      expect(route).toEqual({
        mode: 'foot',
        distanceMeters: 1971,
        durationSeconds: 1782,
        polyline: fake.routeResult!.polyline,
        source: 'barikoi',
        degraded: false,
      });
      await service.route({ ...ROUTE, from: { lat: 23.75559, lng: 90.37471 } }, 'user:1');
      expect(fake.calls).toEqual([
        {
          endpoint: 'route',
          from: { lat: 23.7556, lng: 90.3747 },
          to: { lat: 23.7629, lng: 90.3787 },
          mode: 'foot',
        },
      ]);
      expect(budget.total()).toBe(2);
    });

    it('falls back to the PostGIS straight-line distance, with no made-up travel time', async () => {
      const { service, fake, locations } = setup();
      fake.failure = new GeoProviderError('server_error', 502);
      await expect(service.route(ROUTE, 'user:1')).resolves.toEqual({
        mode: 'foot',
        distanceMeters: 871,
        durationSeconds: null,
        polyline: null,
        source: 'straight_line',
        degraded: true,
      });
      expect(locations.straightLineMeters).toHaveBeenCalledWith(ROUTE.from, ROUTE.to);
    });

    it('limits routes per client per hour', async () => {
      const { service } = setup();
      await service.route(ROUTE, 'ip:1.2.3.4');
      await service.route(ROUTE, 'ip:1.2.3.4');
      await expect(service.route(ROUTE, 'ip:1.2.3.4')).rejects.toBeInstanceOf(
        GeoRateLimitedException,
      );
    });
  });

  it('geocodeAddress (Rupantor) costs barikoi_cost_rupantor', async () => {
    const { service, budget, log } = setup();
    await service.geocodeAddress('Shewrapara, Mirpur');
    expect(budget.total()).toBe(2);
    expect(log.entries[0]).toMatchObject({ endpoint: 'geocode_address', callsCounted: 2 });
  });
});

describe('normalizeQuery / roundPoint', () => {
  it('normalizes case, spacing and zero-width characters', () => {
    expect(normalizeQuery('  Mirpur\u200B   10 ')).toBe('mirpur 10');
  });
  it('rounds a point', () => {
    expect(roundPoint({ lat: 23.80691, lng: 90.36868 }, 4)).toEqual({ lat: 23.8069, lng: 90.3687 });
  });
});
