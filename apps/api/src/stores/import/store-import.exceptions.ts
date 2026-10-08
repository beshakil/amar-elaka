import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/exceptions/domain-exception';

export class ImportCategoryUnavailableException extends DomainException {
  readonly code = 'IMPORT_CATEGORY_UNAVAILABLE';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor() {
    super('Choose a category this area offers for posts.');
  }
}

/** The sheet or ZIP isn't the caller's confirmed `import` upload, or isn't processed yet. */
export class ImportFileInvalidException extends DomainException {
  readonly code = 'IMPORT_FILE_INVALID';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { file: 'sheet' | 'images'; reason: 'not_found' | 'not_ready' | 'wrong_type' };

  constructor(file: 'sheet' | 'images', reason: 'not_found' | 'not_ready' | 'wrong_type') {
    super(
      file === 'sheet' ? 'Upload the sheet (CSV or XLSX) again.' : 'Upload the photos ZIP again.',
    );
    this.issues = { file, reason };
  }
}

export class ImportNotFoundException extends DomainException {
  readonly code = 'IMPORT_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('Import not found.');
  }
}
