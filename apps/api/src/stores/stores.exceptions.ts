import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';
import type { SlugProblem } from './store-slug';

export class StoreNotFoundException extends DomainException {
  readonly code = 'STORE_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('Store not found.');
  }
}

/** The caller's role on the store doesn't allow this (editors only post as the store). */
export class StoreActionForbiddenException extends DomainException {
  readonly code = 'STORE_ACTION_FORBIDDEN';
  readonly httpStatus = HttpStatus.FORBIDDEN;
  readonly issues: { action: string; role: string | null };

  constructor(action: string, role: string | null) {
    super('Your role on this store does not allow this.');
    this.issues = { action, role };
  }
}

export class StoreSlugInvalidException extends DomainException {
  readonly code = 'STORE_SLUG_INVALID';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { problem: SlugProblem };

  constructor(problem: SlugProblem) {
    super('Use 3–60 lower-case English letters, digits and hyphens, like rahim-store.');
    this.issues = { problem };
  }
}

export class StoreSlugTakenException extends DomainException {
  readonly code = 'STORE_SLUG_TAKEN';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super('Another store in this area already uses this link.');
  }
}

export class StoreSlugAlreadyChangedException extends DomainException {
  readonly code = 'STORE_SLUG_ALREADY_CHANGED';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super("The store's link can be changed only once.");
  }
}

export class StoreLimitReachedException extends DomainException {
  readonly code = 'STORE_LIMIT_REACHED';
  readonly httpStatus = HttpStatus.CONFLICT;
  readonly issues: { max: number };

  constructor(max: number) {
    super(`You can own at most ${max} stores in this area.`);
    this.issues = { max };
  }
}

export class StoreStaffLimitReachedException extends DomainException {
  readonly code = 'STORE_STAFF_LIMIT_REACHED';
  readonly httpStatus = HttpStatus.CONFLICT;
  readonly issues: { max: number };

  constructor(max: number) {
    super(`This store can have at most ${max} staff.`);
    this.issues = { max };
  }
}

export class StoreCategoryInvalidException extends DomainException {
  readonly code = 'STORE_CATEGORY_INVALID';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor() {
    super('Choose an active shop category offered in this area.');
  }
}

export class StoreMediaInvalidException extends DomainException {
  readonly code = 'STORE_MEDIA_INVALID';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { mediaIds: string[] };

  constructor(mediaIds: string[]) {
    super('Upload the logo and banner again: they must be your own ready images in this area.');
    this.issues = { mediaIds };
  }
}

export class StorePhoneInvalidException extends DomainException {
  readonly code = 'STORE_PHONE_INVALID';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { field: 'phone' | 'whatsapp' };

  constructor(field: 'phone' | 'whatsapp') {
    super('Give a Bangladeshi mobile number like 01712345678.');
    this.issues = { field };
  }
}

export class StoreNameTooLongException extends DomainException {
  readonly code = 'STORE_NAME_TOO_LONG';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { field: 'nameBn' | 'nameEn'; max: number };

  constructor(field: 'nameBn' | 'nameEn', max: number) {
    super(`The name can be at most ${max} characters.`);
    this.issues = { field, max };
  }
}

export class StoreDescriptionTooLongException extends DomainException {
  readonly code = 'STORE_DESCRIPTION_TOO_LONG';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { max: number };

  constructor(max: number) {
    super(`The description can be at most ${max} characters.`);
    this.issues = { max };
  }
}

/** A store's area is fixed: a new location must stay in it. */
export class StoreLocationOutsideAreaException extends DomainException {
  readonly code = 'STORE_LOCATION_OUTSIDE_AREA';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor() {
    super("The new location is outside the store's area.");
  }
}

export class StoreNotActiveException extends DomainException {
  readonly code = 'STORE_NOT_ACTIVE';
  readonly httpStatus = HttpStatus.CONFLICT;
  readonly issues: { status: string };

  constructor(status: string) {
    super('This store is not active.');
    this.issues = { status };
  }
}

export class StoreAlreadyStaffException extends DomainException {
  readonly code = 'STORE_ALREADY_STAFF';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super('This number is already the owner or on the staff of this store.');
  }
}

export class StoreInviteeRefusedException extends DomainException {
  readonly code = 'STORE_INVITEE_REFUSED';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor() {
    super('This number cannot be added to a store.');
  }
}

export class StoreInvitationNotFoundException extends DomainException {
  readonly code = 'STORE_INVITATION_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('There is no invitation to this store waiting for you.');
  }
}

export class StoreStaffNotFoundException extends DomainException {
  readonly code = 'STORE_STAFF_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('This person is not on the staff of this store.');
  }
}

export class StoreStatusUnchangedException extends DomainException {
  readonly code = 'STORE_STATUS_UNCHANGED';
  readonly httpStatus = HttpStatus.CONFLICT;
  readonly issues: { status: string };

  constructor(status: string) {
    super(`The store is already ${status}.`);
    this.issues = { status };
  }
}

export class StoreReasonInvalidException extends DomainException {
  readonly code = 'STORE_REASON_INVALID';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor() {
    super('Choose a moderation reason.');
  }
}

/** Posting as a store: only its owner and staff who accepted (member_may_post_as_store, 0050). */
export class StoreMembershipRequiredException extends DomainException {
  readonly code = 'STORE_MEMBERSHIP_REQUIRED';
  readonly httpStatus = HttpStatus.FORBIDDEN;

  constructor() {
    super('Only the owner and staff of this store can post as it.');
  }
}

export class StoreCatalogFullException extends DomainException {
  readonly code = 'STORE_CATALOG_FULL';
  readonly httpStatus = HttpStatus.CONFLICT;
  readonly issues: { max: number };

  constructor(max: number) {
    super(`This store can hold at most ${max} posts at once.`);
    this.issues = { max };
  }
}

/** A store's posts are in its area: the post's location resolved to another one. */
export class PostStoreOutsideAreaException extends DomainException {
  readonly code = 'POST_STORE_OUTSIDE_AREA';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor() {
    super("A store's posts must be in the store's area.");
  }
}
