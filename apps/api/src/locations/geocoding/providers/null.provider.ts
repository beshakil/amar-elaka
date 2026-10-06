import { Injectable } from '@nestjs/common';
import type {
  Address,
  Candidate,
  GeoProvider,
  RouteResult,
  Suggestion,
} from '../geo-provider.port';

/**
 * The provider that answers nothing (ADR 044): what GeoService uses when
 * `geo_provider` is `null`, when there's no key, when the day's budget is
 * spent (until midnight Asia/Dhaka), and while the circuit breaker is open.
 * Callers then answer from our own data — places, landmarks, stores and
 * geo_areas — so no user flow is ever blocked: a post can always be saved
 * with a pin and an area name.
 */
@Injectable()
export class NullProvider implements GeoProvider {
  readonly name = 'null';
  readonly configured = false;

  autocomplete(): Promise<Suggestion[]> {
    return Promise.resolve([]);
  }

  reverseGeocode(): Promise<Address | null> {
    return Promise.resolve(null);
  }

  geocodeAddress(): Promise<Candidate[]> {
    return Promise.resolve([]);
  }

  route(): Promise<RouteResult | null> {
    return Promise.resolve(null);
  }
}
