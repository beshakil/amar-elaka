import { BarikoiGeocodingProvider } from './barikoi.provider';
import { GeocodingUnavailableError } from './geocoding.port';

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

describe('BarikoiGeocodingProvider', () => {
  const provider = new BarikoiGeocodingProvider(env);

  it('autocompletes, normalising Barikoi fields and dropping places without coordinates', async () => {
    const calls = respond(json(AUTOCOMPLETE));
    await expect(provider.autocomplete('mirpur dohs')).resolves.toEqual([
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

  it('reverse-geocodes, keeping the asked point as the location', async () => {
    const calls = respond(json(REVERSE));
    await expect(provider.reverse({ lat: 23.8067, lng: 90.3572 })).resolves.toMatchObject({
      label: 'House 8, Road 2, Block C, Section 2, Mirpur, Dhaka',
      location: { lat: 23.8067, lng: 90.3572 },
      postCode: '1216',
      providerRef: '6488',
    });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('latitude')).toBe('23.8067');
    expect(url.searchParams.get('longitude')).toBe('90.3572');
  });

  it('forward-geocodes with Rupantor (a form POST), parsing string coordinates', async () => {
    const calls = respond(json(RUPANTOR));
    const [result] = await provider.forward('shawrapara');
    expect(result).toMatchObject({
      label: 'Shewrapara Koborsthan, East Shewrapara, Shewrapara, Mirpur, Dhaka',
      location: { lat: 23.79175613, lng: 90.37567053 },
      providerRef: 'TOLJ0109',
    });
    expect(calls[0]!.init?.method).toBe('POST');
    expect((calls[0]!.init?.body as URLSearchParams).get('q')).toBe('shawrapara');
  });

  it('returns nothing (not an error) when Barikoi finds nothing', async () => {
    respond(
      json({ places: [], status: 200 }),
      json({ status: 200 }),
      json({ place: null, status: 200 }),
    );
    await expect(provider.autocomplete('zzzz')).resolves.toEqual([]);
    await expect(provider.forward('zzzz')).resolves.toEqual([]);
    await expect(provider.reverse({ lat: 0, lng: 0 })).resolves.toBeNull();
  });

  it('retries a server error or network failure once', async () => {
    const calls = respond(new Response('oops', { status: 502 }), json(AUTOCOMPLETE));
    await expect(provider.autocomplete('mirpur')).resolves.toHaveLength(1);
    expect(calls).toHaveLength(2);

    const again = respond(new TypeError('fetch failed'), new TypeError('fetch failed'));
    await expect(provider.autocomplete('mirpur')).rejects.toThrow(GeocodingUnavailableError);
    expect(again).toHaveLength(2);
  });

  it.each([401, 402, 429])(
    'does not retry HTTP %d (bad key, unpaid, rate-limited)',
    async (status) => {
      const calls = respond(json({ message: 'nope' }, status));
      await expect(provider.autocomplete('mirpur')).rejects.toMatchObject({
        reason: `HTTP ${status}`,
      });
      expect(calls).toHaveLength(1);
    },
  );

  it('treats a timeout, a bad body or a missing key as unavailable, never leaking the key', async () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    respond(timeout, timeout);
    const error = await provider.autocomplete('mirpur').catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: 'timeout' });
    expect(String((error as Error).message)).not.toContain(KEY);

    respond(new Response('<html>', { status: 200 }));
    await expect(provider.autocomplete('mirpur')).rejects.toMatchObject({
      reason: 'response was not JSON',
    });

    const keyless = new BarikoiGeocodingProvider({ ...env, BARIKOI_API_KEY: undefined });
    const calls = respond();
    await expect(keyless.reverse({ lat: 23.8, lng: 90.4 })).rejects.toThrow(
      GeocodingUnavailableError,
    );
    expect(calls).toHaveLength(0);
  });
});
