import {
  OtpCooldownException,
  OtpExpiredException,
  OtpIncorrectException,
  OtpIpDailyLimitException,
  OtpPhoneDailyLimitException,
  OtpTooManyAttemptsException,
} from '../exceptions/auth.exceptions';
import type {
  SettingsClock,
  SettingsInvalidationBus,
  SettingsSource,
} from '../../settings/settings.ports';
import { SettingsService } from '../../settings/settings.service';
import type { OtpRecord, OtpStore } from './otp-store.ports';
import { OtpService } from './otp.service';
import type { SmsProvider } from './sms/sms-provider.interface';

const PLATFORM_SETTINGS = new Map<string, unknown>([
  ['otp_code_length', 6],
  ['otp_ttl_seconds', 300],
  ['otp_max_attempts', 3],
  ['otp_resend_cooldown_seconds', 60],
  ['otp_max_requests_per_phone_per_day', 5],
  ['otp_max_requests_per_ip_per_day', 20],
]);

class FakeSettingsSource implements SettingsSource {
  loadPlatformSettings(): Promise<ReadonlyMap<string, unknown>> {
    return Promise.resolve(new Map(PLATFORM_SETTINGS));
  }
  loadTenantOverrides(): Promise<ReadonlyMap<string, unknown>> {
    return Promise.resolve(new Map());
  }
}

class NoopBus implements SettingsInvalidationBus {
  publish(): Promise<void> {
    return Promise.resolve();
  }
  subscribe(): Promise<void> {
    return Promise.resolve();
  }
}

const fixedClock: SettingsClock = { now: () => 0 };

class FakeOtpStore implements OtpStore {
  records = new Map<string, OtpRecord>();
  cooldowns = new Set<string>();
  counters = new Map<string, number>();

  createOtp(key: string, codeHash: string): Promise<void> {
    this.records.set(key, { codeHash, attempts: 0 });
    return Promise.resolve();
  }
  getOtp(key: string): Promise<OtpRecord | undefined> {
    return Promise.resolve(this.records.get(key));
  }
  incrementAttempts(key: string): Promise<number> {
    const record = this.records.get(key);
    if (!record) return Promise.resolve(0);
    record.attempts += 1;
    return Promise.resolve(record.attempts);
  }
  deleteOtp(key: string): Promise<void> {
    this.records.delete(key);
    return Promise.resolve();
  }
  trySetCooldown(key: string): Promise<boolean> {
    if (this.cooldowns.has(key)) return Promise.resolve(false);
    this.cooldowns.add(key);
    return Promise.resolve(true);
  }
  incrementWindowedCounter(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return Promise.resolve(next);
  }
}

class FakeSmsProvider implements SmsProvider {
  sent: { phoneE164: string; message: string }[] = [];
  send(phoneE164: string, message: string): Promise<void> {
    this.sent.push({ phoneE164, message });
    return Promise.resolve();
  }
}

async function setup() {
  const settings = new SettingsService(new FakeSettingsSource(), new NoopBus(), fixedClock, 60_000);
  await settings.onModuleInit();
  const store = new FakeOtpStore();
  const sms = new FakeSmsProvider();
  const otp = new OtpService(store, sms, settings, { JWT_SECRET: 'test-secret-at-least-16-chars' });
  return { otp, store, sms };
}

const PHONE = '+8801712345678';
const IP = '203.0.113.7';

describe('OtpService', () => {
  it('sends an OTP and lets it verify', async () => {
    const { otp, sms } = await setup();
    await expect(otp.requestOtp(PHONE, IP)).resolves.toEqual({
      resendAfterSeconds: 60,
    });
    expect(sms.sent).toHaveLength(1);

    const [sent] = sms.sent;
    const code = /\d{6}/.exec(sent!.message)?.[0];
    expect(code).toBeDefined();
    await expect(otp.verifyOtp(PHONE, code!)).resolves.toBeUndefined();
  });

  it('rejects a second request within the cooldown window', async () => {
    const { otp } = await setup();
    await otp.requestOtp(PHONE, IP);
    await expect(otp.requestOtp(PHONE, IP)).rejects.toBeInstanceOf(OtpCooldownException);
  });

  it('enforces the per-phone daily limit', async () => {
    const { otp, store } = await setup();
    // Bypass the cooldown between requests directly in the fake store, since
    // this test is about the daily cap, not the 60s cooldown.
    for (let i = 0; i < 5; i += 1) {
      store.cooldowns.clear();
      await otp.requestOtp(PHONE, IP);
    }
    store.cooldowns.clear();
    await expect(otp.requestOtp(PHONE, IP)).rejects.toBeInstanceOf(OtpPhoneDailyLimitException);
  });

  it('enforces the per-IP daily limit across different phones', async () => {
    const { otp, store } = await setup();
    for (let i = 0; i < 20; i += 1) {
      store.cooldowns.clear();
      await otp.requestOtp(`+88017123456${i % 10}${Math.floor(i / 10)}`, IP);
    }
    store.cooldowns.clear();
    await expect(otp.requestOtp('+8801799999999', IP)).rejects.toBeInstanceOf(
      OtpIpDailyLimitException,
    );
  });

  it('rejects verification once the OTP has expired (no record)', async () => {
    const { otp } = await setup();
    await expect(otp.verifyOtp(PHONE, '123456')).rejects.toBeInstanceOf(OtpExpiredException);
  });

  it('rejects a wrong code and reports attempts remaining', async () => {
    const { otp, sms } = await setup();
    await otp.requestOtp(PHONE, IP);
    const code = /\d{6}/.exec(sms.sent[0]!.message)![0];
    const wrong = code === '000000' ? '111111' : '000000';

    await expect(otp.verifyOtp(PHONE, wrong)).rejects.toMatchObject({ attemptsRemaining: 2 });
    // The correct code still works after one wrong attempt.
    await expect(otp.verifyOtp(PHONE, code)).resolves.toBeUndefined();
  });

  it('invalidates the OTP after too many wrong attempts', async () => {
    const { otp, sms } = await setup();
    await otp.requestOtp(PHONE, IP);
    const code = /\d{6}/.exec(sms.sent[0]!.message)![0];
    const wrong = code === '000000' ? '111111' : '000000';

    await expect(otp.verifyOtp(PHONE, wrong)).rejects.toBeInstanceOf(OtpIncorrectException);
    await expect(otp.verifyOtp(PHONE, wrong)).rejects.toBeInstanceOf(OtpIncorrectException);
    await expect(otp.verifyOtp(PHONE, wrong)).rejects.toBeInstanceOf(OtpTooManyAttemptsException);
    // Even the correct code no longer works — the record was deleted.
    await expect(otp.verifyOtp(PHONE, code)).rejects.toBeInstanceOf(OtpExpiredException);
  });
});
