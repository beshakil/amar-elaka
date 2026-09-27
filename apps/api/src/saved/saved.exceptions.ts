import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';

/** Missing, or not something the public can see — deliberately the same answer. */
export class SavedTargetNotFoundException extends DomainException {
  readonly code = 'SAVED_TARGET_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;
  readonly issues: { itemType: string };

  constructor(itemType: string) {
    super(`No such ${itemType} to save.`);
    this.issues = { itemType };
  }
}

/** Saving your own post or store would only inflate its own counter. */
export class SaveOwnItemException extends DomainException {
  readonly code = 'SAVE_OWN_ITEM';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super('This is your own; there is no need to save it.');
  }
}

export class StoreNotFoundException extends DomainException {
  readonly code = 'STORE_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('Store not found.');
  }
}

export class FollowOwnStoreException extends DomainException {
  readonly code = 'FOLLOW_OWN_STORE';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super("You can't follow your own store.");
  }
}
