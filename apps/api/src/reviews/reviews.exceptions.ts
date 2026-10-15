import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';
import type { EligibilityStatus } from './dto/reviews.dto';

/**
 * Reviews' typed errors (ADR 061). Clients show the Bengali text for the
 * code; `issues` carries what they need for it (e.g. when a review opens).
 */

/** The anti-fake rule said no: no contact, too soon, too late, own store… */
export class ReviewNotEligibleException extends DomainException {
  readonly code = 'REVIEW_NOT_ELIGIBLE';
  readonly httpStatus = HttpStatus.FORBIDDEN;

  constructor(
    readonly issues: {
      status: EligibilityStatus;
      eligibleAt: string | null;
      expiresAt: string | null;
    },
  ) {
    super(`Not eligible to review this store (${issues.status}).`);
  }
}

export class ReviewNotFoundException extends DomainException {
  readonly code = 'REVIEW_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('Review not found.');
  }
}

export class ReviewStoreNotFoundException extends DomainException {
  readonly code = 'REVIEW_STORE_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('Store not found.');
  }
}

export class ReviewEditWindowOverException extends DomainException {
  readonly code = 'REVIEW_EDIT_WINDOW_OVER';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super('This review can no longer be edited.');
  }
}

/** A moderator hid or removed it: an edit can't undo that. */
export class ReviewDecidedException extends DomainException {
  readonly code = 'REVIEW_DECIDED_BY_MODERATOR';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super('A moderator has decided this review.');
  }
}

export class ReviewTextTooLongException extends DomainException {
  readonly code = 'REVIEW_TEXT_TOO_LONG';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor(readonly issues: { max: number }) {
    super(`Text can be at most ${issues.max} characters.`);
  }
}

export class ReviewPhotosInvalidException extends DomainException {
  readonly code = 'REVIEW_PHOTOS_INVALID';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor(readonly issues: { max: number }) {
    super('Use at most the allowed number of your own uploaded, processed photos.');
  }
}

/** Only the store's owner and accepted managers reply. */
export class ReviewReplyForbiddenException extends DomainException {
  readonly code = 'REVIEW_REPLY_FORBIDDEN';
  readonly httpStatus = HttpStatus.FORBIDDEN;

  constructor() {
    super('Only the store can reply to its reviews.');
  }
}

export class ReviewOwnReportException extends DomainException {
  readonly code = 'REVIEW_OWN';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor() {
    super('You cannot report your own review.');
  }
}

export class ReviewAuthorUnderLegalHoldException extends DomainException {
  readonly code = 'REVIEW_AUTHOR_UNDER_LEGAL_HOLD';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super('The user is under a legal hold; nothing was scrubbed.');
  }
}
