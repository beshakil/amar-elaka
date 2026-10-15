import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * Verification in the database (0058, ADR 062), as ae_app under RLS:
 *  - who may ask: a member with a verified phone (identity); a store's owner
 *    whose identity is checked (business); one open request at a time; not
 *    while an approval is valid beyond the renewal window;
 *  - evidence: the caller's own ready private uploads only, used nowhere else;
 *  - the decision: staff only, never one's own; writes moderation_actions;
 *    the badge caches (stores.is_verified, seller_profiles) follow at once;
 *  - an expired verification drops the badge; reminders go once;
 *  - documents are purged after the retention, never under a legal hold;
 *  - the NID hash: the same NID on two accounts is flagged;
 *  - RLS: no direct write; tenant B's staff see none of tenant A's requests;
 *    evidence is staff-only.
 */

const P = '0191e3a0-7e3e-7000-8000-';
const FIXTURE = `${P}%`;
const PARTNER = `${P}000000000001`;
const AREA_A = `${P}000000000011`;
const AREA_B = `${P}000000000012`;
const TENANT_A = `${P}000000000021`;
const TENANT_B = `${P}000000000022`;
const U = (n: number) => `${P}0000000000${30 + n}`;
const M = (n: number) => `${P}0000000000${50 + n}`;
const [OWNER, OTHER, NOPHONE, MOD, MOD_B, TWIN] = [1, 2, 3, 4, 5, 6];
const STORE = `${P}000000000071`;
const HASH = 'a'.repeat(64);
const HASH_OTHER = 'b'.repeat(64);
let mediaCounter = 0;

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
const SYSTEM: Context = { role: 'system' };

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
      return e.code === 'AE701' ? `AE701:${e.detail}` : (e.code ?? 'unknown');
    },
  );
}

describe('Verification in the database (0058)', () => {
  let app: Sql;
  let admin: Sql;

  /** A ready private upload by user n in tenant A. */
  const upload = async (n: number, kind = 'verification_image'): Promise<string> => {
    mediaCounter += 1;
    const id = `${P}0000000009${String(mediaCounter).padStart(2, '0')}`;
    await admin`insert into media_assets (id, tenant_id, uploaded_by_user_id, kind_code, visibility_code, storage_key, mime_type, byte_size, checksum_sha256, status_code)
                values (${id}, ${TENANT_A}, ${U(n)}, ${kind}, 'private', ${`verification-db/${id}`}, 'image/jpeg', 1000, ${'c'.repeat(64)}, 'ready')`;
    return id;
  };

  const submitIdentity = async (n: number, hash = HASH, selfie?: string) =>
    withContext(app, as(n), async (tx) => {
      const media = selfie ?? (await upload(n));
      const [row] = await tx<{ verification_id: string; nid_duplicate: boolean }[]>`
        select verification_id, nid_duplicate from public.submit_identity_verification(${hash}, '789', ${media}::uuid)`;
      return row!;
    });

  const submitBusiness = async (n: number) => {
    const licence = await upload(n, 'document');
    const front = await upload(n);
    return withContext(app, as(n), async (tx) => {
      const [row] = await tx<{ verification_id: string }[]>`
        select verification_id from public.submit_business_verification(${STORE}::uuid, ${licence}::uuid, ${front}::uuid)`;
      return row!.verification_id;
    });
  };

  const decide = (
    id: string,
    decision: string,
    ctx: Context = MOD_A,
    reason: string | null = null,
    expires: string | null = null,
  ) =>
    withContext(
      app,
      ctx,
      (tx) =>
        tx<{ status_code: string }[]>`
        select status_code from public.decide_verification(${id}::uuid, ${decision}, ${reason}, 'checked', ${expires}::timestamptz)`,
    ).then((r) => r[0]!.status_code);

  const storeVerified = () =>
    admin<{ is_verified: boolean }[]>`select is_verified from stores where id = ${STORE}`.then(
      (r) => r[0]!.is_verified,
    );
  const level = (fn: 'user' | 'store', id: string) =>
    admin<
      { level: string }[]
    >`select ${fn === 'user' ? admin`public.verification_level_of_user(${id}::uuid)` : admin`public.verification_level_of_store(${id}::uuid)`} as level`.then(
      (r) => r[0]!.level,
    );

  async function cleanUp(): Promise<void> {
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      for (const table of [
        'moderation_actions',
        'verification_evidence',
        'verifications',
        'media_assets',
        'seller_profiles',
        'member_trust_scores',
        'store_seller_scores',
        'review_prompts',
        'stores',
        'tenant_members',
      ]) {
        await tx.unsafe(`delete from ${table} where tenant_id::text like $1`, [FIXTURE]);
      }
    });
    await admin`delete from legal_holds where subject_id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    app = testSqlClient(4, resolveTestAppDatabaseUrl());
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();
    for (const n of [OWNER, OTHER, NOPHONE, MOD, MOD_B, TWIN]) {
      await admin`insert into users (id, phone_e164, phone_verified_at)
                  values (${U(n)}, ${`+88019${String(n).padStart(2, '0')}777777`}, ${n === NOPHONE ? null : new Date()})`;
    }
    await admin`insert into partners (id, legal_name, display_name, phone_e164)
                values (${PARTNER}, 'Verify Fixture', 'Verify Fixture', '+8801747000099')`;
    await admin`insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
      (${AREA_A}, 3, 'upazila', 'verify-db-a', 'Verify A', 'fixture'),
      (${AREA_B}, 3, 'upazila', 'verify-db-b', 'Verify B', 'fixture')`;
    await admin`insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
      (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'verify-db-a', 'এ', 'A', st_point(91.1, 22.1)::geography, 'active'),
      (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'verify-db-b', 'বি', 'B', st_point(91.2, 22.1)::geography, 'active')`;
    for (const n of [OWNER, OTHER, NOPHONE, TWIN]) {
      await admin`insert into tenant_members (id, tenant_id, user_id, role_code) values (${M(n)}, ${TENANT_A}, ${U(n)}, 'member')`;
    }
    await admin`insert into tenant_members (id, tenant_id, user_id, role_code) values
      (${M(MOD)}, ${TENANT_A}, ${U(MOD)}, 'moderator'), (${M(MOD_B)}, ${TENANT_B}, ${U(MOD_B)}, 'moderator')`;
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`insert into stores (id, tenant_id, owner_member_id, slug, name_bn, status_code)
               values (${STORE}, ${TENANT_A}, ${M(OWNER)}, 'verify-db-store', 'যাচাই দোকান', 'active')`;
      await tx`insert into seller_profiles (tenant_id, member_id, seller_type_code) values (${TENANT_A}, ${M(OWNER)}, 'individual')
               on conflict do nothing`;
    });
  });

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await Promise.all([app.end(), admin.end()]);
    }
  });

  let identityId = '';
  let businessId = '';

  describe('who may ask', () => {
    it('identity needs a verified phone first', async () => {
      expect(await rejection(submitIdentity(NOPHONE))).toBe('AE701:phone_unverified');
      expect(await level('user', U(NOPHONE))).toBe('none');
      expect(await level('user', U(OTHER))).toBe('phone_verified');
    });

    it('business needs the owner identity checked first, and only the owner', async () => {
      expect(await rejection(submitBusiness(OWNER))).toBe('AE701:identity_required');
      expect(await rejection(submitBusiness(OTHER))).toBe('AE701:not_owner');
    });

    it('identity: submitted, one open request at a time', async () => {
      const row = await submitIdentity(OWNER);
      identityId = row.verification_id;
      expect(row.nid_duplicate).toBe(false);
      expect(await rejection(submitIdentity(OWNER, HASH_OTHER))).toBe('AE701:open_request');
    });

    it('evidence must be the caller’s own, ready, unused upload (AE702)', async () => {
      const someoneElses = await upload(OTHER);
      expect(await rejection(submitIdentity(TWIN, HASH_OTHER, someoneElses))).toBe('AE702');
    });

    it('the same NID on another account is flagged for the reviewer', async () => {
      const row = await submitIdentity(TWIN, HASH);
      expect(row.nid_duplicate).toBe(true);
    });

    it('nobody writes a verification row directly', async () => {
      const direct = withContext(
        app,
        as(OTHER),
        (tx) =>
          tx`insert into verifications (subject_type, subject_id, level_code, submitted_by_user_id, nid_hash, nid_last3)
           values ('member', ${U(OTHER)}, 'identity_checked', ${U(OTHER)}, ${HASH_OTHER}, '111')`,
      );
      expect(await rejection(direct)).toBe('42501');
    });
  });

  describe('the decision', () => {
    it('staff only, never their own; writes moderation_actions; the badge follows', async () => {
      expect(await rejection(decide(identityId, 'approve', as(OTHER)))).toBe('42501');
      expect(await decide(identityId, 'approve')).toBe('approved');
      const [action] = await admin<{ action_code: string; reason_code: string }[]>`
        select action_code, reason_code from moderation_actions where verification_id = ${identityId}`;
      expect(action).toEqual({ action_code: 'approved', reason_code: 'verification_review' });
      expect(await level('user', U(OWNER))).toBe('identity_checked');
      const [profile] = await admin<{ verification_level_code: string }[]>`
        select verification_level_code from seller_profiles where member_id = ${M(OWNER)}`;
      expect(profile!.verification_level_code).toBe('identity');
    });

    it('a rejection needs a reason; a visit is only for a business', async () => {
      const twin = (
        await admin<{ id: string }[]>`select id from verifications where subject_id = ${U(TWIN)}`
      )[0]!.id;
      expect(await rejection(decide(twin, 'reject'))).toBe('AE704');
      expect(await rejection(decide(twin, 'request_visit'))).toBe('AE704');
      expect(await decide(twin, 'reject', MOD_A, 'suspected_fraud')).toBe('rejected');
    });

    it('business: submitted once identity is checked; a visit can be asked; approved → store verified', async () => {
      businessId = await submitBusiness(OWNER);
      expect(await decide(businessId, 'request_visit')).toBe('in_review');
      const [row] = await admin<
        { visit_status: string }[]
      >`select visit_status from verifications where id = ${businessId}`;
      expect(row!.visit_status).toBe('requested');
      expect(await storeVerified()).toBe(false);
      const licenceEnds = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString();
      expect(await decide(businessId, 'approve', MOD_A, null, licenceEnds)).toBe('approved');
      expect(await storeVerified()).toBe(true);
      expect(await level('store', STORE)).toBe('business_verified');
      const [approved] = await admin<{ expires_at: Date; visit_status: string }[]>`
        select expires_at, visit_status from verifications where id = ${businessId}`;
      // The licence's end, earlier than the level's 365 days.
      expect(
        Math.abs(approved!.expires_at.getTime() - new Date(licenceEnds).getTime()),
      ).toBeLessThan(1000);
      expect(approved!.visit_status).toBe('done');
    });

    it('no new request while the approval is valid beyond the renewal window', async () => {
      expect(await rejection(submitIdentity(OWNER, HASH))).toBe('AE701:already_verified');
    });
  });

  describe('RLS', () => {
    it("tenant B's moderator sees none of tenant A's requests or evidence, and can't decide them", async () => {
      const seen = await withContext(app, as(MOD_B, TENANT_B, 'moderator'), async (tx) => ({
        rows: (await tx`select 1 from verifications where tenant_id = ${TENANT_A}`).length,
        evidence: (await tx`select 1 from verification_evidence where tenant_id = ${TENANT_A}`)
          .length,
        queue: (await tx`select 1 from public.verification_queue_page(null, 50)`).length,
      }));
      expect(seen).toEqual({ rows: 0, evidence: 0, queue: 0 });
      const id = (
        await admin<{ id: string }[]>`
        select id from verifications where subject_id = ${U(TWIN)} order by id desc limit 1`
      )[0]!.id;
      await admin`update verifications set status_code = 'submitted', reviewed_at = null, reviewed_by_user_id = null,
                  rejection_reason_code = null where id = ${id}`;
      expect(await rejection(decide(id, 'approve', as(MOD_B, TENANT_B, 'moderator')))).toBe(
        'AE703',
      );
    });

    it('a member reads their own request, never evidence; the store owner reads the store’s', async () => {
      const own = await withContext(app, as(OWNER), async (tx) => ({
        mine: (await tx`select 1 from verifications where subject_id = ${U(OWNER)}`).length,
        store: (await tx`select 1 from verifications where subject_id = ${STORE}`).length,
        evidence: (await tx`select 1 from verification_evidence`).length,
        others: (await tx`select 1 from verifications where subject_id = ${U(TWIN)}`).length,
      }));
      expect(own).toEqual({ mine: 1, store: 1, evidence: 0, others: 0 });
    });
  });

  describe('expiry drops the badge', () => {
    it('reminds once inside the renewal window', async () => {
      await admin`update verifications set expires_at = now() + interval '3 days' where id = ${businessId}`;
      const remind = () =>
        withContext(app, SYSTEM, (tx) => tx`select * from public.due_verification_reminders(50)`);
      expect((await remind()).length).toBe(1);
      expect((await remind()).length).toBe(0);
    });

    it('past its date: expired, the store badge and the owner’s identity badge gone', async () => {
      await admin`update verifications set expires_at = now() - interval '1 minute' where id in (${businessId}, ${identityId})`;
      const expired = await withContext(
        app,
        SYSTEM,
        (tx) => tx<{ verification_id: string }[]>`
        select verification_id from public.expire_verifications(50)`,
      );
      expect(expired.map((e) => e.verification_id).sort()).toEqual([businessId, identityId].sort());
      expect(await storeVerified()).toBe(false);
      expect(await level('store', STORE)).toBe('phone_verified');
      expect(await level('user', U(OWNER))).toBe('phone_verified');
      const [profile] = await admin<{ verification_level_code: string }[]>`
        select verification_level_code from seller_profiles where member_id = ${M(OWNER)}`;
      expect(profile!.verification_level_code).toBe('phone');
    });

    it('the expiry job is the system’s only', async () => {
      expect(
        await rejection(
          withContext(app, MOD_A, (tx) => tx`select * from public.expire_verifications(5)`),
        ),
      ).toBe('42501');
    });
  });

  describe('document retention', () => {
    const purge = () =>
      withContext(
        app,
        SYSTEM,
        (tx) => tx<{ n: number }[]>`select public.purge_verification_documents(50) as n`,
      ).then((r) => r[0]!.n);

    it('not before the retention; then the files go to the media purge, the decision stays', async () => {
      expect(await purge()).toBe(0);
      await admin`update verifications set reviewed_at = now() - interval '91 days' where id = ${identityId}`;
      expect(await purge()).toBe(1);
      const [v] = await admin<
        { documents_purged_at: Date | null; nid_hash: string; status_code: string }[]
      >`
        select documents_purged_at, nid_hash, status_code from verifications where id = ${identityId}`;
      expect(v!.documents_purged_at).not.toBeNull();
      expect(v!.nid_hash).toBe(HASH);
      const [m] = await admin<{ purge_due_at: Date | null }[]>`
        select m.purge_due_at from media_assets m join verification_evidence e on e.media_asset_id = m.id
        where e.verification_id = ${identityId}`;
      expect(m!.purge_due_at).not.toBeNull();
    });

    it('never under a legal hold', async () => {
      await admin`insert into legal_holds (subject_tenant_id, subject_type_code, subject_id, reason, placed_by_user_id)
                  values (${TENANT_A}, 'store', ${STORE}, 'court order', ${U(MOD)})`;
      await admin`update verifications set reviewed_at = now() - interval '91 days' where id = ${businessId}`;
      expect(await purge()).toBe(0);
      const [v] = await admin<{ documents_purged_at: Date | null }[]>`
        select documents_purged_at from verifications where id = ${businessId}`;
      expect(v!.documents_purged_at).toBeNull();
    });
  });

  it('the NID columns hold a hash and 3 digits only (CHECK)', async () => {
    const bad = admin`update verifications set nid_hash = '1234567890123' where id = ${identityId}`;
    expect(await rejection(bad)).toBe('23514');
    const bad3 = admin`update verifications set nid_last3 = '7890' where id = ${identityId}`;
    expect(await rejection(bad3)).toBe('23514');
  });
});
