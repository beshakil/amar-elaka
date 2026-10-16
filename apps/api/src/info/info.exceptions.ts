import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';
import { sqlStateOf } from '../common/utils/sql-state';
import { sqlDetailOf } from '../verification/verification.exceptions';

/**
 * Typed errors for the local information services (ADR 064). The AE9xx
 * states come from the 0060 functions; `issues.reason` is the function's
 * DETAIL, so clients can show the right Bengali sentence.
 */

abstract class ReasonedException extends DomainException {
  constructor(
    readonly issues: { reason: string },
    message: string,
  ) {
    super(message);
  }
}

/** cap: the donor was contacted blood_donor_daily_contact_cap times today; unavailable; self; request. */
export class DonorContactRefusedException extends ReasonedException {
  readonly code = 'DONOR_CONTACT_REFUSED';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  constructor(reason: string) {
    super({ reason }, `This donor can't be contacted now (${reason}).`);
  }
}

export class BloodRequestRefusedException extends ReasonedException {
  readonly code = 'BLOOD_REQUEST_REFUSED';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  constructor(reason: string) {
    super({ reason }, `That can't be done with this blood request (${reason}).`);
  }
}

/** role: not staff or a field agent; date: outside today..backdate; item: not on the board; price. */
export class BazarEntryRefusedException extends ReasonedException {
  readonly code = 'BAZAR_ENTRY_REFUSED';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  constructor(reason: string) {
    super({ reason }, `These prices can't be saved (${reason}).`);
  }
}

/** The agricultural board where agri_services_enabled is off. */
export class BazarBoardDisabledException extends DomainException {
  readonly code = 'INFO_SERVICE_DISABLED';
  readonly httpStatus = HttpStatus.NOT_FOUND;
  constructor() {
    super('This service is not offered in this area.');
  }
}

export class DonorNotFoundException extends DomainException {
  readonly code = 'DONOR_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;
  constructor() {
    super('Donor not found.');
  }
}

/** The caller isn't registered as a donor in this area. */
export class DonorNotRegisteredException extends DomainException {
  readonly code = 'DONOR_NOT_REGISTERED';
  readonly httpStatus = HttpStatus.NOT_FOUND;
  constructor() {
    super('You are not registered as a blood donor here.');
  }
}

export class BloodRequestNotFoundException extends DomainException {
  readonly code = 'BLOOD_REQUEST_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;
  constructor() {
    super('Blood request not found.');
  }
}

export class EmergencyContactNotFoundException extends DomainException {
  readonly code = 'EMERGENCY_CONTACT_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;
  constructor() {
    super('Emergency contact not found.');
  }
}

/** A field that needs the area's staff (or a field agent, where they may). */
export class InfoStaffOnlyException extends DomainException {
  readonly code = 'INFO_STAFF_ONLY';
  readonly httpStatus = HttpStatus.FORBIDDEN;
  constructor() {
    super('Only the area team can do this.');
  }
}

export class InfoAreaRequiredException extends DomainException {
  readonly code = 'INFO_AREA_REQUIRED';
  readonly httpStatus = HttpStatus.BAD_REQUEST;
  constructor() {
    super('Open this from an area.');
  }
}

/** SQLSTATE + DETAIL → typed error; undefined when the error is not one of ours. */
export function infoError(
  state: string | undefined,
  detail: string | undefined,
): Error | undefined {
  const reason = detail ?? 'unknown';
  switch (state) {
    case 'AE901':
      return new DonorContactRefusedException(reason);
    case 'AE902':
      return new BloodRequestRefusedException(reason);
    case 'AE903':
      return new BazarEntryRefusedException(reason);
    case '42501':
      return new InfoStaffOnlyException();
    default:
      return undefined;
  }
}

/** Runs database work and turns AE9xx / 42501 into typed errors. */
export async function mapInfoErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw infoError(sqlStateOf(error), sqlDetailOf(error)) ?? error;
  }
}
