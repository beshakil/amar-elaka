import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/exceptions/domain-exception';

/**
 * Per-client limits (ADR 044): `geo_autocomplete_per_client_per_minute` and
 * `route_requests_per_client_per_hour`. A client is the signed-in user, else
 * their IP.
 */
export class GeoRateLimitedException extends DomainException {
  readonly code = 'GEO_RATE_LIMITED';
  readonly httpStatus = HttpStatus.TOO_MANY_REQUESTS;

  constructor() {
    super('Too many location requests for now. Please try again shortly.');
  }
}
