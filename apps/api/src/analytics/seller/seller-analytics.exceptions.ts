import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/exceptions/domain-exception';

export class AnalyticsPeriodInvalidException extends DomainException {
  readonly code = 'ANALYTICS_PERIOD_INVALID';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { available: number[] };

  constructor(available: number[]) {
    super(`Choose one of: ${available.map((d) => `${d}d`).join(', ')}.`);
    this.issues = { available };
  }
}

/** A store's numbers are its owner's and managers' (seller_scope_posts, 0051). */
export class AnalyticsForbiddenException extends DomainException {
  readonly code = 'ANALYTICS_FORBIDDEN';
  readonly httpStatus = HttpStatus.FORBIDDEN;

  constructor() {
    super("Only the store's owner and managers can see its numbers.");
  }
}

export class AnalyticsStoreNotFoundException extends DomainException {
  readonly code = 'STORE_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('Store not found.');
  }
}
