import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/exceptions/domain-exception';

/**
 * A category field schema can't be published: it breaks the supported
 * subset (categories.md §3.2), a reserved key's type, the analytics
 * whitelist rules, or a parent's field when flattened (change C5).
 * `violations` is diagnostic detail for the platform admin and the logs.
 */
export class InvalidFieldSchemaException extends DomainException {
  readonly code = 'CATEGORY_FIELD_SCHEMA_INVALID';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor(readonly violations: string[]) {
    super('The category field schema is invalid.');
  }
}
