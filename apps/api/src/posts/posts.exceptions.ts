import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';

export class IllegalPostTransitionException extends DomainException {
  readonly code = 'POST_ILLEGAL_TRANSITION';
  readonly httpStatus = HttpStatus.CONFLICT;
  readonly issues: { from: string; to: string; actor: string };

  constructor(from: string, to: string, actor: string) {
    super(`A post can't go from ${from} to ${to} (${actor}).`);
    this.issues = { from, to, actor };
  }
}

/** Missing, or not visible to this caller — deliberately the same answer. */
export class PostNotFoundException extends DomainException {
  readonly code = 'POST_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('Post not found.');
  }
}

/** Only the author may change a post through these endpoints. */
export class NotPostOwnerException extends DomainException {
  readonly code = 'POST_NOT_OWNER';
  readonly httpStatus = HttpStatus.FORBIDDEN;

  constructor() {
    super('Only the author can change this post.');
  }
}

/** Deleted or scrubbed posts can't be edited, submitted, sold, reposted or hidden. */
export class PostNotEditableException extends DomainException {
  readonly code = 'POST_NOT_EDITABLE';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor(reason: 'deleted' | 'scrubbed' | 'status' | 'sold') {
    super(
      reason === 'sold'
        ? 'A sold post stays as sales history and cannot be deleted. Hide it instead.'
        : `This post can't be changed (${reason}).`,
    );
  }
}

export class PostLimitReachedException extends DomainException {
  readonly code = 'POST_LIMIT_REACHED';
  readonly httpStatus = HttpStatus.TOO_MANY_REQUESTS;
  readonly issues: { limit: 'active' | 'daily'; max: number };

  constructor(limit: 'active' | 'daily', max: number) {
    super(
      limit === 'active'
        ? `You already have ${max} active posts. Mark one sold or delete one first.`
        : `You can create at most ${max} posts in 24 hours.`,
    );
    this.issues = { limit, max };
  }
}

export class PostTextTooLongException extends DomainException {
  readonly code = 'POST_TEXT_TOO_LONG';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { field: 'title' | 'description'; max: number };

  constructor(field: 'title' | 'description', max: number) {
    super(`The ${field} can be at most ${max} characters.`);
    this.issues = { field, max };
  }
}

export class TooManyPostMediaException extends DomainException {
  readonly code = 'POST_TOO_MANY_MEDIA';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { max: number };

  constructor(max: number) {
    super(`A post can carry at most ${max} photos.`);
    this.issues = { max };
  }
}

/** A mediaId that isn't the caller's own, ready, unattached photo. */
export class PostMediaInvalidException extends DomainException {
  readonly code = 'POST_MEDIA_INVALID';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { mediaIds: string[] };

  constructor(mediaIds: string[]) {
    super('Some photos are missing, still processing, not yours, or already used.');
    this.issues = { mediaIds };
  }
}

/**
 * The photos were uploaded under a different tenant than the one that will
 * own this post (a buffer-zone location). Upload them again with
 * X-Tenant-Id = `owningTenantId` (GET /posts/ownership says which, up front).
 */
export class PostMediaTenantMismatchException extends DomainException {
  readonly code = 'POST_MEDIA_TENANT_MISMATCH';
  readonly httpStatus = HttpStatus.CONFLICT;
  readonly issues: { owningTenantId: string; mediaIds: string[] };

  constructor(owningTenantId: string, mediaIds: string[]) {
    super(
      'These photos belong to another area. Upload them again for the area this post will be listed in.',
    );
    this.issues = { owningTenantId, mediaIds };
  }
}

export class IdempotencyKeyReusedException extends DomainException {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor() {
    super('This Idempotency-Key was already used for a different request.');
  }
}

export class IdempotentRequestInProgressException extends DomainException {
  readonly code = 'IDEMPOTENT_REQUEST_IN_PROGRESS';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super('The same request is still being processed. Try again in a moment.');
  }
}

/**
 * A live post can be renewed (one-tap repost) only inside the expiry-reminder
 * window (post_expiry_reminder_days before it expires), not at any time — a
 * renewal is not a free way to stay on top forever.
 */
export class PostRenewTooEarlyException extends DomainException {
  readonly code = 'POST_RENEW_TOO_EARLY';
  readonly httpStatus = HttpStatus.CONFLICT;
  readonly issues: { renewableFrom: string };

  constructor(renewableFrom: Date) {
    super('This post can be renewed closer to its expiry.');
    this.issues = { renewableFrom: renewableFrom.toISOString() };
  }
}

/** Stock is a store product's (ADR 057); a personal post has none. */
export class PostNotStoreProductException extends DomainException {
  readonly code = 'POST_NOT_STORE_PRODUCT';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super('Only a store’s product has a stock status.');
  }
}
