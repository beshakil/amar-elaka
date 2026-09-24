import { createHmac, randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { SettingsService } from '../../settings/settings.service';
import {
  OtpCooldownException,
  OtpExpiredException,
  OtpIncorrectException,
  OtpIpDailyLimitException,
  OtpPhoneDailyLimitException,
  OtpTooManyAttemptsException,
} from '../exceptions/auth.exceptions';
import { OTP_STORE, type OtpStore } from './otp-store.ports';
import { SMS_PROVIDER, type SmsProvider } from './sms/sms-provider.interface';
import { otpMessage } from './sms/otp-message.templates';

// settings-exempt: seconds in a day — the rolling-window length "per day" describes, not a tunable threshold.
const ONE_DAY_SECONDS = 24 * 60 * 60;

function otpKey(phone: string): string {
  return `otp:code:${phone}`;
}
function cooldownKey(phone: string): string {
  return `otp:cooldown:${phone}`;
}
function phoneDailyKey(phone: string): string {
  return `otp:daily:phone:${phone}`;
}
function ipDailyKey(ip: string): string {
  return `otp:daily:ip:${ip}`;
}

@Injectable()
export class OtpService {
  constructor(
    @Inject(OTP_STORE) private readonly store: OtpStore,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    private readonly settings: SettingsService,
    @Inject(APP_CONFIG) private readonly env: Pick<Env, 'JWT_SECRET'>,
  ) {}

  /**
   * Cooldown, then per-phone, then per-IP daily limits, each an atomic
   * increment-then-compare against Redis. A request rejected by a later
   * check has already consumed the earlier ones' quota — a deliberate
   * trade-off: it only ever makes the limiter stricter, never lets more
   * OTPs through than configured.
   */
  async requestOtp(phone: string, ip: string): Promise<void> {
    const cooldownSeconds = await this.settings.get('otp_resend_cooldown_seconds');
    if (!(await this.store.trySetCooldown(cooldownKey(phone), cooldownSeconds))) {
      throw new OtpCooldownException();
    }

    const maxPerPhone = await this.settings.get('otp_max_requests_per_phone_per_day');
    const phoneCount = await this.store.incrementWindowedCounter(
      phoneDailyKey(phone),
      ONE_DAY_SECONDS,
    );
    if (phoneCount > maxPerPhone) {
      throw new OtpPhoneDailyLimitException();
    }

    const maxPerIp = await this.settings.get('otp_max_requests_per_ip_per_day');
    const ipCount = await this.store.incrementWindowedCounter(ipDailyKey(ip), ONE_DAY_SECONDS);
    if (ipCount > maxPerIp) {
      throw new OtpIpDailyLimitException();
    }

    const codeLength = await this.settings.get('otp_code_length');
    const ttlSeconds = await this.settings.get('otp_ttl_seconds');
    const code = this.generateCode(codeLength);

    await this.store.createOtp(otpKey(phone), this.hashCode(phone, code), ttlSeconds);
    await this.sms.send(phone, otpMessage(code));
  }

  /** Single-use: the OTP record is deleted on both success and exhausted-attempts failure. */
  async verifyOtp(phone: string, code: string): Promise<void> {
    const record = await this.store.getOtp(otpKey(phone));
    if (!record) {
      throw new OtpExpiredException();
    }

    if (record.codeHash !== this.hashCode(phone, code)) {
      const maxAttempts = await this.settings.get('otp_max_attempts');
      const attempts = await this.store.incrementAttempts(otpKey(phone));
      if (attempts >= maxAttempts) {
        await this.store.deleteOtp(otpKey(phone));
        throw new OtpTooManyAttemptsException();
      }
      throw new OtpIncorrectException(maxAttempts - attempts);
    }

    await this.store.deleteOtp(otpKey(phone));
  }

  private generateCode(length: number): string {
    // settings-exempt: base 10 (decimal digits), not a business threshold.
    const max = 10 ** length;
    return String(randomInt(max)).padStart(length, '0');
  }

  /** HMAC-SHA256 keyed with JWT_SECRET, domain-separated by phone so the same code for two phones never hashes the same. */
  private hashCode(phone: string, code: string): string {
    return createHmac('sha256', this.env.JWT_SECRET).update(`otp:${phone}:${code}`).digest('hex');
  }
}
