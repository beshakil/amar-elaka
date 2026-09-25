import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';

export class LocationNotFoundException extends DomainException {
  readonly code = 'LOCATION_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;
  constructor() {
    super('No active location has this id.');
  }
}

export class BoundaryTenantNotFoundException extends DomainException {
  readonly code = 'TENANT_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;
  constructor() {
    super('No tenant has this id.');
  }
}

export class TenantPolygonUnavailableException extends DomainException {
  readonly code = 'TENANT_POLYGON_UNAVAILABLE';
  readonly httpStatus = HttpStatus.CONFLICT;
  constructor() {
    super(
      "The tenant's area has no boundary polygon; use a center and radius, or import boundaries first.",
    );
  }
}

export class ServiceRadiusTooLargeException extends DomainException {
  readonly code = 'SERVICE_RADIUS_TOO_LARGE';
  readonly httpStatus = HttpStatus.BAD_REQUEST;
  constructor(readonly maxKm: number) {
    super(`A service radius can be at most ${maxKm} km.`);
  }
}

export class PlatformAdminRequiredException extends DomainException {
  readonly code = 'PLATFORM_ADMIN_REQUIRED';
  readonly httpStatus = HttpStatus.FORBIDDEN;
  constructor() {
    super('Only a platform admin can change tenant boundaries.');
  }
}
