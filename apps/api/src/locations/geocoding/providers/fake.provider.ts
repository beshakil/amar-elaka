import type {
  Address,
  AutocompleteOptions,
  Candidate,
  GeoPoint,
  GeoProvider,
  ReverseField,
  RouteMode,
  RouteResult,
  Suggestion,
} from '../geo-provider.port';
import { GeoProviderError } from '../geo-provider.port';

/** One call the fake received, with exactly what it was asked for. */
export type FakeCall =
  | { endpoint: 'autocomplete'; q: string; bangla: boolean }
  | { endpoint: 'reverse'; lat: number; lng: number; fields: ReverseField[] }
  | { endpoint: 'geocode_address'; text: string }
  | { endpoint: 'route'; from: GeoPoint; to: GeoPoint; mode: RouteMode };

/**
 * Tests only: never bound by the module, never touches the network. Records
 * every call (so a test can say "zero provider calls" or "asked only for
 * these fields"), answers fixed data, and fails on demand.
 */
export class FakeProvider implements GeoProvider {
  readonly name = 'fake';
  configured = true;
  calls: FakeCall[] = [];
  /** Thrown by the next calls until cleared. */
  failure: GeoProviderError | null = null;

  suggestions: Suggestion[] = [
    {
      label: 'Mirpur 10, Dhaka',
      labelBn: 'মিরপুর ১০, ঢাকা',
      location: { lat: 23.8069, lng: 90.3687 },
      area: 'Mirpur',
      city: 'Dhaka',
      postCode: '1216',
      providerRef: 'FAKE001',
    },
  ];
  address: Address | null = {
    label: 'House 8, Road 2, Mirpur, Dhaka',
    labelBn: 'বাড়ি ৮, রোড ২, মিরপুর, ঢাকা',
    area: 'Mirpur',
    city: 'Dhaka',
    postCode: '1216',
    providerRef: 'FAKE002',
  };
  routeResult: RouteResult | null = {
    distanceMeters: 1971.3,
    durationSeconds: 1782.1,
    polyline: [
      [90.3747, 23.7556],
      [90.3787, 23.7629],
    ],
  };

  get callCount(): number {
    return this.calls.length;
  }

  autocomplete(
    q: string,
    _near: GeoPoint | undefined,
    opts: AutocompleteOptions,
  ): Promise<Suggestion[]> {
    return this.answer({ endpoint: 'autocomplete', q, bangla: opts.bangla }, this.suggestions);
  }

  reverseGeocode(
    lat: number,
    lng: number,
    fields: readonly ReverseField[],
  ): Promise<Address | null> {
    return this.answer({ endpoint: 'reverse', lat, lng, fields: [...fields] }, this.address);
  }

  geocodeAddress(text: string): Promise<Candidate[]> {
    return this.answer({ endpoint: 'geocode_address', text }, this.suggestions);
  }

  route(from: GeoPoint, to: GeoPoint, mode: RouteMode): Promise<RouteResult | null> {
    return this.answer({ endpoint: 'route', from, to, mode }, this.routeResult);
  }

  private answer<T>(call: FakeCall, value: T): Promise<T> {
    this.calls.push(call);
    return this.failure ? Promise.reject(this.failure) : Promise.resolve(value);
  }
}
