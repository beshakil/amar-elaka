import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';

/** Missing, deleted, or someone else's — deliberately the same answer. */
export class SavedSearchNotFoundException extends DomainException {
  readonly code = 'SAVED_SEARCH_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;
  constructor() {
    super('Saved search not found.');
  }
}

/** saved_search_max_active reached: switch one off or delete one first. */
export class SavedSearchLimitReachedException extends DomainException {
  readonly code = 'SAVED_SEARCH_LIMIT_REACHED';
  readonly httpStatus = HttpStatus.CONFLICT;
  readonly issues: { maxActive: number };
  constructor(maxActive: number) {
    super(`At most ${maxActive} saved searches can be active at once.`);
    this.issues = { maxActive };
  }
}

export class SavedSearchInvalidException extends DomainException {
  readonly code = 'SAVED_SEARCH_INVALID';
  readonly httpStatus = HttpStatus.BAD_REQUEST;
  readonly issues: { field: string; max: number };
  constructor(field: 'name' | 'radius_km', max: number) {
    super(`${field} is over its limit of ${max}.`);
    this.issues = { field, max };
  }
}
