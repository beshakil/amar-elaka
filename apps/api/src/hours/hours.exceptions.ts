import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';

export class HoursEntityNotFoundException extends DomainException {
  readonly code = 'HOURS_ENTITY_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('This place or store does not exist.');
  }
}

/** Hours are set by the people who may edit the place, or manage the store. */
export class NotHoursEditorException extends DomainException {
  readonly code = 'HOURS_NOT_EDITOR';
  readonly httpStatus = HttpStatus.FORBIDDEN;

  constructor() {
    super('Only its owner, managers or moderators can change these hours.');
  }
}

export class TooManyRangesPerDayException extends DomainException {
  readonly code = 'HOURS_TOO_MANY_RANGES';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { max: number; days: string[] };

  constructor(max: number, days: string[]) {
    super(`A day can have at most ${max} opening ranges.`);
    this.issues = { max, days };
  }
}

export class InvalidSpecialDaysException extends DomainException {
  readonly code = 'HOURS_SPECIAL_DAYS_INVALID';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: {
    reason: 'past' | 'duplicate' | 'too_many' | 'invalid_date';
    dates: string[];
    max?: number;
  };

  constructor(
    reason: 'past' | 'duplicate' | 'too_many' | 'invalid_date',
    dates: string[],
    max?: number,
  ) {
    super(
      reason === 'past'
        ? 'Special days must be today or later.'
        : reason === 'duplicate'
          ? 'Each date can appear once.'
          : reason === 'too_many'
            ? `At most ${max} upcoming special days.`
            : 'Some dates are not real calendar dates.',
    );
    this.issues = { reason, dates, ...(max === undefined ? {} : { max }) };
  }
}
