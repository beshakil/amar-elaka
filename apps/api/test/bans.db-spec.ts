import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * Bans, appeals, the blacklist and complaints in the database (0059, ADR 063),
 * as ae_app under RLS:
 *  - the ladder (7 → 30 → permanent); permanent only by a tenant admin, with
 *    evidence; off the ladder needs a reason; every ban writes moderation_actions;
 *  - the state rule: an area ban bites only in its area, a blacklist entry
 *    everywhere; expiry drops it at once;
 *  - governance: a tenant admin can only recommend (RLS and function), only
 *    platform_admin approves; a terminated approval revokes every session;
 *  - matching at sign-in: device and phone hash; a phone-only match decays
 *    to 'watch' (recycled numbers);
 *  - appeals: routing, one per ban, the per-phone daily limit, the area is
 *    never the final judge (its uphold escalates), escalation after the window,
 *    the public path only under the appeal_public role;
 *  - complaints: priority and SLA, assignment, resolution, the breach job,
 *    cross-tenant isolation.
 */

const P = '0191e3a0-7e3e-7000-8000-';
const FIXTURE = `${P}%`;
const PARTNER = `${P}000000000801`;
const AREA_A = `${P}000000000811`;
const AREA_B = `${P}000000000812`;
const TENANT_A = `${P}000000000821`;
const TENANT_B = `${P}000000000822`;
const U = (n: number) => `${P}000000000${830 + n}`;
const M = (n: number) => `${P}000000000${860 + n}`;
const [BAD, OTHER, MOD, ADMIN, ADMIN_B, PLATFORM, TWIN, REPORTER, EXEC] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9,
];
const STORE = `${P}000000000891`;
const PHONE = (n: number) => `+88017${String(n).padStart(2, '0')}888888`;
const EVIDENCE = JSON.stringify([{ type: 'report', id: `${P}000000000899` }]);

type Context = Partial<
  Record<'tenant_id' | 'user_id' | 'member_id' | 'role' | 'is_platform_admin', string>
>;
const as = (n: number, tenant = TENANT_A, role = 'member'): Context => ({
  tenant_id: tenant,
  user_id: U(n),
  member_id: M(n),
  role,
});
const MOD_A = as(MOD, TENANT_A, 'moderator');
const ADMIN_A = as(ADMIN, TENANT_A, 'tenant_admin');
const ADMIN_TB = as(ADMIN_B, TENANT_B, 'tenant_admin');
const EXEC_A = as(EXEC, TENANT_A, 'executive');
const PLATFORM_ADMIN: Context = {
  user_id: U(PLATFORM),
  role: 'platform_admin',
  is_platform_admin: 'true',
};
const SYSTEM: Context = { role: 'system', is_platform_admin: 'true' };
const PUBLIC: Context = { role: 'appeal_public' };

async function withContext<T>(
  sql: Sql,
  context: Context,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    for (const [key, value] of Object.entries(context)) {
      await tx`select set_config(${`app.${key}`}, ${value}, true)`;
    }
    return work(tx);
  }) as Promise<T>;
}

async function rejection(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => undefined,
    (caught: unknown) => {
      const e = caught as { code?: string; detail?: string };
      return e.code?.startsWith('AE8') && e.detail
        ? `${e.code}:${e.detail}`
        : (e.code ?? 'unknown');
    },
  );
}

describe('Bans, appeals, blacklist and complaints in the database (0059)', () => {
  let app: Sql;
  let admin: Sql;

  interface Issued {
    id: string;
    reference_code: string;
    expires_at: Date | null;
    is_permanent: boolean;
    escalation_step: number;
  }
  const issue = (
    ctx: Context,
    opts: {
      user?: number;
      severity?: string;
      days?: number | null;
      permanent?: boolean;
      override?: string | null;
      evidence?: string;
    } = {},
  ) =>
    withContext(
      app,
      ctx,
      (tx) =>
        tx<Issued[]>`
        select id, reference_code, expires_at, is_permanent, escalation_step
        from public.issue_ban(${U(opts.user ?? BAD)}::uuid, ${opts.severity ?? 'restricted'}, 'scam',
                              'sold a fake phone, two reports', ${opts.evidence ?? EVIDENCE}::text::jsonb,
                              ${opts.days ?? null}::integer, ${opts.permanent ?? false}, ${opts.override ?? null})`,
    ).then((r) => r[0]!);

  const state = (n: number, tenant = TENANT_A) =>
    withContext(
      app,
      as(n, tenant),
      (tx) =>
        tx<
          { severity_code: string; source: string }[]
        >`select severity_code, source from public.my_ban_state()`,
    ).then((r) => r[0]);

  const lift = (banId: string, ctx: Context = ADMIN_A) =>
    withContext(
      app,
      ctx,
      (tx) => tx`select * from public.lift_ban(${banId}::uuid, 'test cleanup')`,
    );

  const endAllBans = async () => {
    await admin.begin(async (tx) => {
      await tx`update bans set status_code = 'revoked', revoked_at = now() where tenant_id::text like ${FIXTURE} and status_code = 'active'`;
    });
  };

  async function cleanUp(): Promise<void> {
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from ban_appeals where user_id::text like ${FIXTURE}`;
      for (const table of [
        'moderation_actions',
        'complaints',
        'bans',
        'member_trust_scores',
        'stores',
        'tenant_members',
      ]) {
        await tx.unsafe(`delete from ${table} where tenant_id::text like $1`, [FIXTURE]);
      }
      await tx`delete from blacklist_entries where user_id::text like ${FIXTURE} or recommended_by_user_id::text like ${FIXTURE}`;
      await tx`delete from auth_refresh_tokens where user_id::text like ${FIXTURE}`;
      await tx`delete from user_devices where user_id::text like ${FIXTURE}`;
    });
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from user_profiles where user_id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    app = testSqlClient(4, resolveTestAppDatabaseUrl());
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();
    for (const n of [BAD, OTHER, MOD, ADMIN, ADMIN_B, PLATFORM, TWIN, REPORTER, EXEC]) {
      await admin`insert into users (id, phone_e164, phone_verified_at, platform_role_code)
                  values (${U(n)}, ${PHONE(n)}, now(), ${n === PLATFORM ? 'platform_admin' : null})`;
      await admin`insert into user_profiles (user_id, display_name) values (${U(n)}, ${`fixture ${n}`})`;
    }
    await admin`insert into partners (id, legal_name, display_name, phone_e164)
                values (${PARTNER}, 'Ban Fixture', 'Ban Fixture', '+8801747000098')`;
    await admin`insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
      (${AREA_A}, 3, 'upazila', 'ban-db-a', 'Ban A', 'fixture'),
      (${AREA_B}, 3, 'upazila', 'ban-db-b', 'Ban B', 'fixture')`;
    await admin`insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
      (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'ban-db-a', 'মিরপুর-ফিক্সচার', 'A', st_point(91.1, 22.1)::geography, 'active'),
      (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'ban-db-b', 'বি', 'B', st_point(91.2, 22.1)::geography, 'active')`;
    for (const [n, role] of [
      [BAD, 'member'],
      [OTHER, 'member'],
      [TWIN, 'member'],
      [REPORTER, 'member'],
      [MOD, 'moderator'],
      [ADMIN, 'tenant_admin'],
      [EXEC, 'executive'],
    ] as const) {
      await admin`insert into tenant_members (id, tenant_id, user_id, role_code) values (${M(n)}, ${TENANT_A}, ${U(n)}, ${role})`;
    }
    await admin`insert into tenant_members (id, tenant_id, user_id, role_code) values
      (${M(ADMIN_B)}, ${TENANT_B}, ${U(ADMIN_B)}, 'tenant_admin'),
      (${`${P}000000000879`}, ${TENANT_B}, ${U(BAD)}, 'member')`;
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`insert into stores (id, tenant_id, owner_member_id, slug, name_bn, status_code)
               values (${STORE}, ${TENANT_A}, ${M(BAD)}, 'ban-db-store', 'ফিক্সচার দোকান', 'active')`;
    });
  });

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await Promise.all([app.end(), admin.end()]);
    }
  });

  describe('issuing bans: the ladder', () => {
    afterAll(endAllBans);

    it('7 days, then 30 days, then permanent — permanent only by a tenant admin with evidence', async () => {
      const first = await issue(MOD_A);
      expect(first.escalation_step).toBe(1);
      expect(first.is_permanent).toBe(false);
      const days1 = (first.expires_at!.getTime() - Date.now()) / 86_400_000;
      expect(Math.round(days1)).toBe(7);
      expect(first.reference_code).toMatch(/^BN-[0-9A-F]{10}$/);

      const second = await issue(MOD_A, { severity: 'banned' });
      expect(second.escalation_step).toBe(2);
      expect(Math.round((second.expires_at!.getTime() - Date.now()) / 86_400_000)).toBe(30);
      // The new ban replaced the first.
      const [old] = await admin<
        { status_code: string }[]
      >`select status_code from bans where id = ${first.id}`;
      expect(old!.status_code).toBe('superseded');

      // Third step is permanent: a moderator may not; an admin needs evidence.
      expect(await rejection(issue(MOD_A, { severity: 'banned' }))).toBe(
        'AE801:permanent_needs_admin',
      );
      expect(await rejection(issue(ADMIN_A, { severity: 'banned', evidence: '[]' }))).toBe(
        'AE801:evidence_required',
      );
      const third = await issue(ADMIN_A, { severity: 'banned' });
      expect(third.is_permanent).toBe(true);
      expect(third.expires_at).toBeNull();
      expect(third.escalation_step).toBe(3);
    });

    it('off the ladder needs a written reason; staff, oneself and non-members are refused', async () => {
      expect(await rejection(issue(MOD_A, { user: OTHER, days: 3 }))).toBe(
        'AE801:override_reason_required',
      );
      const custom = await issue(MOD_A, { user: OTHER, days: 3, override: 'first offence, short' });
      expect(Math.round((custom.expires_at!.getTime() - Date.now()) / 86_400_000)).toBe(3);
      expect(await rejection(issue(MOD_A, { user: MOD }))).toBe('AE801:self');
      expect(await rejection(issue(MOD_A, { user: ADMIN }))).toBe('AE801:target_staff');
      expect(await rejection(issue(MOD_A, { user: ADMIN_B }))).toBe('AE801:not_member');
      expect(
        await rejection(issue(MOD_A, { user: OTHER, evidence: '[{"type":"x","id":"y"}]' })),
      ).toBe('AE801:invalid_evidence');
      expect(await rejection(issue(as(OTHER), { user: TWIN }))).toBe('42501');
    });

    it('every ban writes moderation_actions and the membership cache', async () => {
      const [row] = await admin<{ n: number }[]>`
        select count(*)::int as n from moderation_actions
        where tenant_id = ${TENANT_A} and action_code = 'ban_issued' and ban_id is not null`;
      expect(row!.n).toBeGreaterThanOrEqual(4);
      const [member] = await admin<{ ban_severity_code: string }[]>`
        select ban_severity_code from tenant_members where id = ${M(BAD)}`;
      expect(member!.ban_severity_code).toBe('banned');
    });

    it('no direct write: ae_app cannot insert or update a ban', async () => {
      expect(
        await rejection(
          withContext(
            app,
            ADMIN_A,
            (tx) =>
              tx`insert into bans (tenant_id, user_id, severity_code, reason_code, reason_text, banned_by_user_id, expires_at, escalation_step)
               values (${TENANT_A}, ${U(TWIN)}, 'banned', 'scam', 'x', ${U(ADMIN)}, now() + interval '1 day', 1)`,
          ),
        ),
      ).toBe('42501');
      expect(
        await rejection(
          withContext(
            app,
            ADMIN_A,
            (tx) => tx`update bans set status_code = 'revoked' where tenant_id = ${TENANT_A}`,
          ),
        ),
      ).toBe('42501');
    });

    it("another area's staff see none of these bans", async () => {
      const rows = await withContext(
        app,
        ADMIN_TB,
        (tx) => tx<{ id: string }[]>`select id from public.ban_list_page(false, null, 50)`,
      );
      expect(rows).toHaveLength(0);
      const direct = await withContext(
        app,
        ADMIN_TB,
        (tx) => tx`select id from bans where user_id = ${U(BAD)}`,
      );
      expect(direct).toHaveLength(0);
    });
  });

  describe('the state rule', () => {
    afterAll(endAllBans);

    it('an area ban bites only in its area; expiry drops it at once', async () => {
      const ban = await issue(MOD_A, { user: TWIN, severity: 'banned' });
      expect(await state(TWIN)).toEqual({ severity_code: 'banned', source: 'area' });
      expect(await state(TWIN, TENANT_B)).toBeUndefined();
      await admin.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`update bans set starts_at = now() - interval '9 days', expires_at = now() - interval '1 second' where id = ${ban.id}`;
      });
      expect(await state(TWIN)).toBeUndefined();
      const expired = await withContext(
        app,
        SYSTEM,
        (tx) => tx<{ id: string }[]>`select id from public.expire_bans(100)`,
      );
      expect(expired.map((r) => r.id)).toContain(ban.id);
    });

    it('a lift by the area admin ends it; a moderator cannot lift', async () => {
      const ban = await issue(MOD_A, { user: TWIN });
      expect(await rejection(lift(ban.id, MOD_A))).toBe('42501');
      await lift(ban.id);
      expect(await state(TWIN)).toBeUndefined();
      const [action] = await admin<{ n: number }[]>`
        select count(*)::int as n from moderation_actions where ban_id = ${ban.id} and action_code = 'ban_lifted'`;
      expect(action!.n).toBe(1);
    });
  });

  describe('the global blacklist', () => {
    let entryId = '';

    it('a tenant admin can only recommend — no direct activation, no update', async () => {
      // RLS: a direct insert of an active row is refused.
      expect(
        await rejection(
          withContext(
            app,
            ADMIN_A,
            (tx) =>
              tx`insert into blacklist_entries (user_id, reason_code, severity_code, status_code, summary, source_tenant_id,
                                              recommended_by_user_id, evidence_refs, reviewed_by_user_id)
               values (${U(BAD)}, 'advance_payment_scam', 'banned', 'active', 'x', ${TENANT_A}, ${U(ADMIN)},
                       ${EVIDENCE}::text::jsonb, ${U(ADMIN)})`,
          ),
        ),
      ).toBe('42501');
      // A moderator cannot even recommend.
      expect(
        await rejection(
          withContext(
            app,
            MOD_A,
            (tx) =>
              tx`select * from public.recommend_blacklist(${U(BAD)}::uuid, 'advance_payment_scam', 'terminated', 'x', ${EVIDENCE}::text::jsonb, null)`,
          ),
        ),
      ).toBe('42501');
      expect(
        await rejection(
          withContext(
            app,
            ADMIN_A,
            (tx) =>
              tx`select * from public.recommend_blacklist(${U(BAD)}::uuid, 'advance_payment_scam', 'terminated', 'x', '[]'::text::jsonb, null)`,
          ),
        ),
      ).toBe('AE805:evidence_required');
      const [row] = await withContext(
        app,
        ADMIN_A,
        (tx) =>
          tx<{ id: string; reference_code: string }[]>`
          select * from public.recommend_blacklist(${U(BAD)}::uuid, 'advance_payment_scam', 'terminated',
                                                   'took advance payments for 6 phones, never delivered', ${EVIDENCE}::text::jsonb, null)`,
      );
      entryId = row!.id;
      expect(row!.reference_code).toMatch(/^BL-/);
      // The tenant can neither approve through the function nor update the row.
      expect(
        await rejection(
          withContext(
            app,
            ADMIN_A,
            (tx) =>
              tx`select * from public.decide_blacklist(${entryId}::uuid, 'approve', null, null)`,
          ),
        ),
      ).toBe('42501');
      const updated = await withContext(
        app,
        ADMIN_A,
        (tx) =>
          tx`update blacklist_entries set status_code = 'active', reviewed_by_user_id = ${U(ADMIN)} where id = ${entryId} returning id`,
      );
      expect(updated).toHaveLength(0);
      const [still] = await admin<
        { status_code: string }[]
      >`select status_code from blacklist_entries where id = ${entryId}`;
      expect(still!.status_code).toBe('recommended');
      // One pending recommendation per person.
      expect(
        await rejection(
          withContext(
            app,
            ADMIN_A,
            (tx) =>
              tx`select * from public.recommend_blacklist(${U(BAD)}::uuid, 'fake_product', 'banned', 'again', ${EVIDENCE}::text::jsonb, null)`,
          ),
        ),
      ).toBe('AE805:open_recommendation');
    });

    it('platform_admin approves: it applies in every area; terminated revokes every session', async () => {
      await admin`insert into auth_refresh_tokens (user_id, token_hash, family_id, expires_at)
                  values (${U(BAD)}, ${'f'.repeat(64)}, gen_random_uuid(), now() + interval '30 days')`;
      const phone = await withContext(
        app,
        PLATFORM_ADMIN,
        (tx) => tx<{ p: string }[]>`select public.blacklist_subject_phone(${entryId}::uuid) as p`,
      );
      expect(phone[0]!.p).toBe(PHONE(BAD));
      // Not for anyone else.
      const hidden = await withContext(
        app,
        ADMIN_A,
        (tx) =>
          tx<{ p: string | null }[]>`select public.blacklist_subject_phone(${entryId}::uuid) as p`,
      );
      expect(hidden[0]!.p).toBeNull();

      const [decided] = await withContext(
        app,
        PLATFORM_ADMIN,
        (tx) =>
          tx<
            { status_code: string }[]
          >`select * from public.decide_blacklist(${entryId}::uuid, 'approve', 'evidence is clear', ${'d'.repeat(64)})`,
      );
      expect(decided!.status_code).toBe('active');
      expect(await state(BAD)).toEqual({ severity_code: 'terminated', source: 'platform' });
      expect(await state(BAD, TENANT_B)).toEqual({
        severity_code: 'terminated',
        source: 'platform',
      });
      const [token] = await admin<
        { revoked_at: Date | null }[]
      >`select revoked_at from auth_refresh_tokens where user_id = ${U(BAD)}`;
      expect(token!.revoked_at).not.toBeNull();
      const [action] = await admin<{ n: number }[]>`
        select count(*)::int as n from moderation_actions where blacklist_entry_id = ${entryId} and tenant_id = ${TENANT_A}`;
      expect(action!.n).toBe(2); // recommended + approved, in the source area
    });

    it('matching at sign-in: own entry, device of the listed account, phone hash decaying to watch', async () => {
      await admin`insert into user_devices (user_id, platform_code, fingerprint_hash) values (${U(BAD)}, 'android', ${'e'.repeat(64)})`;
      const match = (user: string | null, phone: string | null, device: string | null) =>
        withContext(
          app,
          { role: 'anon' },
          (tx) =>
            tx<{ own_severity: string | null; identifier_severity: string | null }[]>`
            select * from public.blacklist_match(${user}::uuid, ${phone}, ${device})`,
        ).then((r) => r[0]!);
      expect(await match(U(BAD), null, null)).toEqual({
        own_severity: 'terminated',
        identifier_severity: null,
      });
      // A new account on the same phone (hash) or on the listed person's phone (device).
      expect(await match(U(OTHER), 'd'.repeat(64), null)).toEqual({
        own_severity: null,
        identifier_severity: 'terminated',
      });
      expect(await match(null, null, 'e'.repeat(64))).toEqual({
        own_severity: null,
        identifier_severity: 'terminated',
      });
      expect(await match(U(OTHER), null, null)).toEqual({
        own_severity: null,
        identifier_severity: null,
      });
      // An old phone-only match only flags: the number may have a new owner.
      await admin`update blacklist_entries set reviewed_at = now() - interval '400 days' where id = ${entryId}`;
      expect(await match(null, 'd'.repeat(64), null)).toEqual({
        own_severity: null,
        identifier_severity: 'watch',
      });
      expect(await match(null, null, 'e'.repeat(64))).toEqual({
        own_severity: null,
        identifier_severity: 'terminated',
      });
      await admin`update blacklist_entries set reviewed_at = now() where id = ${entryId}`;
    });

    describe('the public appeal path (terminated: no session)', () => {
      it('only under the appeal_public role, on the verified phone', async () => {
        expect(
          await withContext(
            app,
            { role: 'anon' },
            (tx) => tx`select * from public.public_appeal_status(${PHONE(BAD)})`,
          ),
        ).toHaveLength(0);
        const status = await withContext(
          app,
          PUBLIC,
          (tx) =>
            tx<
              {
                kind: string;
                reference_code: string;
                can_appeal: boolean;
                appeals_left_today: number;
                area_name_bn: string | null;
              }[]
            >`
            select * from public.public_appeal_status(${PHONE(BAD)})`,
        );
        const global = status.find((s) => s.kind === 'platform')!;
        expect(global.can_appeal).toBe(true);
        expect(global.appeals_left_today).toBe(1);
        expect(
          await rejection(
            withContext(
              app,
              { role: 'anon' },
              (tx) =>
                tx`select * from public.public_appeal_submit(${PHONE(BAD)}, ${global.reference_code}, 'I never took money', null, null)`,
            ),
          ),
        ).toBe('42501');
        // Someone else's reference doesn't work with this phone.
        expect(
          await rejection(
            withContext(
              app,
              PUBLIC,
              (tx) =>
                tx`select * from public.public_appeal_submit(${PHONE(OTHER)}, ${global.reference_code}, 'mine?', null, null)`,
            ),
          ),
        ).toBe('AE803:not_appealable');
        const [appeal] = await withContext(
          app,
          PUBLIC,
          (tx) =>
            tx<{ public_reference: string; queue_code: string }[]>`
            select * from public.public_appeal_submit(${PHONE(BAD)}, ${global.reference_code.toLowerCase()}, 'I never took money', '10.0.0.1', 'test')`,
        );
        // A global entry goes straight to the platform.
        expect(appeal!.queue_code).toBe('platform');
        expect(appeal!.public_reference).toMatch(/^AP-/);
        // The daily limit (1) is spent.
        const after = await withContext(
          app,
          PUBLIC,
          (tx) =>
            tx<
              { appeals_left_today: number; can_appeal: boolean; appeal_status: string }[]
            >`select * from public.public_appeal_status(${PHONE(BAD)})`,
        );
        expect(after[0]!.appeals_left_today).toBe(0);
        expect(after.find((s) => s.appeal_status)!.appeal_status).toBe('submitted');
      });

      it('a tenant admin cannot decide a platform appeal; platform_admin grants it and the entry is revoked', async () => {
        const [queued] = await withContext(
          app,
          PLATFORM_ADMIN,
          (tx) =>
            tx<
              { id: string; kind: string; reason_text: string }[]
            >`select * from public.appeal_queue_page('platform', null, 50)`,
        );
        expect(queued!.kind).toBe('platform');
        expect(
          await withContext(
            app,
            ADMIN_A,
            (tx) => tx`select * from public.appeal_queue_page('platform', null, 50)`,
          ),
        ).toHaveLength(0);
        expect(
          await rejection(
            withContext(
              app,
              ADMIN_A,
              (tx) =>
                tx`select * from public.decide_appeal(${queued!.id}::uuid, 'grant', null, null)`,
            ),
          ),
        ).toBe('AE804:not_your_queue');
        const [decided] = await withContext(
          app,
          PLATFORM_ADMIN,
          (tx) =>
            tx<
              { status_code: string }[]
            >`select * from public.decide_appeal(${queued!.id}::uuid, 'grant', 'mistaken identity', null)`,
        );
        expect(decided!.status_code).toBe('granted');
        expect(await state(BAD)).toBeUndefined();
      });
    });
  });

  describe('in-app appeals of an area ban', () => {
    let banId = '';
    let appealId = '';

    beforeAll(async () => {
      await endAllBans();
      await admin`delete from ban_appeals where user_id = ${U(OTHER)}`;
      banId = (await issue(MOD_A, { user: OTHER, severity: 'banned' })).id;
    });
    afterAll(endAllBans);

    it('routes to the area admins with an escalation time; one appeal per ban', async () => {
      const [row] = await withContext(
        app,
        as(OTHER, TENANT_A, 'restricted_user'),
        (tx) =>
          tx<
            { id: string; queue_code: string }[]
          >`select * from public.appeal_submit_in_app(${banId}::uuid, 'It was my brother on my phone')`,
      );
      appealId = row!.id;
      expect(row!.queue_code).toBe('tenant_admin');
      const [appeal] = await admin<
        { escalate_at: Date }[]
      >`select escalate_at from ban_appeals where id = ${appealId}`;
      expect(Math.round((appeal!.escalate_at.getTime() - Date.now()) / 86_400_000)).toBe(7);
      expect(
        await rejection(
          withContext(
            app,
            as(OTHER),
            (tx) => tx`select * from public.appeal_submit_in_app(${banId}::uuid, 'again')`,
          ),
        ),
      ).toBe('AE803:already_appealed');
      // Not someone else's ban.
      expect(
        await rejection(
          withContext(
            app,
            as(TWIN),
            (tx) => tx`select * from public.appeal_submit_in_app(${banId}::uuid, 'x')`,
          ),
        ),
      ).toBe('AE803:not_appealable');
    });

    it('the area is never the final judge: its uphold escalates to the platform', async () => {
      expect(
        await rejection(
          withContext(
            app,
            MOD_A,
            (tx) => tx`select * from public.decide_appeal(${appealId}::uuid, 'uphold', 'no', null)`,
          ),
        ),
      ).toBe('AE804:not_your_queue');
      expect(
        await rejection(
          withContext(
            app,
            ADMIN_A,
            (tx) => tx`select * from public.decide_appeal(${appealId}::uuid, 'uphold', null, null)`,
          ),
        ),
      ).toBe('AE804:note_required');
      const [row] = await withContext(
        app,
        ADMIN_A,
        (tx) =>
          tx<
            { status_code: string }[]
          >`select * from public.decide_appeal(${appealId}::uuid, 'uphold', 'scam is clear', null)`,
      );
      expect(row!.status_code).toBe('escalated');
      const [appeal] = await admin<
        { queue_code: string; tenant_recommendation: string; decided_at: Date | null }[]
      >`
        select queue_code, tenant_recommendation, decided_at from ban_appeals where id = ${appealId}`;
      expect(appeal).toEqual({
        queue_code: 'platform',
        tenant_recommendation: 'uphold',
        decided_at: null,
      });
      // Still banned; the platform decides: reduce to 2 days.
      const until = new Date(Date.now() + 2 * 86_400_000).toISOString();
      const [reduced] = await withContext(
        app,
        PLATFORM_ADMIN,
        (tx) =>
          tx<{ status_code: string; replacement_reference: string }[]>`
          select * from public.decide_appeal(${appealId}::uuid, 'reduce', 'first offence', ${until}::timestamptz)`,
      );
      expect(reduced!.status_code).toBe('reduced');
      expect(reduced!.replacement_reference).toMatch(/^BN-/);
      expect(await state(OTHER)).toEqual({ severity_code: 'banned', source: 'area' });
    });

    it('an area that does not decide in time loses the appeal to the platform', async () => {
      await endAllBans();
      const ban = await issue(MOD_A, { user: TWIN, severity: 'restricted' });
      const [appeal] = await withContext(
        app,
        as(TWIN),
        (tx) =>
          tx<
            { id: string }[]
          >`select * from public.appeal_submit_in_app(${ban.id}::uuid, 'please review')`,
      );
      // Not due yet.
      expect(
        await withContext(app, SYSTEM, (tx) => tx`select * from public.escalate_due_appeals(100)`),
      ).toHaveLength(0);
      await admin`update ban_appeals set escalate_at = now() - interval '1 minute' where id = ${appeal!.id}`;
      const escalated = await withContext(
        app,
        SYSTEM,
        (tx) => tx<{ id: string }[]>`select * from public.escalate_due_appeals(100)`,
      );
      expect(escalated.map((e) => e.id)).toEqual([appeal!.id]);
      const [row] = await admin<
        { queue_code: string; status_code: string; escalation_reason: string }[]
      >`
        select queue_code, status_code, escalation_reason from ban_appeals where id = ${appeal!.id}`;
      expect(row).toEqual({
        queue_code: 'platform',
        status_code: 'escalated',
        escalation_reason: 'timeout',
      });
      // The area admin can no longer decide it.
      expect(
        await rejection(
          withContext(
            app,
            ADMIN_A,
            (tx) =>
              tx`select * from public.decide_appeal(${appeal!.id}::uuid, 'grant', null, null)`,
          ),
        ),
      ).toBe('AE804:not_your_queue');
      // A grant by the area while it was theirs would have been final — granting is in the person's favour.
      const [granted] = await withContext(
        app,
        PLATFORM_ADMIN,
        (tx) =>
          tx<
            { status_code: string }[]
          >`select * from public.decide_appeal(${appeal!.id}::uuid, 'grant', null, null)`,
      );
      expect(granted!.status_code).toBe('granted');
      expect(await state(TWIN)).toBeUndefined();
    });

    it('the notice shows the reason code, the area name and the reference — never the internal text', async () => {
      await endAllBans();
      await issue(MOD_A, { user: TWIN });
      const notices = await withContext(
        app,
        as(TWIN, TENANT_B),
        (tx) => tx<Record<string, unknown>[]>`select * from public.my_ban_notices()`,
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        kind: 'area',
        reason_code: 'scam',
        area_name_bn: 'মিরপুর-ফিক্সচার',
        can_appeal: true,
      });
      expect(Object.keys(notices[0]!)).not.toContain('reason_text');
    });
  });

  describe('complaints', () => {
    let complaintId = '';

    it('a member complains about a store: priority from the category, due from the SLA setting', async () => {
      const [row] = await withContext(
        app,
        as(REPORTER),
        (tx) =>
          tx<{ id: string; priority_code: string; due_at: Date; reference_code: string }[]>`
          select * from public.submit_complaint('store', ${STORE}::uuid, 'scam', 'took 5000 taka advance, phone off', '[]'::text::jsonb)`,
      );
      complaintId = row!.id;
      expect(row!.priority_code).toBe('urgent');
      expect(Math.round((row!.due_at.getTime() - Date.now()) / 3_600_000)).toBe(4);
      expect(row!.reference_code).toMatch(/^CP-/);
      expect(
        await rejection(
          withContext(
            app,
            as(REPORTER),
            (tx) =>
              tx`select * from public.submit_complaint('store', ${STORE}::uuid, 'other', 'again', '[]'::text::jsonb)`,
          ),
        ),
      ).toBe('AE806:open_complaint');
      expect(
        await rejection(
          withContext(
            app,
            as(BAD),
            (tx) =>
              tx`select * from public.submit_complaint('store', ${STORE}::uuid, 'other', 'own', '[]'::text::jsonb)`,
          ),
        ),
      ).toBe('AE806:self');
      expect(
        await rejection(
          withContext(
            app,
            as(REPORTER),
            (tx) =>
              tx`select * from public.submit_complaint('user', ${U(ADMIN_B)}::uuid, 'abuse', 'not from here', '[]'::text::jsonb)`,
          ),
        ),
      ).toBe('AE806:subject_not_found');
    });

    it("only this area's staff and executives see it; the reporter sees their own", async () => {
      const exec = await withContext(
        app,
        EXEC_A,
        (tx) =>
          tx<{ id: string }[]>`select id from public.complaint_queue_page(null, false, null, 50)`,
      );
      expect(exec.map((r) => r.id)).toContain(complaintId);
      expect(
        await withContext(
          app,
          ADMIN_TB,
          (tx) => tx`select id from public.complaint_queue_page(null, false, null, 50)`,
        ),
      ).toHaveLength(0);
      expect(
        await withContext(
          app,
          ADMIN_TB,
          (tx) => tx`select id from complaints where id = ${complaintId}`,
        ),
      ).toHaveLength(0);
      expect(
        await withContext(
          app,
          as(OTHER),
          (tx) => tx`select id from complaints where id = ${complaintId}`,
        ),
      ).toHaveLength(0);
      const mine = await withContext(
        app,
        as(REPORTER, TENANT_B),
        (tx) => tx<{ id: string }[]>`select id from public.my_complaints()`,
      );
      expect(mine.map((r) => r.id)).toEqual([complaintId]);
      expect(
        await rejection(
          withContext(
            app,
            as(REPORTER),
            (tx) => tx`update complaints set status_code = 'resolved' where id = ${complaintId}`,
          ),
        ),
      ).toBe('42501');
    });

    it('assignment to staff only; a priority change moves the due time; resolution needs words', async () => {
      expect(
        await rejection(
          withContext(
            app,
            MOD_A,
            (tx) =>
              tx`select * from public.update_complaint(${complaintId}::uuid, true, ${U(OTHER)}::uuid, null, null)`,
          ),
        ),
      ).toBe('AE807:assignee');
      const [assigned] = await withContext(
        app,
        MOD_A,
        (tx) =>
          tx<{ newly_assigned: boolean; due_at: Date }[]>`
          select * from public.update_complaint(${complaintId}::uuid, true, ${U(EXEC)}::uuid, 'normal', 'in_progress')`,
      );
      expect(assigned!.newly_assigned).toBe(true);
      expect(Math.round((assigned!.due_at.getTime() - Date.now()) / 3_600_000)).toBe(72);
      const mine = await withContext(
        app,
        EXEC_A,
        (tx) =>
          tx<{ id: string }[]>`select id from public.complaint_queue_page(null, true, null, 50)`,
      );
      expect(mine.map((r) => r.id)).toEqual([complaintId]);
      expect(
        await rejection(
          withContext(
            app,
            EXEC_A,
            (tx) => tx`select * from public.resolve_complaint(${complaintId}::uuid, ' ', null)`,
          ),
        ),
      ).toBe('AE807:resolution_required');
    });

    it('the SLA job flags an overdue complaint once; resolving closes it', async () => {
      await admin`update complaints set due_at = now() - interval '1 minute' where id = ${complaintId}`;
      const breaches = await withContext(
        app,
        SYSTEM,
        (tx) =>
          tx<
            { id: string; assigned_to_user_id: string }[]
          >`select * from public.due_complaint_sla_breaches(100)`,
      );
      expect(breaches).toEqual([
        expect.objectContaining({ id: complaintId, assigned_to_user_id: U(EXEC) }),
      ]);
      expect(
        await withContext(
          app,
          SYSTEM,
          (tx) => tx`select * from public.due_complaint_sla_breaches(100)`,
        ),
      ).toHaveLength(0);
      const [done] = await withContext(
        app,
        EXEC_A,
        (tx) =>
          tx<
            { reporter_user_id: string }[]
          >`select * from public.resolve_complaint(${complaintId}::uuid, 'store warned, refund arranged', null)`,
      );
      expect(done!.reporter_user_id).toBe(U(REPORTER));
      const [row] = await admin<
        { status_code: string }[]
      >`select status_code from complaints where id = ${complaintId}`;
      expect(row!.status_code).toBe('resolved');
    });
  });
});
