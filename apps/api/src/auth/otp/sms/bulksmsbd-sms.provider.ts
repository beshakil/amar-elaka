import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { DomainException } from '../../../common/exceptions/domain-exception';
import { APP_CONFIG } from '../../../config/config.module';
import type { Env } from '../../../config/env.schema';
import type { SmsProvider } from './sms-provider.interface';

/** BulkSMSBD's single-message endpoint (POST form). */
export const BULKSMSBD_DEFAULT_URL = 'https://bulksmsbd.net/api/smsapi';

// settings-exempt: the gateway's protocol code for "accepted"
const BULKSMSBD_ACCEPTED = 202;
// settings-exempt: the gateway's protocol code for its own internal error
const BULKSMSBD_INTERNAL_ERROR = 1005;
// settings-exempt: one retry (CLAUDE.md rule 5)
const ATTEMPTS = 2;
// settings-exempt: pause before the retry
const RETRY_DELAY_MS = 500;
// settings-exempt: HTTP status classes
const HTTP_SERVER_ERROR = 500;

/**
 * The message didn't leave: the caller (OTP request) answers 503 so the app
 * asks the user to try again. `reason` goes to the logs only.
 */
export class SmsDeliveryFailedException extends DomainException {
  readonly code = 'SMS_DELIVERY_FAILED';
  readonly httpStatus = HttpStatus.SERVICE_UNAVAILABLE;

  constructor(readonly reason: string) {
    super('The SMS could not be sent. Please try again.');
  }
}

const responseSchema = z.object({
  response_code: z.coerce.number(),
  success_message: z.string().optional().nullable(),
  error_message: z.string().optional().nullable(),
  message_id: z.union([z.string(), z.number()]).optional().nullable(),
});

/** +8801711000001 → 8801711000001: BulkSMSBD takes the number without the plus. */
export function bulkSmsBdNumber(phoneE164: string): string {
  return phoneE164.replace(/^\+/, '');
}

/**
 * Sends through BulkSMSBD (ADR 053): POST `api_key`, `senderid`, `number`,
 * `message` to /api/smsapi; `response_code` 202 means accepted, 1001–1032 are
 * account or request problems. A timeout, a network error, a 5xx or the
 * gateway's own "internal error" (1005) is retried once; anything else is a
 * configuration or number problem that a retry won't fix. The API key never
 * reaches a log line.
 */
@Injectable()
export class BulkSmsBdProvider implements SmsProvider {
  private readonly url: string;

  constructor(
    @Inject(APP_CONFIG)
    private readonly env: Pick<
      Env,
      'SMS_API_URL' | 'SMS_API_KEY' | 'SMS_SENDER_ID' | 'SMS_TIMEOUT_MS'
    >,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BulkSmsBdProvider.name);
    this.url = env.SMS_API_URL || BULKSMSBD_DEFAULT_URL;
  }

  async send(phoneE164: string, message: string): Promise<void> {
    const body = new URLSearchParams({
      api_key: this.env.SMS_API_KEY,
      senderid: this.env.SMS_SENDER_ID,
      number: bulkSmsBdNumber(phoneE164),
      message,
    });
    let reason = 'network';
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      let response: Response;
      try {
        response = await fetch(this.url, {
          method: 'POST',
          headers: { accept: 'application/json' },
          body,
          signal: AbortSignal.timeout(this.env.SMS_TIMEOUT_MS),
        });
      } catch (error) {
        reason = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network';
        continue;
      }
      if (response.status >= HTTP_SERVER_ERROR) {
        reason = `http_${response.status}`;
        continue;
      }
      const parsed = responseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) {
        reason = `bad_response_http_${response.status}`;
        break;
      }
      const code = parsed.data.response_code;
      if (code === BULKSMSBD_ACCEPTED) return;
      reason = `bulksmsbd_${code}`;
      this.logger.warn(
        { code, error: parsed.data.error_message ?? parsed.data.success_message, attempt },
        'BulkSMSBD refused the message',
      );
      if (code !== BULKSMSBD_INTERNAL_ERROR) break;
    }
    this.logger.error({ reason }, 'SMS not sent');
    throw new SmsDeliveryFailedException(reason);
  }
}
