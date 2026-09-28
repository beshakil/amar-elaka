import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';

export class SearchCategoryNotFoundException extends DomainException {
  readonly code = 'SEARCH_CATEGORY_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;
  constructor() {
    super('No active category has this slug.');
  }
}

export class SearchAreaNotFoundException extends DomainException {
  readonly code = 'SEARCH_AREA_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;
  constructor() {
    super('No active area of this tenant has this slug.');
  }
}

export class SearchCursorInvalidException extends DomainException {
  readonly code = 'SEARCH_CURSOR_INVALID';
  readonly httpStatus = HttpStatus.BAD_REQUEST;
  constructor() {
    super('This cursor is invalid or belongs to a different search.');
  }
}

export class SearchCategoryNotShippableException extends DomainException {
  readonly code = 'SEARCH_CATEGORY_NOT_SHIPPABLE';
  readonly httpStatus = HttpStatus.BAD_REQUEST;
  constructor() {
    super('This category does not ship nationwide, so it has no country-wide search.');
  }
}

export class SearchFiltersNeedFieldsException extends DomainException {
  readonly code = 'SEARCH_FILTERS_NOT_SUPPORTED';
  readonly httpStatus = HttpStatus.BAD_REQUEST;
  constructor() {
    super('This category has no custom fields to filter on.');
  }
}
