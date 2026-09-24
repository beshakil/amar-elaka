import type { Sql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * Proves infra/migrations/0013_auth_credentials.sql's central claim: `ae_app`
 * (exactly what the API connects as) cannot write to `users`,
 * `auth_refresh_tokens` or `tenant_members` directly — no policy/grant for
 * it exists pre-auth — but every one of the five SECURITY DEFINER functions
 * still produces the right result when called as `ae_app` with no
 * `app.user_id` set at all (the actual pre-login/pre-refresh condition).
 *
 * Run with `pnpm --filter api test:db` (this file matches `*.db-spec.ts`,
 * picked up by the same jest-db.json run as the RLS suites).
 */

const PARTNER = '0191e3a0-4444-7000-8000-0000000000d9';
const GEO_AREA = '0191e3a0-4444-7000-8000-0000000000e1';
const TENANT = '0191e3a0-4444-7000-8000-00000000000a';
const FIXTURE_PREFIX = '0191e3a0-4444-7000-8000-%';

const PHONE = '+8801911222001';
const BLACKLISTED_PHONE = '+8801911222002';

interface FnRow {
  user_id?: string;
  is_new?: boolean;
  blacklist_severity?: string | null;
  member_id?: string;
  role_code?: string;
  device_id?: string;
  password_hash?: string | null;
}

async function callAsAnon<T extends FnRow>(app: Sql, sqlText: string): Promise<T[]> {
  return app.begin(async (tx) => {
    // The genuinely pre-auth condition: no app.* setting at all.
    await tx`select set_config('app.role', 'anon', true)`;
    return tx.unsafe<T[]>(sqlText);
  }) as Promise<T[]>;
}

describe('Auth SECURITY DEFINER functions (0013_auth_credentials.sql)', () => {
  let app: Sql;
  let admin: Sql;

  beforeAll(async () => {
    app = testSqlClient(4, resolveTestAppDatabaseUrl());
    admin = testSqlClient(1, resolveTestDatabaseUrl());

    await admin`delete from tenant_members where tenant_id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from auth_refresh_tokens where user_id in (select id from users where phone_e164 in (${PHONE}, ${BLACKLISTED_PHONE}))`;
    await admin`delete from user_devices where user_id in (select id from users where phone_e164 in (${PHONE}, ${BLACKLISTED_PHONE}))`;
    await admin`delete from blacklist_entries where phone_e164 = ${BLACKLISTED_PHONE}`;
    await admin`delete from users where phone_e164 in (${PHONE}, ${BLACKLISTED_PHONE})`;
    await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;

    await admin`
      insert into partners (id, legal_name, display_name, phone_e164) values
        (${PARTNER}, 'DB Spec Partner Ltd.', 'DB Spec Partner', '+8801911000039')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
        (${GEO_AREA}, 3, 'upazila', 'auth-fn-fixture', 'Auth Fn Fixture Area', 'fixture')`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
        (${TENANT}, ${PARTNER}, ${GEO_AREA}, 'auth-fn-fixture-tenant', 'এফ', 'F', st_point(90.4, 23.8)::geography, 'active')`;
  });

  afterAll(async () => {
    try {
      await admin`delete from tenant_members where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from auth_refresh_tokens where user_id in (select id from users where phone_e164 in (${PHONE}, ${BLACKLISTED_PHONE}))`;
      await admin`delete from user_devices where user_id in (select id from users where phone_e164 in (${PHONE}, ${BLACKLISTED_PHONE}))`;
      await admin`delete from blacklist_entries where phone_e164 = ${BLACKLISTED_PHONE}`;
      await admin`delete from users where phone_e164 in (${PHONE}, ${BLACKLISTED_PHONE})`;
      await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
    } finally {
      await Promise.all([app.end(), admin.end()]);
    }
  });

  describe('RLS genuinely blocks the direct path (no SECURITY DEFINER)', () => {
    it('ae_app cannot INSERT into users directly, even with no context at all', async () => {
      const error = await app
        .begin((tx) => tx`insert into users (phone_e164) values ('+8801911222099')`)
        .then(
          () => undefined,
          (caught: unknown) => caught as { code?: string },
        );
      expect(error?.code).toBe('42501');
    });

    it('ae_app cannot INSERT into auth_refresh_tokens directly (no grant at all)', async () => {
      const [user] = await admin<{ id: string }[]>`
        select id from users where phone_e164 = ${PHONE}`;
      // Fixture may not exist yet at this point in file order — any uuid
      // works, since the attempt must fail before it even checks the FK.
      const userId = user?.id ?? '00000000-0000-7000-8000-000000000000';
      const error = await app
        .begin(
          (tx) => tx`
            insert into auth_refresh_tokens (user_id, token_hash, family_id, expires_at)
            values (${userId}, 'x', gen_random_uuid(), now() + interval '1 day')`,
        )
        .then(
          () => undefined,
          (caught: unknown) => caught as { code?: string },
        );
      expect(error?.code).toBe('42501');
    });
  });

  describe('auth_resolve_or_create_by_phone', () => {
    it('creates a new user + profile on first call, pre-auth', async () => {
      const [row] = await callAsAnon<FnRow>(
        app,
        `select * from public.auth_resolve_or_create_by_phone('${PHONE}')`,
      );
      expect(row?.is_new).toBe(true);
      expect(row?.blacklist_severity).toBeNull();
      expect(row?.user_id).toEqual(expect.any(String));

      const [profile] = await admin<{ display_name: string }[]>`
        select display_name from user_profiles where user_id = ${row!.user_id!}`;
      expect(profile?.display_name).toBeTruthy();
    });

    it('the second call for the same phone returns the same user, is_new = false', async () => {
      const [first] = await callAsAnon<FnRow>(
        app,
        `select * from public.auth_resolve_or_create_by_phone('${PHONE}')`,
      );
      expect(first?.is_new).toBe(false);

      const [dbRow] = await admin<
        { id: string }[]
      >`select id from users where phone_e164 = ${PHONE}`;
      expect(first?.user_id).toBe(dbRow?.id);
    });

    it('surfaces an active blacklist entry by phone, before any account exists', async () => {
      await admin`
        insert into blacklist_entries
          (phone_e164, reason_code, severity_code, status_code, summary, recommended_by_user_id, reviewed_by_user_id, evidence_refs)
        values (
          ${BLACKLISTED_PHONE}, 'fraud', 'banned', 'active', 'db-spec fixture',
          (select id from users where phone_e164 = ${PHONE}),
          (select id from users where phone_e164 = ${PHONE}),
          '["fixture-evidence"]'::jsonb
        )`;

      const [row] = await callAsAnon<FnRow>(
        app,
        `select * from public.auth_resolve_or_create_by_phone('${BLACKLISTED_PHONE}')`,
      );
      // The account is still created (§9.10: an audit trail must exist even
      // for a refused login) — only the severity is returned for the caller
      // (AuthService) to refuse issuing a session with.
      expect(row?.blacklist_severity).toBe('banned');
    });
  });

  describe('auth_finalize_session + auth_rotate_refresh_token', () => {
    async function loginAndGetRefreshToken(): Promise<{ userId: string; tokenHash: string }> {
      const [identity] = await callAsAnon<FnRow>(
        app,
        `select * from public.auth_resolve_or_create_by_phone('${PHONE}')`,
      );
      const userId = identity!.user_id!;
      const tokenHash = `hash-${Math.random().toString(36).slice(2)}`;

      const [session] = await callAsAnon<FnRow>(
        app,
        `select * from public.auth_finalize_session(
          '${userId}', '${TENANT}', '{"platformCode":"android","fingerprintHash":"fp-${userId}"}'::jsonb,
          '${tokenHash}', gen_random_uuid(), (now() + interval '60 days')::timestamptz, '127.0.0.1'::inet, 'jest'
        )`,
      );
      expect(session?.member_id).toEqual(expect.any(String));
      expect(session?.role_code).toBe('member');
      expect(session?.device_id).toEqual(expect.any(String));

      const [member] = await admin<{ role_code: string; tenant_id: string }[]>`
        select role_code, tenant_id from tenant_members where user_id = ${userId} and tenant_id = ${TENANT}`;
      expect(member?.tenant_id).toBe(TENANT);

      return { userId, tokenHash };
    }

    it('grants tenant membership, a device row and a refresh token — none of which ae_app could insert itself', async () => {
      await loginAndGetRefreshToken();
    });

    it('rotates the token and detects reuse of the superseded one', async () => {
      const { tokenHash } = await loginAndGetRefreshToken();
      const newHash = `hash-${Math.random().toString(36).slice(2)}`;

      const [rotated] = await callAsAnon<FnRow>(
        app,
        `select * from public.auth_rotate_refresh_token(
          '${tokenHash}', '${newHash}', (now() + interval '60 days')::timestamptz, '${TENANT}', '127.0.0.1'::inet, 'jest'
        )`,
      );
      expect(rotated?.user_id).toEqual(expect.any(String));

      const error = await callAsAnon(
        app,
        `select * from public.auth_rotate_refresh_token(
          '${tokenHash}', 'irrelevant', (now() + interval '60 days')::timestamptz, '${TENANT}', '127.0.0.1'::inet, 'jest'
        )`,
      ).then(
        () => undefined,
        (caught: unknown) => caught as { code?: string },
      );
      expect(error?.code).toBe('AE002');

      // Reuse revokes the WHOLE family — the legitimate new token is dead too.
      const [row] = await admin<{ revoked_at: string | null }[]>`
        select revoked_at from auth_refresh_tokens where token_hash = ${newHash}`;
      expect(row?.revoked_at).not.toBeNull();
    });

    it('rejects an unknown token hash', async () => {
      const error = await callAsAnon(
        app,
        `select * from public.auth_rotate_refresh_token(
          'no-such-hash', 'irrelevant', (now() + interval '60 days')::timestamptz, '${TENANT}', '127.0.0.1'::inet, 'jest'
        )`,
      ).then(
        () => undefined,
        (caught: unknown) => caught as { code?: string },
      );
      expect(error?.code).toBe('AE001');
    });

    it('rejects an expired token', async () => {
      const { tokenHash } = await loginAndGetRefreshToken();
      await admin`update auth_refresh_tokens set expires_at = now() - interval '1 minute' where token_hash = ${tokenHash}`;

      const error = await callAsAnon(
        app,
        `select * from public.auth_rotate_refresh_token(
          '${tokenHash}', 'irrelevant', (now() + interval '60 days')::timestamptz, '${TENANT}', '127.0.0.1'::inet, 'jest'
        )`,
      ).then(
        () => undefined,
        (caught: unknown) => caught as { code?: string },
      );
      expect(error?.code).toBe('AE003');
    });
  });

  describe('auth_get_by_google_id / auth_get_credential_by_email', () => {
    it('returns no rows for an unlinked google_id', async () => {
      const rows = await callAsAnon<FnRow>(
        app,
        `select * from public.auth_get_by_google_id('no-such-google-id')`,
      );
      expect(rows).toHaveLength(0);
    });

    it('finds a linked google_id and reflects blacklist status', async () => {
      await admin`update users set google_id = 'db-spec-google-id' where phone_e164 = ${PHONE}`;
      const [row] = await callAsAnon<FnRow>(
        app,
        `select * from public.auth_get_by_google_id('db-spec-google-id')`,
      );
      expect(row?.user_id).toEqual(expect.any(String));
      expect(row?.blacklist_severity).toBeNull();
    });

    it('returns a null password_hash for an email with none set, distinct from no match', async () => {
      await admin`update users set email = 'db-spec@example.com' where phone_e164 = ${PHONE}`;
      const [row] = await callAsAnon<FnRow>(
        app,
        `select * from public.auth_get_credential_by_email('db-spec@example.com')`,
      );
      expect(row?.user_id).toEqual(expect.any(String));
      expect(row?.password_hash).toBeNull();

      const none = await callAsAnon<FnRow>(
        app,
        `select * from public.auth_get_credential_by_email('nobody@example.com')`,
      );
      expect(none).toHaveLength(0);
    });
  });
});
