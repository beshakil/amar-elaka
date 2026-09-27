import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';

/** The seller turned this channel off (showPhone / showWhatsapp), or left no number. */
export class ContactChannelUnavailableException extends DomainException {
  readonly code = 'CONTACT_CHANNEL_UNAVAILABLE';
  readonly httpStatus = HttpStatus.CONFLICT;
  readonly issues: { channel: string };

  constructor(channel: string) {
    super(`The seller doesn't take contact by ${channel} on this post.`);
    this.issues = { channel };
  }
}

/** require_login_for_contact is on in the post's tenant and the caller is a guest. */
export class ContactLoginRequiredException extends DomainException {
  readonly code = 'CONTACT_LOGIN_REQUIRED';
  readonly httpStatus = HttpStatus.UNAUTHORIZED;

  constructor() {
    super('Sign in to see the seller’s contact.');
  }
}

/** contact_reveals_per_user_per_day reached. */
export class ContactLimitReachedException extends DomainException {
  readonly code = 'CONTACT_LIMIT_REACHED';
  readonly httpStatus = HttpStatus.TOO_MANY_REQUESTS;
  readonly issues: { max: number };

  constructor(max: number) {
    super(`At most ${max} contacts can be revealed in 24 hours.`);
    this.issues = { max };
  }
}

/** Only a live post takes contacts; a sold or pending one is shown, not sold to. */
export class ContactPostNotLiveException extends DomainException {
  readonly code = 'CONTACT_POST_NOT_LIVE';
  readonly httpStatus = HttpStatus.CONFLICT;
  readonly issues: { status: string };

  constructor(status: string) {
    super('This post is not taking contacts.');
    this.issues = { status };
  }
}

/** A seller can't contact themselves; the reveal would be a fake lead. */
export class ContactOwnPostException extends DomainException {
  readonly code = 'CONTACT_OWN_POST';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super('This is your own post.');
  }
}

export class ReportOwnPostException extends DomainException {
  readonly code = 'REPORT_OWN_POST';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super("You can't report your own post.");
  }
}

/** reports_per_user_per_day reached. */
export class ReportLimitReachedException extends DomainException {
  readonly code = 'REPORT_LIMIT_REACHED';
  readonly httpStatus = HttpStatus.TOO_MANY_REQUESTS;
  readonly issues: { max: number };

  constructor(max: number) {
    super(`At most ${max} reports can be filed in 24 hours.`);
    this.issues = { max };
  }
}

export class ReportDetailsTooLongException extends DomainException {
  readonly code = 'REPORT_DETAILS_TOO_LONG';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { max: number };

  constructor(max: number) {
    super(`A report's text can be at most ${max} characters.`);
    this.issues = { max };
  }
}

/** No share link with this code (or its post is gone). */
export class ShortLinkNotFoundException extends DomainException {
  readonly code = 'SHORT_LINK_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('This link does not exist.');
  }
}
