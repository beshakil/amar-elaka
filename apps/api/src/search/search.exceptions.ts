import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';

export class SearchCategoryNotFoundException extends DomainException {
  readonly code = 'SEARCH_CATEGORY_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;
  constructor() {
    super('No active category has this slug.');
  }
}

export class SearchFiltersNeedFieldsException extends DomainException {
  readonly code = 'SEARCH_FILTERS_NOT_SUPPORTED';
  readonly httpStatus = HttpStatus.BAD_REQUEST;
  constructor() {
    super('This category has no custom fields to filter on.');
  }
}
