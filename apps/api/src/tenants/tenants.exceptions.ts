import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';

export class NoTenantNearbyException extends DomainException {
  readonly code = 'NO_TENANT_NEARBY';
  readonly httpStatus = HttpStatus.NOT_FOUND;
  constructor() {
    super('No tenant covers or is within range of this location yet.');
  }
}
