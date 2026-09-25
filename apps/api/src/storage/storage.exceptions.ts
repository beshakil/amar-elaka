import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';

export class StorageMisconfiguredException extends DomainException {
  readonly code = 'STORAGE_MISCONFIGURED';
  readonly httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;

  constructor(missingKey: string) {
    super(`Storage is misconfigured: ${missingKey} is not set.`);
  }
}

/** A caller asked for a public URL of an object in the private documents bucket. */
export class PrivateBucketException extends DomainException {
  readonly code = 'STORAGE_PRIVATE_BUCKET';
  readonly httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;

  constructor(bucket: string) {
    super(`The ${bucket} bucket is private; its objects have no public URL.`);
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

/** A local-driver upload URL that is forged, malformed or past its expiry (like a bad S3 signature). */
export class UploadGrantRejectedException extends DomainException {
  readonly code = 'UPLOAD_GRANT_REJECTED';
  readonly httpStatus = HttpStatus.FORBIDDEN;

  constructor(reason: string) {
    super(`This upload URL is not valid (${reason}). Request a new one.`);
  }
}

/** The PUT doesn't match what the upload URL was issued for (type or size). */
export class UploadDoesNotMatchGrantException extends DomainException {
  readonly code = 'UPLOAD_DOES_NOT_MATCH';
  readonly httpStatus = HttpStatus.BAD_REQUEST;

  constructor(what: 'content_type' | 'size') {
    super(
      `The upload's ${what === 'size' ? 'size' : 'content type'} doesn't match its upload URL.`,
    );
  }
}
