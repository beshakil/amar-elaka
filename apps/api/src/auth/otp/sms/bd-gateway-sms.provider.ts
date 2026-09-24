import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { DomainException } from '../../../common/exceptions/domain-exception';
import { APP_CONFIG } from '../../../config/config.module';
import type { Env } from '../../../config/env.schema';
import type { SmsProvider } from './sms-provider.interface';

export class SmsProviderNotConfiguredException extends DomainException {
  readonly code = 'SMS_PROVIDER_NOT_CONFIGURED';
  readonly httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;

  constructor() {
    super('The SMS gateway is not yet configured.');
  }
}

/**
 * Stub for a real Bangladeshi SMS gateway (SMS_API_URL/SMS_API_KEY/
 * SMS_SENDER_ID are already reserved in env.schema.ts). Shaped so swapping
 * in a real HTTP call later is a one-file change — SMS_PROVIDER picks this
 * class over LocalSmsProvider (see sms-provider.module.ts), nothing else in
 * the auth module needs to change.
 *
 * Not implemented yet: per CLAUDE.md rule 5, the real call must go through a
 * typed error + timeout + retry (withTimeout/withRetry, common/utils), never
 * a bare fetch — left for whoever wires up the actual gateway contract.
 */
@Injectable()
export class BdGatewaySmsProvider implements SmsProvider {
  constructor(
    @Inject(APP_CONFIG)
    private readonly env: Pick<Env, 'SMS_API_URL' | 'SMS_API_KEY' | 'SMS_SENDER_ID'>,
  ) {}

  send(_phoneE164: string, _message: string): Promise<void> {
    // No gateway contract to call yet — env.SMS_API_URL/SMS_API_KEY/SMS_SENDER_ID
    // are reserved but unused until a real provider is integrated here.
    void this.env;
    throw new SmsProviderNotConfiguredException();
  }
}
