import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';

/** The caller is not an active field agent in this area. */
export class AgentNotActiveException extends DomainException {
  readonly code = 'AGENT_NOT_ACTIVE';
  readonly httpStatus = HttpStatus.FORBIDDEN;

  constructor() {
    super('Field agent mode is for active field agents of this area.');
  }
}

/** Managing agents is for the area's staff (writes: its admins). */
export class AgentAdminOnlyException extends DomainException {
  readonly code = 'AGENT_ADMIN_ONLY';
  readonly httpStatus = HttpStatus.FORBIDDEN;

  constructor() {
    super('Only the area team can manage field agents.');
  }
}

export class AgentNotFoundException extends DomainException {
  readonly code = 'AGENT_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('This field agent does not exist.');
  }
}

/** The GPS fix was not accurate enough (agent_min_gps_accuracy_m). */
export class AgentGpsTooInaccurateException extends DomainException {
  readonly code = 'AGENT_GPS_TOO_INACCURATE';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { maxAccuracyM: number };

  constructor(maxAccuracyM: number) {
    super(`The location must be accurate to ${maxAccuracyM} m or better.`);
    this.issues = { maxAccuracyM };
  }
}

/**
 * The submission can't be accepted as sent; `reason` says why (the phone
 * shows it and lets the agent fix the capture).
 */
export class AgentSubmissionRefusedException extends DomainException {
  readonly code = 'AGENT_SUBMISSION_REFUSED';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { reason: string };

  constructor(
    reason:
      | 'outside_area'
      | 'too_old'
      | 'in_future'
      | 'too_many_photos'
      | 'photos_not_ready'
      | 'category_invalid'
      | 'place_not_found'
      | 'task_not_found'
      | 'nothing_to_update'
      | 'update_pending'
      | 'id_taken',
  ) {
    super('This submission was refused.');
    this.issues = { reason };
  }
}

export class AgentTaskNotFoundException extends DomainException {
  readonly code = 'AGENT_TASK_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('This task does not exist or is already done.');
  }
}

/** The agent code is in use, or the member is already a field agent. */
export class AgentAlreadyExistsException extends DomainException {
  readonly code = 'AGENT_ALREADY_EXISTS';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super('This member is already a field agent, or the agent code is taken.');
  }
}
