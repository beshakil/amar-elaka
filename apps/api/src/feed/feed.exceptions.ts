import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';

export class FeedCursorInvalidException extends DomainException {
  readonly code = 'FEED_CURSOR_INVALID';
  readonly httpStatus = HttpStatus.BAD_REQUEST;
  constructor() {
    super('The cursor is malformed or belongs to a different feed query.');
  }
}

export class FeedCategoryNotFoundException extends DomainException {
  readonly code = 'FEED_CATEGORY_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;
  constructor() {
    super('No active category has this slug.');
  }
}

export class FeedCategoryNotShippableException extends DomainException {
  readonly code = 'FEED_CATEGORY_NOT_SHIPPABLE';
  readonly httpStatus = HttpStatus.BAD_REQUEST;
  constructor() {
    super('The country-wide feed only covers shippable categories.');
  }
}

export class FeedFiltersNeedFieldsException extends DomainException {
  readonly code = 'FEED_FILTERS_NOT_SUPPORTED';
  readonly httpStatus = HttpStatus.BAD_REQUEST;
  constructor() {
    super('This category has no custom fields to filter on.');
  }
}
