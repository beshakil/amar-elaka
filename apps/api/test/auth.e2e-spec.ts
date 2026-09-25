import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { GoogleTokenVerifierService } from '../src/auth/google/google-token-verifier.service';
import { SMS_PROVIDER, type SmsProvider } from '../src/auth/otp/sms/sms-provider.interface';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * Full-stack proof that the auth module is wired correctly end to end: real
 * Postgres (the 0013 SECURITY DEFINER functions), real Redis-backed OTP
 * store, real JWT signing — only the two genuinely external calls (SMS
 * gateway, Google's token verifier) are swapped for fakes, since a hermetic
 * test suite can't depend on an SMS carrier or Google's servers.
 *
 * Requires `make up` (Postgres/Redis/Meilisearch) and the test database
 * already migrated (`pnpm --filter api test:db` runs the migrations as a
 * side effect, or `pnpm --filter api db:migrate` against TEST_*_DATABASE_URL).
 */

const PARTNER = '0191e3a0-3333-7000-8000-0000000000d9';
const GEO_AREA = '0191e3a0-3333-7000-8000-0000000000e1';
const TENANT = '0191e3a0-3333-7000-8000-00000000000a';
const TENANT_SLUG = 'auth-e2e-fixture-tenant';
const FIXTURE_PREFIX = '0191e3a0-3333-7000-8000-%';

// Every scenario that calls POST /otp/request needs its own phone number:
// otp_resend_cooldown_seconds (60s) would otherwise reject the second
// request in the same test run. RUN_ID also keeps distinct test runs from
// colliding with a previous run's still-live Redis rate-limit counters.
const RUN_ID = Date.now().toString().slice(-6);
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+88017${RUN_ID}${phoneCounter.toString().padStart(2, '0')}`;
}

const GOOGLE_ID_TOKEN = 'fake-google-id-token';
const GOOGLE_ID = `google-${RUN_ID}`;

class FakeSmsProvider implements SmsProvider {
  sent: { phoneE164: string; message: string }[] = [];
  send(phoneE164: string, message: string): Promise<void> {
    this.sent.push({ phoneE164, message });
    return Promise.resolve();
  }
  lastCodeFor(phone: string): string {
    const entry = [...this.sent].reverse().find((item) => item.phoneE164 === phone);
    const code = entry && /\d{4,8}/.exec(entry.message)?.[0];
    if (!code) throw new Error(`no OTP was sent to ${phone}`);
    return code;
  }
}

describe('Auth module (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: Sql;
  let sms: FakeSmsProvider;

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164) values
        (${PARTNER}, 'Auth E2E Partner Ltd.', 'Auth E2E Partner', '+8801911000029')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
        (${GEO_AREA}, 3, 'upazila', 'auth-e2e-fixture', 'Auth E2E Area', 'fixture')`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
        (${TENANT}, ${PARTNER}, ${GEO_AREA}, ${TENANT_SLUG}, 'ই২ই', 'E2E', st_point(90.4, 23.8)::geography, 'active')`;

    sms = new FakeSmsProvider();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SMS_PROVIDER)
      .useValue(sms)
      .overrideProvider(GoogleTokenVerifierService)
      .useValue({
        verify: (idToken: string) => {
          if (idToken !== GOOGLE_ID_TOKEN) throw new Error('unexpected idToken in test double');
          return Promise.resolve({ googleId: GOOGLE_ID, email: undefined, emailVerified: false });
        },
      })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // Mirrors main.ts's bootstrap() exactly, which Test.createTestingModule
    // does not run on its own.
    app.setGlobalPrefix('api', {
      exclude: [
        { path: 'health/live', method: RequestMethod.GET },
        { path: 'health/ready', method: RequestMethod.GET },
      ],
    });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    try {
      await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from users where phone_e164 like ${`+88017${RUN_ID}%`}`;
      await admin`delete from users where google_id = ${GOOGLE_ID}`;
    } finally {
      await admin.end();
    }
  });

  async function requestAndReadOtp(phone: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
      payload: { phone },
    });
    expect(response.statusCode).toBe(202);
    const body = response.json<{ status: string; resendAfterSeconds: number }>();
    expect(body.status).toBe('otp_sent');
    expect(body.resendAfterSeconds).toBeGreaterThan(0);
    return sms.lastCodeFor(phone);
  }

  it('rejects an OTP request from a malformed phone number', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
      payload: { phone: '123' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe('VALIDATION_FAILED');
  });

  it('rejects verification with the wrong code', async () => {
    const phone = nextPhone();
    await requestAndReadOtp(phone);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      headers: { 'x-tenant-id': TENANT },
      payload: { phone, code: '000000', device: { platformCode: 'android' } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe('OTP_INCORRECT');
  });

  it('requires a tenant to complete login, even with a correct code', async () => {
    const phone = nextPhone();
    const code = await requestAndReadOtp(phone);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      payload: { phone, code, device: { platformCode: 'android' } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe('TENANT_REQUIRED');
  });

  it('rejects a non-allowlisted route for an unknown tenant id (TenantGateGuard, not AuthService)', async () => {
    // /auth/otp/* is allowlisted (@AllowAnyTenant()) so it can't demonstrate
    // this — /auth/refresh isn't, and never reaches AuthService here.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { 'x-tenant-id': '0191e3a0-3333-7000-8000-ffffffffffff' },
      payload: { refreshToken: 'irrelevant' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: string }>().error).toBe('TENANT_NOT_FOUND');
  });

  it('rejects a malformed X-Tenant-Id outright, on a non-allowlisted route', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { 'x-tenant-id': 'not-a-uuid' },
      payload: { refreshToken: 'irrelevant' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe('TENANT_ID_INVALID');
  });

  describe('full phone OTP login, then refresh, then logout', () => {
    const phone = nextPhone();
    let accessToken: string;
    let refreshToken: string;

    it('creates a brand-new account on first verified OTP and issues tokens', async () => {
      const code = await requestAndReadOtp(phone);
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/verify',
        headers: { 'x-tenant-id': TENANT },
        payload: {
          phone,
          code,
          device: { platformCode: 'android', fingerprintHash: `fp-${phone}` },
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ accessToken: string; refreshToken: string }>();
      expect(body.accessToken).toEqual(expect.any(String));
      expect(body.refreshToken).toEqual(expect.any(String));
      accessToken = body.accessToken;
      refreshToken = body.refreshToken;

      const [user] = await admin<{ phone_e164: string }[]>`
        select phone_e164 from users where phone_e164 = ${phone}`;
      expect(user?.phone_e164).toBe(phone);
    });

    it('GET /me returns the authenticated user in the right tenant', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ phone, tenantId: TENANT, role: 'member' });
    });

    it('rejects /me with no token', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
      expect(response.statusCode).toBe(401);
      expect(response.json<{ error: string }>().error).toBe('UNAUTHENTICATED');
    });

    it('rotates the refresh token and detects reuse of the old one', async () => {
      const refreshed = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { 'x-tenant-id': TENANT },
        payload: { refreshToken },
      });
      expect(refreshed.statusCode).toBe(200);
      const newTokens = refreshed.json<{ accessToken: string; refreshToken: string }>();
      expect(newTokens.refreshToken).not.toBe(refreshToken);

      // The old (now-rotated) token is a replay attempt: the whole family is revoked.
      const reused = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { 'x-tenant-id': TENANT },
        payload: { refreshToken },
      });
      expect(reused.statusCode).toBe(401);
      expect(reused.json<{ error: string }>().error).toBe('REFRESH_TOKEN_REUSED');

      // The replacement token from the legitimate rotation is now also
      // revoked as a side effect of the reuse response — re-login is required.
      const alsoRevoked = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { 'x-tenant-id': TENANT },
        payload: { refreshToken: newTokens.refreshToken },
      });
      expect(alsoRevoked.statusCode).toBe(401);
    });

    it('logout-all revokes every session for the user', async () => {
      // A fresh account, not `phone` above — that phone is still in its
      // resend cooldown from the first test in this block.
      const otherPhone = nextPhone();
      const code = await requestAndReadOtp(otherPhone);
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/verify',
        headers: { 'x-tenant-id': TENANT },
        payload: { phone: otherPhone, code, device: { platformCode: 'ios' } },
      });
      const tokens = login.json<{ accessToken: string; refreshToken: string }>();

      const loggedOut = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout-all',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      });
      expect(loggedOut.statusCode).toBe(200);

      const afterLogout = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { 'x-tenant-id': TENANT },
        payload: { refreshToken: tokens.refreshToken },
      });
      expect(afterLogout.statusCode).toBe(401);
    });
  });

  describe('Google sign-in linking (dual mode)', () => {
    it('refuses an anonymous Google login with no linked account', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/google',
        headers: { 'x-tenant-id': TENANT },
        payload: { idToken: GOOGLE_ID_TOKEN, device: { platformCode: 'web' } },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json<{ error: string }>().error).toBe('GOOGLE_ACCOUNT_NOT_LINKED');
    });

    it('links Google to the caller’s own account when authenticated, then logs in with it', async () => {
      const phone = nextPhone();
      const code = await requestAndReadOtp(phone);
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/verify',
        headers: { 'x-tenant-id': TENANT },
        payload: { phone, code, device: { platformCode: 'web' } },
      });
      const { accessToken } = login.json<{ accessToken: string }>();

      const link = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/google',
        headers: { authorization: `Bearer ${accessToken}`, 'x-tenant-id': TENANT },
        payload: { idToken: GOOGLE_ID_TOKEN, device: { platformCode: 'web' } },
      });
      expect(link.statusCode).toBe(200);
      expect(link.json()).toEqual({ linked: true });

      const anonymousLogin = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/google',
        headers: { 'x-tenant-id': TENANT },
        payload: { idToken: GOOGLE_ID_TOKEN, device: { platformCode: 'web' } },
      });
      expect(anonymousLogin.statusCode).toBe(200);
      expect(anonymousLogin.json<{ accessToken: string }>().accessToken).toEqual(
        expect.any(String),
      );
    });
  });

  describe('PATCH /auth/me', () => {
    it('updates displayName and is reflected by a subsequent GET /me', async () => {
      const phone = nextPhone();
      const code = await requestAndReadOtp(phone);
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/verify',
        headers: { 'x-tenant-id': TENANT },
        payload: { phone, code, device: { platformCode: 'android' } },
      });
      const { accessToken } = login.json<{ accessToken: string }>();

      const update = await app.inject({
        method: 'PATCH',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { displayName: 'Rahim Uddin' },
      });
      expect(update.statusCode).toBe(200);
      expect(update.json()).toMatchObject({ displayName: 'Rahim Uddin' });

      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(me.json()).toMatchObject({ displayName: 'Rahim Uddin' });
    });

    it('rejects an empty displayName', async () => {
      const phone = nextPhone();
      const code = await requestAndReadOtp(phone);
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/verify',
        headers: { 'x-tenant-id': TENANT },
        payload: { phone, code, device: { platformCode: 'android' } },
      });
      const { accessToken } = login.json<{ accessToken: string }>();

      const update = await app.inject({
        method: 'PATCH',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { displayName: '' },
      });
      expect(update.statusCode).toBe(400);
      expect(update.json<{ error: string }>().error).toBe('VALIDATION_FAILED');
    });

    it('rejects PATCH /me with no token', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/v1/auth/me',
        payload: { displayName: 'Someone' },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json<{ error: string }>().error).toBe('UNAUTHENTICATED');
    });
  });
});
