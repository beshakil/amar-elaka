import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';

export class StorageMisconfiguredException extends DomainException {
  readonly code = 'STORAGE_MISCONFIGURED';
  readonly httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;

  constructor(missingKey: string) {
    super(`Storage is misconfigured: ${missingKey} is not set.`);
  }
}

export class UnsupportedContentTypeException extends DomainException {
  readonly code = 'UNSUPPORTED_CONTENT_TYPE';
  readonly httpStatus = HttpStatus.BAD_REQUEST;

  constructor() {
    super('This content type is not accepted for the given media kind.');
  }
}

export class UploadTooLargeException extends DomainException {
  readonly code = 'UPLOAD_TOO_LARGE';
  readonly httpStatus = HttpStatus.BAD_REQUEST;

  constructor() {
    super('This upload exceeds the maximum allowed size.');
  }
}

export class MediaAssetNotFoundException extends DomainException {
  readonly code = 'MEDIA_ASSET_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('Media asset not found.');
  }
}

/** Object storage didn't answer in time or failed after retries (CLAUDE.md rule 5). */
export class StorageUnavailableException extends DomainException {
  readonly code = 'STORAGE_UNAVAILABLE';
  readonly httpStatus = HttpStatus.SERVICE_UNAVAILABLE;

  constructor(cause: unknown) {
    super('File storage is temporarily unavailable. Please try again.', { cause });
  }
}
