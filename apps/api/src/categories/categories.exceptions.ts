import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';

export class CategoryNotFoundException extends DomainException {
  readonly code = 'CATEGORY_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('Category not found.');
  }
}

export class CategorySlugTakenException extends DomainException {
  readonly code = 'CATEGORY_SLUG_TAKEN';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super('Another category already uses this slug.');
  }
}

/** A database rule rejected the change (kind/parent mismatch, module tile shape, …). */
export class CategoryRuleViolationException extends DomainException {
  readonly code = 'CATEGORY_RULE_VIOLATION';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor(readonly issues: string[]) {
    super('The change breaks a category rule.');
  }
}

export class CategoryHasChildrenException extends DomainException {
  readonly code = 'CATEGORY_HAS_CHILDREN';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super('Delete or move the child categories first.');
  }
}

export class CategoryHasNoFieldSchemaException extends DomainException {
  readonly code = 'CATEGORY_HAS_NO_FIELD_SCHEMA';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor() {
    super('Module tiles have no custom fields.');
  }
}

export class FieldSchemaDraftNotFoundException extends DomainException {
  readonly code = 'FIELD_SCHEMA_DRAFT_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('This category has no draft field schema.');
  }
}

export class ParentSchemaNotPublishedException extends DomainException {
  readonly code = 'PARENT_FIELD_SCHEMA_NOT_PUBLISHED';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super("Publish the parent category's field schema first.");
  }
}

export class FieldSchemaNotFoundException extends DomainException {
  readonly code = 'FIELD_SCHEMA_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('Field schema not found.');
  }
}

/** The category exists but can't take a post here: inactive, a place/module, or disabled in this tenant. */
export class CategoryNotPostableException extends DomainException {
  readonly code = 'CATEGORY_NOT_POSTABLE';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor() {
    super('This category does not accept posts here.');
  }
}

export interface FieldIssue {
  /** The field key (or `field.index` inside a multiselect); empty for the payload itself. */
  field: string;
  /** Stable code the client translates, e.g. `field.required` (fields-validator.ts). */
  code: string;
}

export class FieldValidationException extends DomainException {
  readonly code = 'FIELD_VALIDATION_FAILED';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor(readonly issues: FieldIssue[]) {
    super('Some fields are missing or invalid.');
  }
}

export class PlatformAdminRoleRequiredException extends DomainException {
  readonly code = 'PLATFORM_ADMIN_REQUIRED';
  readonly httpStatus = HttpStatus.FORBIDDEN;

  constructor() {
    super('Only a platform admin can do this.');
  }
}
