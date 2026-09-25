import type { PinoLogger } from 'nestjs-pino';
import type { KeyValueCache } from '../../cache/cache.service';
import type { SettingsService } from '../../settings/settings.service';
import type { LocationArea } from '../dto/locations.dto';
import type { AreaSearchRow } from '../locations.repository';
import type { LocationsService } from '../locations.service';
import {
  GeocodingUnavailableError,
  type GeocodeResult,
  type GeocodingProvider,
  type GeoPoint,
} from './geocoding.port';
import { GeocodingService, normalizeQuery, roundPoint } from './geocoding.service';

const SETTINGS: Record<string, number> = {
  geocode_cache_days: 30,
  geocode_results_max: 2,
  geocode_autocomplete_min_chars: 3,
  geocode_reverse_cache_decimals: 4,
};

const place = (label: string, lat = 23.8069, lng = 90.3687): GeocodeResult => ({
  label,
  labelBn: null,
  location: { lat, lng },
  area: 'Mirpur',
  city: 'Dhaka',
  postCode: '1216',
  providerRef: label,
});

class FakeProvider implements GeocodingProvider {
  readonly name = 'fake';
  calls: string[] = [];
  down = false;
  forward = (q: string) => this.answer(`forward ${q}`, [place('A'), place('B'), place('C')]);
  autocomplete = (q: string) => this.answer(`autocomplete ${q}`, [place('Mirpur 10')]);
  reverse = (p: GeoPoint) => this.answer(`reverse ${p.lat},${p.lng}`, place('House 8, Mirpur'));
  private answer<T>(call: string, value: T): Promise<T> {
    this.calls.push(call);
    return this.down
      ? Promise.reject(new GeocodingUnavailableError('HTTP 502'))
      : Promise.resolve(value);
  }
}

class MemoryCache implements KeyValueCache {
  store = new Map<string, { value: unknown; ttl: number }>();
  broken = false;
  get<T>(key: string): Promise<T | undefined> {
    if (this.broken) return Promise.reject(new Error('redis down'));
    return Promise.resolve(this.store.get(key)?.value as T | undefined);
  }
  set<T>(key: string, value: T, ttl: number): Promise<void> {
    if (this.broken) return Promise.reject(new Error('redis down'));
    this.store.set(key, { value, ttl });
    return Promise.resolve();
  }
  del = () => Promise.resolve();
  remember = <T>(_k: string, _t: number, load: () => Promise<T>) => load();
}

const MIRPUR_AREAS: LocationArea[] = [
  {
    id: 'bd',
    parentId: null,
    level: 'country',
    pcode: 'BD',
    name: { bn: 'বাংলাদেশ', en: 'Bangladesh' },
    center: null,
    hasChildren: true,
  },
  {
    id: 'dncc',
    parentId: 'bd',
    level: 'city_corporation',
    pcode: 'BD30262500',
    name: { bn: 'ঢাকা উত্তর সিটি কর্পোরেশন', en: 'Dhaka North City Corporation' },
    center: null,
    hasChildren: false,
  },
];
const TRISHAL_ROW: AreaSearchRow = {
  id: 't',
  parent_id: 'm',
  adm_level: 3,
  level_code: 'upazila',
  cod_pcode: 'BD45610094',
  name_en: 'Trishal',
  name_bn: 'ত্রিশাল',
  lat: 24.5637,
  lng: 90.4104,
  has_children: true,
  parent_name_en: 'Mymensingh',
  parent_name_bn: 'ময়মনসিংহ',
};

function setup() {
  const provider = new FakeProvider();
  const cache = new MemoryCache();
  const locations = {
    areasAt: () => Promise.resolve(MIRPUR_AREAS),
    searchByName: (q: string) =>
      Promise.resolve(q.startsWith('tri') || q.startsWith('ত্রি') ? [TRISHAL_ROW] : []),
  } as unknown as LocationsService;
  const settings = {
    get: (key: string) => Promise.resolve(SETTINGS[key]),
  } as unknown as SettingsService;
  const logger = { setContext: () => undefined, warn: () => undefined } as unknown as PinoLogger;
  return {
    service: new GeocodingService(provider, cache, locations, settings, logger),
    provider,
    cache,
  };
}

describe('GeocodingService', () => {
  it('caches provider answers for 30 days, keyed on the normalised query', async () => {
    const { service, provider, cache } = setup();
    const first = await service.forward({ q: '  Mirpur   10 ' });
    const second = await service.forward({ q: 'mirpur 10' });
    expect(provider.calls).toEqual(['forward mirpur 10']);
    expect(second).toEqual({ ...first, query: 'mirpur 10' });
    expect([...cache.store.values()][0]!.ttl).toBe(30 * 86_400);
    // Limited to geocode_results_max.
    expect(first.results.map((r) => r.label)).toEqual(['A', 'B']);
    expect(first.degraded).toBe(false);
    expect(first.results[0]).toMatchObject({ source: 'provider', distanceMeters: null });
  });

  it('reports the distance from the caller when lat/lng are given', async () => {
    const { service } = setup();
    const response = await service.forward({ q: 'mirpur', lat: 23.7625, lng: 90.3783 });
    expect(response.results[0]!.distanceMeters).toBeGreaterThan(4000);
  });

  it('shares reverse-geocode cache entries between taps a few metres apart', async () => {
    const { service, provider } = setup();
    await service.reverse({ lat: 23.806912, lng: 90.368711 });
    await service.reverse({ lat: 23.806908, lng: 90.368689 });
    expect(provider.calls).toEqual(['reverse 23.8069,90.3687']);
    expect(roundPoint({ lat: 23.80695, lng: 90.36874 }, 4)).toEqual({ lat: 23.807, lng: 90.3687 });
  });

  it('never fails reverse geocoding: coordinates and our own areas when the provider is down', async () => {
    const { service, provider } = setup();
    provider.down = true;
    await expect(service.reverse({ lat: 23.8069, lng: 90.3687 })).resolves.toEqual({
      location: { lat: 23.8069, lng: 90.3687 },
      address: null,
      areas: MIRPUR_AREAS,
      degraded: true,
    });
  });

  it('falls back to area names in either script when the provider is down, without caching it', async () => {
    const { service, provider, cache } = setup();
    provider.down = true;
    const response = await service.forward({ q: 'Trishal' });
    expect(response).toMatchObject({
      degraded: true,
      results: [
        {
          label: 'Trishal, Mymensingh',
          labelBn: 'ত্রিশাল, ময়মনসিংহ',
          location: { lat: 24.5637, lng: 90.4104 },
          source: 'local',
        },
      ],
    });
    expect((await service.autocomplete({ q: 'ত্রিশা' })).results[0]!.labelBn).toBe(
      'ত্রিশাল, ময়মনসিংহ',
    );
    expect(cache.store.size).toBe(0);
  });

  it('stops calling a failing provider for a while (circuit breaker)', async () => {
    const { service, provider } = setup();
    provider.down = true;
    await service.forward({ q: 'one' });
    await service.forward({ q: 'two' });
    await service.reverse({ lat: 23.8, lng: 90.4 });
    expect(provider.calls).toEqual(['forward one']);
  });

  it('keeps working when the cache is down', async () => {
    const { service, cache } = setup();
    cache.broken = true;
    await expect(service.forward({ q: 'mirpur' })).resolves.toMatchObject({ degraded: false });
  });

  it('waits for enough characters before autocompleting', async () => {
    const { service, provider } = setup();
    await expect(service.autocomplete({ q: 'mi' })).resolves.toEqual({
      query: 'mi',
      results: [],
      degraded: false,
    });
    expect(provider.calls).toEqual([]);
    await service.autocomplete({ q: 'মিরপ' });
    expect(provider.calls).toEqual(['autocomplete মিরপ']);
  });

  it('normalises queries the same way however they were typed', () => {
    expect(normalizeQuery(' Mirpur‌  DOHS ')).toBe('mirpur dohs');
  });
});
