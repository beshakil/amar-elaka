import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';

export class PlaceNotFoundException extends DomainException {
  readonly code = 'PLACE_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('This place does not exist.');
  }
}

/** Editing a place, or reading its history, is for staff, agents and its claimed owner. */
export class NotPlaceEditorException extends DomainException {
  readonly code = 'PLACE_NOT_EDITOR';
  readonly httpStatus = HttpStatus.FORBIDDEN;

  constructor() {
    super('Only moderators, field agents and the verified owner can change this place.');
  }
}

export class PlaceLandmarkStaffOnlyException extends DomainException {
  readonly code = 'PLACE_LANDMARK_STAFF_ONLY';
  readonly httpStatus = HttpStatus.FORBIDDEN;

  constructor() {
    super('Only moderators can mark a place as a landmark.');
  }
}

export class PlaceCategoryInvalidException extends DomainException {
  readonly code = 'PLACE_CATEGORY_INVALID';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor() {
    super('Choose an active place category offered in this area.');
  }
}

export class PlaceNameTooLongException extends DomainException {
  readonly code = 'PLACE_NAME_TOO_LONG';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { field: 'nameBn' | 'nameEn'; max: number };

  constructor(field: 'nameBn' | 'nameEn', max: number) {
    super(`The name can be at most ${max} characters.`);
    this.issues = { field, max };
  }
}

export class PlacePhoneInvalidException extends DomainException {
  readonly code = 'PLACE_PHONE_INVALID';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { phones: string[] };

  constructor(phones: string[]) {
    super('Give a Bangladeshi mobile number like 01712345678.');
    this.issues = { phones };
  }
}

export class TooManyPlacePhonesException extends DomainException {
  readonly code = 'PLACE_TOO_MANY_PHONES';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { max: number };

  constructor(max: number) {
    super(`A place can list at most ${max} phone numbers.`);
    this.issues = { max };
  }
}

export class TooManyPlacePhotosException extends DomainException {
  readonly code = 'PLACE_TOO_MANY_PHOTOS';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { max: number };

  constructor(max: number) {
    super(`A place can carry at most ${max} photos.`);
    this.issues = { max };
  }
}

/** A media id that isn't the caller's own, ready, unattached file of the right kind, in the place's area. */
export class PlaceMediaInvalidException extends DomainException {
  readonly code = 'PLACE_MEDIA_INVALID';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { mediaIds: string[] };

  constructor(mediaIds: string[]) {
    super(
      'Some files are missing, still processing, not yours, of the wrong kind, or already used.',
    );
    this.issues = { mediaIds };
  }
}

/** A location edit that would move the place into another area's ownership. */
export class PlaceLocationOtherTenantException extends DomainException {
  readonly code = 'PLACE_LOCATION_OTHER_TENANT';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super('This location belongs to another area. Add the place there instead.');
  }
}

export class PlaceNotPendingException extends DomainException {
  readonly code = 'PLACE_NOT_PENDING';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super('This place is not waiting for review.');
  }
}

export class RevisionNotFoundException extends DomainException {
  readonly code = 'PLACE_REVISION_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('This revision does not exist.');
  }
}

export class RevisionNotRevertableException extends DomainException {
  readonly code = 'PLACE_REVISION_NOT_REVERTABLE';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super(
      'This revision changed nothing that can be reverted (status and ownership have their own flows).',
    );
  }
}

/** A field the revision changed has changed again since: revert the newer revision first. */
export class RevisionSupersededException extends DomainException {
  readonly code = 'PLACE_REVISION_SUPERSEDED';
  readonly httpStatus = HttpStatus.CONFLICT;
  readonly issues: { fields: string[] };

  constructor(fields: string[]) {
    super('These fields were changed again after this revision. Revert the newer change first.');
    this.issues = { fields };
  }
}

// ---- claims ----------------------------------------------------------------

export class PlaceAlreadyClaimedException extends DomainException {
  readonly code = 'PLACE_ALREADY_CLAIMED';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super('This place already has a verified owner.');
  }
}

export class PlaceNotClaimableException extends DomainException {
  readonly code = 'PLACE_NOT_CLAIMABLE';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super('This place can be claimed once it is published.');
  }
}

export class ClaimAlreadyPendingException extends DomainException {
  readonly code = 'CLAIM_ALREADY_PENDING';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super('You already have a claim on this place waiting for review.');
  }
}

export class ClaimEvidenceNotAcceptedException extends DomainException {
  readonly code = 'CLAIM_EVIDENCE_NOT_ACCEPTED';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { notAccepted: string[]; accepted: string[] };

  constructor(notAccepted: string[], accepted: string[]) {
    super('This area does not accept that kind of evidence for a claim.');
    this.issues = { notAccepted, accepted };
  }
}

export class ClaimPhoneUnavailableException extends DomainException {
  readonly code = 'CLAIM_PHONE_UNAVAILABLE';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor() {
    super('This place has no phone number to send a code to. Use another kind of evidence.');
  }
}

export class TooManyClaimDocumentsException extends DomainException {
  readonly code = 'CLAIM_TOO_MANY_DOCUMENTS';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { max: number };

  constructor(max: number) {
    super(`A claim can carry at most ${max} files.`);
    this.issues = { max };
  }
}

export class ClaimNoteTooLongException extends DomainException {
  readonly code = 'CLAIM_NOTE_TOO_LONG';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { max: number };

  constructor(max: number) {
    super(`The note can be at most ${max} characters.`);
    this.issues = { max };
  }
}

export class ClaimNotFoundException extends DomainException {
  readonly code = 'CLAIM_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('This claim does not exist.');
  }
}

export class ClaimNotPendingException extends DomainException {
  readonly code = 'CLAIM_NOT_PENDING';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super('This claim has already been decided.');
  }
}

export class ClaimStoreNotLinkableException extends DomainException {
  readonly code = 'CLAIM_STORE_NOT_LINKABLE';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor() {
    super("That store isn't the claimant's, or it is already another place's store.");
  }
}

/** A moderator can't decide their own claim; a claimant can't approve without a verified OTP. */
export class ClaimDecisionForbiddenException extends DomainException {
  readonly code = 'CLAIM_DECISION_FORBIDDEN';
  readonly httpStatus = HttpStatus.FORBIDDEN;

  constructor() {
    super('You cannot decide this claim.');
  }
}

/** Open/closed toggles apply to a published place only, not one under review or rejected. */
export class PlaceStatusLockedException extends DomainException {
  readonly code = 'PLACE_STATUS_LOCKED';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super('Only a published place can be marked open or closed.');
  }
}

// ---- duplicates and merging (ADR 048) --------------------------------------

export interface DuplicateCandidateIssue {
  placeId: string;
  tenantId: string;
  nameBn: string;
  nameEn: string | null;
  location: { lat: number; lng: number };
  distanceM: number;
  score: number;
  phoneMatch: boolean;
}

/**
 * "Is this the same place?" — a likely duplicate already exists nearby. The
 * client shows `candidates`; to add the place anyway, send it again with
 * `confirmNotDuplicate: true` (the pair still goes to a moderator).
 */
export class PlaceLikelyDuplicateException extends DomainException {
  readonly code = 'PLACE_LIKELY_DUPLICATE';
  readonly httpStatus = HttpStatus.CONFLICT;
  readonly issues: { candidates: DuplicateCandidateIssue[] };

  constructor(candidates: DuplicateCandidateIssue[]) {
    super('This place may already be on the map. Is it one of these?');
    this.issues = { candidates };
  }
}

export class DuplicateCandidateNotFoundException extends DomainException {
  readonly code = 'DUPLICATE_CANDIDATE_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('There is no open duplicate pair with this id.');
  }
}

export class PlaceNotMergeableException extends DomainException {
  readonly code = 'PLACE_NOT_MERGEABLE';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super('These places cannot be merged: the same place, deleted, or already merged.');
  }
}

export class PlaceMergeOwnersConflictException extends DomainException {
  readonly code = 'PLACE_MERGE_OWNERS_CONFLICT';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super('Both places have verified owners. Resolve the ownership before merging.');
  }
}

export class PlaceMergeNotFoundException extends DomainException {
  readonly code = 'PLACE_MERGE_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('This merge does not exist.');
  }
}

export class PlaceMergeUndoExpiredException extends DomainException {
  readonly code = 'PLACE_MERGE_UNDO_EXPIRED';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super('This merge can no longer be undone.');
  }
}

export class PlaceMergeAlreadyUndoneException extends DomainException {
  readonly code = 'PLACE_MERGE_ALREADY_UNDONE';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super('This merge was already undone.');
  }
}

export class PlaceMergeTargetGoneException extends DomainException {
  readonly code = 'PLACE_MERGE_TARGET_GONE';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super(
      'The place this was merged into has since been removed or merged again; undo that first.',
    );
  }
}
