import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';

export class UploadRateLimitedException extends DomainException {
  readonly code = 'UPLOAD_RATE_LIMITED';
  readonly httpStatus = HttpStatus.TOO_MANY_REQUESTS;

  constructor() {
    super('Too many uploads for now. Please try again later.');
  }
}

/** Confirm was called before the file reached storage (or the PUT failed). */
export class UploadMissingException extends DomainException {
  readonly code = 'UPLOAD_MISSING';
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor() {
    super('The file has not been uploaded yet.');
  }
}

/** The stored bytes aren't the type (or size) that was declared. */
export class UploadRejectedException extends DomainException {
  readonly code = 'UPLOAD_REJECTED';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor(readonly reason: 'not_an_image' | 'wrong_type' | 'size_mismatch') {
    super(
      reason === 'size_mismatch'
        ? 'The uploaded file does not match the declared size.'
        : 'The uploaded file is not a supported image or file type.',
    );
  }
}
