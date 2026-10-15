import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';

/**
 * Typed errors for bans, appeals, the blacklist and complaints (ADR 063).
 * Each maps one AE8xx state from the 0059 functions; `issues.reason` is the
 * function's DETAIL, so clients can show the right Bengali sentence.
 */

abstract class ReasonedException extends DomainException {
  constructor(
    readonly issues: { reason: string },
    message: string,
  ) {
    super(message);
  }
}

export class BanNotAllowedException extends ReasonedException {
  readonly code = 'BAN_NOT_ALLOWED';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  constructor(reason: string) {
    super({ reason }, `This ban can't be issued (${reason}).`);
  }
}

export class BanNotFoundException extends DomainException {
  readonly code = 'BAN_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;
  constructor() {
    super('No such active ban.');
  }
}

export class AppealNotAllowedException extends ReasonedException {
  readonly code = 'APPEAL_NOT_ALLOWED';
  readonly httpStatus = HttpStatus.CONFLICT;
  constructor(reason: string) {
    super({ reason }, `This appeal can't be made (${reason}).`);
  }
}

export class AppealDecisionInvalidException extends ReasonedException {
  readonly code = 'APPEAL_DECISION_INVALID';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  constructor(reason: string) {
    super({ reason }, `That decision doesn't fit this appeal (${reason}).`);
  }
}

/** The OTP or the appeal token didn't check out (the public path). */
export class AppealVerificationFailedException extends DomainException {
  readonly code = 'APPEAL_VERIFICATION_FAILED';
  readonly httpStatus = HttpStatus.UNAUTHORIZED;
  constructor() {
    super('The code is wrong or expired. Ask for a new one.');
  }
}

export class BlacklistNotAllowedException extends ReasonedException {
  readonly code = 'BLACKLIST_NOT_ALLOWED';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  constructor(reason: string) {
    super({ reason }, `That blacklist change can't be made (${reason}).`);
  }
}

export class ComplaintNotAllowedException extends ReasonedException {
  readonly code = 'COMPLAINT_NOT_ALLOWED';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  constructor(reason: string) {
    super({ reason }, `This complaint can't be filed (${reason}).`);
  }
}

export class ComplaintUpdateInvalidException extends ReasonedException {
  readonly code = 'COMPLAINT_UPDATE_INVALID';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  constructor(reason: string) {
    super({ reason }, `That change doesn't fit this complaint (${reason}).`);
  }
}

/** The database refused the caller's role (insufficient_privilege): not their decision to make. */
export class BanActionForbiddenException extends DomainException {
  readonly code = 'BAN_ACTION_FORBIDDEN';
  readonly httpStatus = HttpStatus.FORBIDDEN;
  constructor() {
    super('You are not allowed to do this.');
  }
}

/** SQLSTATE + DETAIL → typed error; undefined when the error is not one of ours. */
export function banError(state: string | undefined, detail: string | undefined): Error | undefined {
  const reason = detail ?? 'unknown';
  switch (state) {
    case 'AE801':
      return new BanNotAllowedException(reason);
    case 'AE802':
      return new BanNotFoundException();
    case 'AE803':
      return new AppealNotAllowedException(reason);
    case 'AE804':
      return new AppealDecisionInvalidException(reason);
    case 'AE805':
      return new BlacklistNotAllowedException(reason);
    case 'AE806':
      return new ComplaintNotAllowedException(reason);
    case 'AE807':
      return new ComplaintUpdateInvalidException(reason);
    case '42501':
      return new BanActionForbiddenException();
    default:
      return undefined;
  }
}
