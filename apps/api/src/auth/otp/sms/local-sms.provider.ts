import { Injectable, Logger } from '@nestjs/common';
import type { SmsProvider } from './sms-provider.interface';

/** Dev/test default (SMS_PROVIDER=local): logs instead of sending, so the OTP is visible in the console. */
@Injectable()
export class LocalSmsProvider implements SmsProvider {
  private readonly logger = new Logger(LocalSmsProvider.name);

  send(phoneE164: string, message: string): Promise<void> {
    this.logger.log(`[LocalSmsProvider] to ${phoneE164}: ${message}`);
    return Promise.resolve();
  }
}
