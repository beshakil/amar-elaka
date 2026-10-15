import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';

/** Verification's typed errors (ADR 062). Clients show the Bengali text for the code. */

export const NOT_ALLOWED_REASONS = [
  'no_member',
  'phone_unverified',
  'identity_required',
  'open_request',
  'already_verified',
  'not_owner',
  'store_inactive',
] as const;
export type NotAllowedReason = (typeof NOT_ALLOWED_REASONS)[number];

export class VerificationNotAllowedException extends DomainException {
  readonly code = 'VERIFICATION_NOT_ALLOWED';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor(readonly issues: { reason: NotAllowedReason }) {
    super(`A verification can't be requested now (${issues.reason}).`);
  }
}

/** The NID number isn't one: 10, 13 or 17 digits. The number itself is never echoed. */
export class VerificationNidInvalidException extends DomainException {
  readonly code = 'VERIFICATION_NID_INVALID';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor() {
    super('The NID number must have 10, 13 or 17 digits.');
  }
}

export class VerificationEvidenceInvalidException extends DomainException {
  readonly code = 'VERIFICATION_EVIDENCE_INVALID';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor(readonly issues: { kind: string }) {
    super('Upload the photo or document first (yours, processed, not used elsewhere).');
  }
}

export class VerificationNotFoundException extends DomainException {
  readonly code = 'VERIFICATION_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('No such open verification request.');
  }
}

export class VerificationDecisionInvalidException extends DomainException {
  readonly code = 'VERIFICATION_DECISION_INVALID';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor() {
    super(
      'That decision does not fit this request (a rejection needs a reason; a visit is for businesses; the expiry must be in the future).',
    );
  }
}

export class VerificationStoreNotFoundException extends DomainException {
  readonly code = 'VERIFICATION_STORE_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('Store not found.');
  }
}

/** sqlState → typed error; the detail of AE701 names the reason. */
export function verificationError(
  state: string | undefined,
  detail: string | undefined,
): Error | undefined {
  switch (state) {
    case 'AE701':
      return new VerificationNotAllowedException({
        reason: (NOT_ALLOWED_REASONS as readonly string[]).includes(detail ?? '')
          ? (detail as NotAllowedReason)
          : 'no_member',
      });
    case 'AE702':
      return new VerificationEvidenceInvalidException({ kind: detail ?? 'evidence' });
    case 'AE703':
      return new VerificationNotFoundException();
    case 'AE704':
      return new VerificationDecisionInvalidException();
    default:
      return undefined;
  }
}

/** The Postgres error's DETAIL, walking the cause chain like sqlStateOf. */
export function sqlDetailOf(error: unknown): string | undefined {
  for (let current: unknown = error; current;) {
    if (typeof current === 'object' && 'detail' in current && typeof current.detail === 'string') {
      return current.detail;
    }
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}
