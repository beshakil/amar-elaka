import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';

export class TenantRequiredException extends DomainException {
  readonly code = 'TENANT_REQUIRED';
  readonly httpStatus = HttpStatus.BAD_REQUEST;
  constructor() {
    super(
      'This request requires a tenant (X-Tenant-Id header, tenant subdomain, or custom domain).',
    );
  }
}

export class TenantIdInvalidException extends DomainException {
  readonly code = 'TENANT_ID_INVALID';
  readonly httpStatus = HttpStatus.BAD_REQUEST;
  constructor() {
    super('X-Tenant-Id must be a valid tenant id.');
  }
}

export class TenantNotFoundException extends DomainException {
  readonly code = 'TENANT_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;
  constructor() {
    super('No active tenant matches the given tenant id, subdomain, or domain.');
  }
}

export class TenantSuspendedException extends DomainException {
  readonly code = 'TENANT_SUSPENDED';
  readonly httpStatus = HttpStatus.FORBIDDEN;
  constructor() {
    super('This tenant is currently suspended.');
  }
}

export class TenantTerminatedException extends DomainException {
  readonly code = 'TENANT_TERMINATED';
  readonly httpStatus = HttpStatus.FORBIDDEN;
  constructor() {
    super('This tenant has been terminated.');
  }
}
