import { EnvSchema } from './env.schema';

/** The env checks that keep a misconfigured API from starting (SMS: ADR 053). */

const BASE = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  MEILI_HOST: 'http://localhost:7700',
  MEILI_MASTER_KEY: 'meili_master_key_0123456789',
  STORAGE_PUBLIC_URL: 'http://localhost:3000/media',
  API_PUBLIC_URL: 'http://localhost:3000',
  JWT_SECRET: 'jwt-secret-0123456789abcdef',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '60d',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '2525',
  SMTP_FROM: 'noreply@example.com',
  GOOGLE_CLIENT_ID: 'client-id',
  APP_ROOT_DOMAIN: 'example.com',
};

const issues = (env: Record<string, string>) => {
  const result = EnvSchema.safeParse({ ...BASE, ...env });
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
};

describe('EnvSchema: SMS', () => {
  it('defaults to the local provider outside production', () => {
    expect(issues({})).toEqual([]);
    expect(EnvSchema.parse(BASE).SMS_PROVIDER).toBe('local');
  });

  it('bulksmsbd needs its API key and approved sender ID', () => {
    expect(issues({ SMS_PROVIDER: 'bulksmsbd' })).toEqual(['SMS_API_KEY', 'SMS_SENDER_ID']);
    expect(
      issues({ SMS_PROVIDER: 'bulksmsbd', SMS_API_KEY: 'k', SMS_SENDER_ID: '8809617000000' }),
    ).toEqual([]);
  });

  it('refuses production on the local provider, which only logs the code', () => {
    expect(issues({ NODE_ENV: 'production' })).toEqual(['SMS_PROVIDER']);
    expect(
      issues({
        NODE_ENV: 'production',
        SMS_PROVIDER: 'bulksmsbd',
        SMS_API_KEY: 'k',
        SMS_SENDER_ID: '8809617000000',
      }),
    ).toEqual([]);
  });

  it('refuses an unknown provider name', () => {
    expect(issues({ SMS_PROVIDER: 'twilio' })).toEqual(['SMS_PROVIDER']);
  });
});
