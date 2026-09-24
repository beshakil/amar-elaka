import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';

/**
 * A setting that code asks for has no row in `platform_settings`. This is a
 * deployment error (registry and seed out of sync), never a client error, so
 * the client only ever sees a generic configuration message.
 */
export class SettingNotFoundException extends DomainException {
  readonly code = 'SETTING_NOT_FOUND';
  readonly httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;

  constructor(readonly settingKey: string) {
    super('A required configuration value is unavailable.');
  }
}

/** A stored value (platform default or tenant override) fails its registry type. */
export class InvalidSettingValueException extends DomainException {
  readonly code = 'SETTING_INVALID';
  readonly httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;

  constructor(
    readonly settingKey: string,
    readonly tenantId: string | undefined,
    cause: unknown,
  ) {
    super('A required configuration value is invalid.', { cause });
  }
}
