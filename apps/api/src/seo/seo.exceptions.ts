import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';

/** The search engine couldn't count listings; the landing-page list is unknown right now. */
export class SeoSearchUnavailableException extends DomainException {
  readonly code = 'SEARCH_UNAVAILABLE';
  readonly httpStatus = HttpStatus.SERVICE_UNAVAILABLE;

  constructor() {
    super('Listing counts are unavailable right now.');
  }
}

/** No shareable image for a post the public can't see. */
export class OgImageNotFoundException extends DomainException {
  readonly code = 'OG_IMAGE_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('No image for this listing.');
  }
}
