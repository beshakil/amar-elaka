import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';
import { sqlStateOf } from '../common/utils/sql-state';
import { sqlDetailOf } from '../verification/verification.exceptions';

/**
 * The info engine's typed errors (ADR 065). The AE91x states come from the
 * 0061 functions and triggers; `issues.reason` is their DETAIL, so clients
 * can show the right Bengali sentence.
 */

abstract class ReasonedException extends DomainException {
  constructor(
    readonly issues: { reason: string },
    message: string,
  ) {
    super(message);
  }
}

/** notice: type (not open to members) … */
export class NoticeRefusedException extends ReasonedException {
  readonly code = 'NOTICE_REFUSED';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  constructor(reason: string) {
    super({ reason }, `This notice can't be saved (${reason}).`);
  }
}

export class LostFoundRefusedException extends ReasonedException {
  readonly code = 'LOST_FOUND_REFUSED';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  constructor(reason: string) {
    super({ reason }, `That can't be done with this report (${reason}).`);
  }
}

export class OutageRefusedException extends ReasonedException {
  readonly code = 'OUTAGE_REFUSED';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  constructor(reason: string) {
    super({ reason }, `This outage can't be saved (${reason}).`);
  }
}

export class GovServiceRefusedException extends ReasonedException {
  readonly code = 'GOV_SERVICE_REFUSED';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  constructor(reason: string) {
    super({ reason }, `This guide entry can't be saved (${reason}).`);
  }
}

export class ModerationDecisionRefusedException extends ReasonedException {
  readonly code = 'INFO_DECISION_REFUSED';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  constructor(reason: string) {
    super({ reason }, `That decision doesn't fit this item (${reason}).`);
  }
}

export class InfoItemNotFoundException extends DomainException {
  readonly code = 'INFO_ITEM_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;
  constructor() {
    super('Not found.');
  }
}

/** A service this area doesn't offer (agriculture outside rural areas). */
export class InfoServiceDisabledException extends DomainException {
  readonly code = 'INFO_SERVICE_DISABLED';
  readonly httpStatus = HttpStatus.NOT_FOUND;
  constructor() {
    super('This service is not offered in this area.');
  }
}

export class InfoTeamOnlyException extends DomainException {
  readonly code = 'INFO_STAFF_ONLY';
  readonly httpStatus = HttpStatus.FORBIDDEN;
  constructor() {
    super('Only the area team can do this.');
  }
}

export class InfoEngineAreaRequiredException extends DomainException {
  readonly code = 'INFO_AREA_REQUIRED';
  readonly httpStatus = HttpStatus.BAD_REQUEST;
  constructor() {
    super('Open this from an area.');
  }
}

export function infoEngineError(
  state: string | undefined,
  detail: string | undefined,
): Error | undefined {
  const reason = detail ?? 'unknown';
  switch (state) {
    case 'AE910':
      return new NoticeRefusedException(reason);
    case 'AE911':
      return new LostFoundRefusedException(reason);
    case 'AE912':
      return new OutageRefusedException(reason);
    case 'AE913':
      return new GovServiceRefusedException(reason);
    case 'AE914':
      return new ModerationDecisionRefusedException(reason);
    case '23505':
      return new GovServiceRefusedException('slug_taken');
    case '42501':
      return new InfoTeamOnlyException();
    default:
      return undefined;
  }
}

/** Runs database work and turns AE91x / 42501 into typed errors. */
export async function mapInfoEngineErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw infoEngineError(sqlStateOf(error), sqlDetailOf(error)) ?? error;
  }
}
