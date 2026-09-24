import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';

export class PlatformAccessRequiredException extends DomainException {
  readonly code = 'PLATFORM_ACCESS_REQUIRED';
  readonly httpStatus = HttpStatus.FORBIDDEN;
  constructor() {
    super('This endpoint is restricted to platform staff.');
  }
}
