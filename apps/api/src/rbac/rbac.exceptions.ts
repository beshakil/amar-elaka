import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';

export class PermissionDeniedException extends DomainException {
  readonly code = 'PERMISSION_DENIED';
  readonly httpStatus = HttpStatus.FORBIDDEN;
  constructor(module: string, action: string) {
    super(`Missing permission: ${module}:${action}.`);
  }
}

export class OwnershipRequiredException extends DomainException {
  readonly code = 'OWNERSHIP_REQUIRED';
  readonly httpStatus = HttpStatus.FORBIDDEN;
  constructor() {
    super('You do not own this resource.');
  }
}

export class RoleNotFoundException extends DomainException {
  readonly code = 'ROLE_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;
  constructor() {
    super('No such role in this tenant.');
  }
}

export class RoleAlreadyExistsException extends DomainException {
  readonly code = 'ROLE_ALREADY_EXISTS';
  readonly httpStatus = HttpStatus.CONFLICT;
  constructor() {
    super('A role with this name already exists in this tenant.');
  }
}

export class TenantMemberNotFoundException extends DomainException {
  readonly code = 'TENANT_MEMBER_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;
  constructor() {
    super('No such member in this tenant.');
  }
}

/**
 * Built-in roles are templates every tenant shares (tenant_id NULL). Letting
 * one tenant rename or re-scope `moderator` would change it for all of them.
 */
export class BuiltinRoleImmutableException extends DomainException {
  readonly code = 'ROLE_BUILTIN_IMMUTABLE';
  readonly httpStatus = HttpStatus.CONFLICT;
  constructor() {
    super('Built-in roles cannot be changed or deleted.');
  }
}
