import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';

/** Hard removal would scrub content a legal hold must preserve (ADR 012). Nothing was changed. */
export class LegalHoldBlocksScrubException extends DomainException {
  readonly code = 'LEGAL_HOLD_BLOCKS_SCRUB';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super(
      'This post is under a legal hold and cannot be scrubbed. Use an ordinary remove; ' +
        'it is scrubbed if the hold is released.',
    );
  }
}

export class ModerationPostNotFoundException extends DomainException {
  readonly code = 'MODERATION_POST_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('No such post in this area.');
  }
}

export class BulkTooLargeException extends DomainException {
  readonly code = 'MODERATION_BULK_TOO_LARGE';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { max: number };

  constructor(max: number) {
    super(`A bulk request can act on at most ${max} posts.`);
    this.issues = { max };
  }
}
