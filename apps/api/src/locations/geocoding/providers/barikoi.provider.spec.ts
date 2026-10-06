import { GeoProviderError } from '../geo-provider.port';
import { BarikoiProvider } from './barikoi.provider';

// Response samples from docs.barikoi.com (trimmed), including its mixed types:
// postCode as a number, coordinates as strings in Rupantor.
const AUTOCOMPLETE = {
  places: [
    {
      id: 635085,
      longitude: 90.369999116958,
      latitude: 23.83729875602,
      address: 'Mirpur DOHS, Mirpur DOHS',
      address_bn: 'মিরপুর ডিওএইচএস, মিরপুর ডিওএইচএস, মিরপুর, ঢাকা',
      city: 'Dhaka',
      area: 'Mirpur',
      postCode: 1216,
      uCode: 'PFSU6037',
    },
    { id: 1, address: 'no coordinates' },
  ],
  status: 200,
};
const REVERSE = {
  place: {
    id: 6488,
    distance_within_meters: 3.6856,
    address: 'House 8, Road 2, Block C, Section 2, Mirpur, Dhaka',
    area: 'Mirpur',
    city: 'Dhaka',
    postCode: '1216',
    address_bn: 'বাড়ি ৮, রোড ২, ব্লক সি, সেকশন ২, মিরপুর, ঢাকা',
  },
  status: 200,
};
const RUPANTOR = {
  given_address: 'shawrapara',
  bangla_address: 'শেওড়াপাড়া কবরস্থান, ইস্ট শেওড়াপাড়া, শেওড়াপাড়া, মিরপুর, ঢাকা',
  geocoded_address: {
    Address: 'Shewrapara Koborsthan, East Shewrapara, Shewrapara, Mirpur, Dhaka',
    address: 'Shewrapara Koborsthan, East Shewrapara, Shewrapara, Mirpur, Dhaka',
    area: 'Mirpur',
    city: 'Dhaka',
    id: 221788,
    latitude: '23.79175613',
    longitude: '90.37567053',
    postCode: 1216,
    uCode: 'TOLJ0109',
  },
  status: 200,
};

const KEY = 'secret-barikoi-key';
const env = {
  BARIKOI_API_KEY: KEY,
  BARIKOI_BASE_URL: 'https://barikoi.test/',
  GEOCODING_TIMEOUT_MS: 1000,
};

function respond(...responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    calls.push({ url: input instanceof Request ? input.url : input.toString(), init });
    const next = responses.shift() ?? new Response('{}', { status: 200 });
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => jest.restoreAllMocks());

describe('BarikoiProvider', () => {
  const provider = new BarikoiProvider(env);

  it('autocompletes, normalising Barikoi fields and dropping places without coordinates', async () => {
    const calls = respond(json(AUTOCOMPLETE));
    await expect(
      provider.autocomplete('mirpur dohs', undefined, { bangla: true }),
    ).resolves.toEqual([
      {
        label: 'Mirpur DOHS, Mirpur DOHS',
        labelBn: 'মিরপুর ডিওএইচএস, মিরপুর ডিওএইচএস, মিরপুর, ঢাকা',
        location: { lat: 23.83729875602, lng: 90.369999116958 },
        area: 'Mirpur',
        city: 'Dhaka',
        postCode: '1216',
        providerRef: 'PFSU6037',
      },
    ]);
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe('https://barikoi.test/v2/api/search/autocomplete/place');
    expect(url.searchParams.get('q')).toBe('mirpur dohs');
    expect(url.searchParams.get('bangla')).toBe('true');
  });

  it('accepts a base URL that already ends in /v2/api without doubling it', async () => {
    const withPrefix = new BarikoiProvider({
      ...env,
      BARIKOI_BASE_URL: 'https://barikoi.test/v2/api/',
    });
    const calls = respond(json(AUTOCOMPLETE));
    await withPrefix.autocomplete('mirpur', undefined, { bangla: false });
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe('https://barikoi.test/v2/api/search/autocomplete/place');
  });

  it('reverse-geocodes to a street address (admin areas are never asked of it)', async () => {
    const calls = respond(json(REVERSE));
    await expect(provider.reverseGeocode(23.8067, 90.3572, ['bangla'])).resolves.toEqual({
      label: 'House 8, Road 2, Block C, Section 2, Mirpur, Dhaka',
      labelBn: 'বাড়ি ৮, রোড ২, ব্লক সি, সেকশন ২, মিরপুর, ঢাকা',
      area: 'Mirpur',
      city: 'Dhaka',
      postCode: '1216',
      providerRef: '6488',
    });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('latitude')).toBe('23.8067');
    expect(url.searchParams.get('longitude')).toBe('90.3572');
  });

  it('sends exactly the reverse fields it is asked for, nothing more (each one is billed)', async () => {
    const calls = respond(json(REVERSE), json(REVERSE), json(REVERSE));
    await provider.reverseGeocode(23.8, 90.4, []);
    await provider.reverseGeocode(23.8, 90.4, ['bangla']);
    await provider.reverseGeocode(23.8, 90.4, ['post_code', 'bangla', 'bangla']);
    const params = calls.map((c) => [...new URL(c.url).searchParams.keys()].sort());
    expect(params).toEqual([
      ['api_key', 'latitude', 'longitude'],
      ['api_key', 'bangla', 'latitude', 'longitude'],
      ['api_key', 'bangla', 'latitude', 'longitude', 'post_code'],
    ]);
  });

  it('asks autocomplete for the Bengali variant only when told to', async () => {
    const calls = respond(json(AUTOCOMPLETE), json(AUTOCOMPLETE));
    await provider.autocomplete('mirpur', { lat: 23.8, lng: 90.36 }, { bangla: false });
    await provider.autocomplete('মিরপুর', undefined, { bangla: true });
    const params = calls.map((c) => [...new URL(c.url).searchParams.keys()].sort());
    // No position either: location bias is another parameter, and our own data already answers near the user.
    expect(params).toEqual([
      ['api_key', 'q'],
      ['api_key', 'bangla', 'q'],
    ]);
  });

  it('routes with the OSRM-style route API, as GeoJSON', async () => {
    const calls = respond(
      json({
        code: 'Ok',
        routes: [
          {
            distance: 1971.3,
            duration: 1782.1,
            geometry: {
              type: 'LineString',
              coordinates: [
                [90.3746, 23.7555],
                [90.3787, 23.7629],
              ],
            },
          },
        ],
        waypoints: [],
      }),
    );
    await expect(
      provider.route({ lat: 23.7556, lng: 90.3747 }, { lat: 23.7629, lng: 90.3787 }, 'foot'),
    ).resolves.toEqual({
      distanceMeters: 1971.3,
      durationSeconds: 1782.1,
      polyline: [
        [90.3746, 23.7555],
        [90.3787, 23.7629],
      ],
    });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v2/api/route/90.3747,23.7556;90.3787,23.7629');
    expect(url.searchParams.get('profile')).toBe('foot');
    expect(url.searchParams.get('geometries')).toBe('geojson');

    respond(json({ code: 'NoRoute', routes: [] }));
    await expect(
      provider.route({ lat: 23.7, lng: 90.3 }, { lat: 21.4, lng: 92.0 }, 'car'),
    ).resolves.toBeNull();
  });

  it('forward-geocodes with Rupantor (a form POST), parsing string coordinates', async () => {
    const calls = respond(json(RUPANTOR));
    const [result] = await provider.geocodeAddress('shawrapara');
    expect(result).toMatchObject({
      label: 'Shewrapara Koborsthan, East Shewrapara, Shewrapara, Mirpur, Dhaka',
      location: { lat: 23.79175613, lng: 90.37567053 },
      providerRef: 'TOLJ0109',
    });
    expect(calls[0]!.init?.method).toBe('POST');
    const body = calls[0]!.init?.body as URLSearchParams;
    expect(body.get('q')).toBe('shawrapara');
    // Our own geo_areas know the thana and district: not asked of Barikoi.
    expect(body.has('thana')).toBe(false);
    expect(body.has('district')).toBe(false);
  });

  it('returns nothing (not an error) when Barikoi finds nothing', async () => {
    respond(
      json({ places: [], status: 200 }),
      json({ status: 200 }),
      json({ place: null, status: 200 }),
    );
    await expect(provider.autocomplete('zzzz', undefined, { bangla: false })).resolves.toEqual([]);
    await expect(provider.geocodeAddress('zzzz')).resolves.toEqual([]);
    await expect(provider.reverseGeocode(0, 0, [])).resolves.toBeNull();
  });

  it('retries a server error or network failure once', async () => {
    const calls = respond(new Response('oops', { status: 502 }), json(AUTOCOMPLETE));
    await expect(
      provider.autocomplete('mirpur', undefined, { bangla: false }),
    ).resolves.toHaveLength(1);
    expect(calls).toHaveLength(2);

    const again = respond(new TypeError('fetch failed'), new TypeError('fetch failed'));
    await expect(provider.autocomplete('mirpur', undefined, { bangla: false })).rejects.toThrow(
      GeoProviderError,
    );
    expect(again).toHaveLength(2);
  });

  it.each([
    [401, 'unauthorized'],
    [402, 'unauthorized'],
    [403, 'unauthorized'],
    [429, 'rate_limited'],
  ])('does not retry HTTP %d (%s), and says the provider was reached', async (status, reason) => {
    const calls = respond(json({ message: 'nope' }, status));
    const error = (await provider
      .autocomplete('mirpur', undefined, { bangla: false })
      .catch((e: unknown) => e)) as GeoProviderError;
    expect(error).toMatchObject({ reason, httpStatus: status });
    expect(error.reachedProvider).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('treats a timeout, a bad body or a missing key as unavailable, never leaking the key', async () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    respond(timeout, timeout);
    const error = await provider
      .autocomplete('mirpur', undefined, { bangla: false })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: 'timeout', reachedProvider: false });
    expect(String((error as Error).message)).not.toContain(KEY);

    respond(new Response('<html>', { status: 200 }));
    await expect(
      provider.autocomplete('mirpur', undefined, { bangla: false }),
    ).rejects.toMatchObject({
      reason: 'bad_response',
    });

    const keyless = new BarikoiProvider({ ...env, BARIKOI_API_KEY: undefined });
    expect(keyless.configured).toBe(false);
    const calls = respond();
    await expect(keyless.reverseGeocode(23.8, 90.4, [])).rejects.toMatchObject({
      reason: 'not_configured',
    });
    expect(calls).toHaveLength(0);
  });
});
