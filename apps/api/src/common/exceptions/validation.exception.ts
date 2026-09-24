import type { ZodError } from 'zod';
import { DomainException } from './domain-exception';

export interface ValidationIssue {
  path: string;
  message: string;
}

export class ValidationException extends DomainException {
  readonly code = 'VALIDATION_FAILED';
  readonly httpStatus = 400;
  readonly issues: ValidationIssue[];

  constructor(error: ZodError) {
    super('Request validation failed');
    this.issues = error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
  }
}
