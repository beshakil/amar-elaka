import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * Migration 0042 (ADR 047), as ae_app: who may write which place columns,
 * place_revisions (written only by the database, merged per transaction,
 * immutable once committed, readable by editors of the owning tenant only),
 * revert_place_revision, and approve_place_claim — conflicting claims,
 * two approvals racing for one place, carry-over of saves and reviews, the
 * auto-approval rules and the moderation_actions trail.
 */

const FIXTURE = '0191e3a0-91ac-7000-8000-%';
const PARTNER = '0191e3a0-91ac-7000-8000-000000000001';
const AREA_A = '0191e3a0-91ac-7000-8000-000000000011';
const AREA_B = '0191e3a0-91ac-7000-8000-000000000012';
const TENANT_A = '0191e3a0-91ac-7000-8000-000000000021';
const TENANT_B = '0191e3a0-91ac-7000-8000-000000000022';
const OWNER = '0191e3a0-91ac-7000-8000-000000000031';
const RIVAL = '0191e3a0-91ac-7000-8000-000000000032';
const MOD = '0191e3a0-91ac-7000-8000-000000000033';
const AGENT = '0191e3a0-91ac-7000-8000-000000000034';
const MEMBER = '0191e3a0-91ac-7000-8000-000000000035';
const MOD_B = '0191e3a0-91ac-7000-8000-000000000036';
const M_OWNER = '0191e3a0-91ac-7000-8000-000000000041';
const M_RIVAL = '0191e3a0-91ac-7000-8000-000000000042';
const M_MOD = '0191e3a0-91ac-7000-8000-000000000043';
const M_AGENT = '0191e3a0-91ac-7000-8000-000000000044';
const M_MEMBER = '0191e3a0-91ac-7000-8000-000000000045';
const M_MOD_B = '0191e3a0-91ac-7000-8000-000000000046';
const CATEGORY = '0191e3a0-91ac-7000-8000-000000000051';

const square = (west: number, east: number) =>
  `SRID=4326;MULTIPOLYGON(((${west} 20.0,${east} 20.0,${east} 20.1,${west} 20.1,${west} 20.0)))`;
const POINT = 'SRID=4326;POINT(92.45 20.05)';

type Context = Record<string, string>;
const ctx = (user: string, member: string, role: string, tenant = TENANT_A): Context => ({
  tenant_id: tenant,
  user_id: user,
  member_id: member,
  role,
});
const AS_OWNER = ctx(OWNER, M_OWNER, 'member');
const AS_RIVAL = ctx(RIVAL, M_RIVAL, 'member');
const AS_MOD = ctx(MOD, M_MOD, 'moderator');
const AS_AGENT = ctx(AGENT, M_AGENT, 'agent');
const AS_MEMBER = ctx(MEMBER, M_MEMBER, 'member');
const AS_MOD_B = ctx(MOD_B, M_MOD_B, 'moderator', TENANT_B);

async function as<T>(sql: Sql, context: Context, work: (tx: TransactionSql) => Promise<T>) {
  return sql.begin(async (tx) => {
    for (const [key, value] of Object.entries(context)) {
      await tx`select set_config(${`app.${key}`}, ${value}, true)`;
    }
    return work(tx);
  }) as Promise<T>;
}

/** The SQLSTATE a promise rejects with. */
async function stateOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

let next = 0x1000;
const newId = () => `0191e3a0-91ac-7000-8000-${(next++).toString(16).padStart(12, '0')}`;

interface Revision {
  id: string;
  kind_code: string;
  changed_fields: Record<string, { from: unknown; to: unknown }>;
  changed_by_user_id: string | null;
  reverts_revision_id: string | null;
}

describe('Places, revisions and claims (0042)', () => {
  let admin: Sql;
  let app: Sql;
  let app2: Sql;

  const place = async (extra: { phones?: string[]; status?: string } = {}): Promise<string> => {
    const id = newId();
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`
        insert into places (id, tenant_id, category_id, slug, name_bn, phones, status_code, location, source_code)
        values (${id}, ${TENANT_A}, ${CATEGORY}, ${`fixture-${id.slice(-6)}`}, 'রহিম স্টোর',
                ${extra.phones ?? ['+8801744000001']}, ${extra.status ?? 'published'}, ${POINT}, 'agent_survey')`;
    });
    return id;
  };

  const claim = (context: Context, placeId: string, otp = false) =>
    as(app, context, async (tx) => {
      const [row] = await tx<{ id: string; status_code: string }[]>`
        insert into place_claims
          (place_id, claimant_member_id, verification_method_code, evidence_codes,
           otp_verified_phone_e164, otp_verified_at, status_code)
        values (${placeId}, ${context.member_id!},
                ${otp ? 'otp_to_listed_phone' : 'trade_license'},
                ${otp ? ['otp_to_listed_phone'] : ['trade_license']},
                ${otp ? '+8801744000001' : null}, ${otp ? new Date() : null},
                'approved')
        returning id, status_code`;
      return row!;
    });

  const approve = (
    context: Context,
    claimId: string,
    auto = false,
    storeId: string | null = null,
  ) =>
    as(
      app,
      context,
      (tx) => tx`
      select * from approve_place_claim(${claimId}, ${storeId}::uuid, ${auto})`,
    );

  const revisionsOf = (placeId: string) =>
    admin<Revision[]>`
      select id, kind_code, changed_fields, changed_by_user_id, reverts_revision_id
      from place_revisions where place_id = ${placeId} order by id`;

  async function cleanUp(): Promise<void> {
    // Places/stores made through the API (and the store an approval creates)
    // have random ids: their search outbox events are found through the rows.
    const rows = await admin<{ id: string }[]>`
      select id from places where tenant_id::text like ${FIXTURE}
      union all select id from stores where tenant_id::text like ${FIXTURE}
      union all select id from tenant_categories where tenant_id::text like ${FIXTURE}`;
    const aggregateIds = rows.map((r) => r.id);
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from moderation_actions where tenant_id::text like ${FIXTURE}`;
    });
    await admin`delete from notifications where user_id::text like ${FIXTURE}`;
    await admin`delete from reviews where tenant_id::text like ${FIXTURE}`;
    await admin`delete from saved_places where tenant_id::text like ${FIXTURE}`;
    await admin`delete from saved_stores where tenant_id::text like ${FIXTURE}`;
    await admin`delete from place_claims where tenant_id::text like ${FIXTURE}`;
    await admin`update places set claim_store_id = null where tenant_id::text like ${FIXTURE}`;
    await admin`delete from stores where tenant_id::text like ${FIXTURE}`;
    await admin`delete from place_hours where tenant_id::text like ${FIXTURE}`;
    await admin`delete from places where tenant_id::text like ${FIXTURE}`;
    await admin`delete from outbox_events where aggregate_id::text like ${FIXTURE}`;
    await admin`delete from member_trust_scores where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_categories where tenant_id::text like ${FIXTURE}`;
    await admin`delete from categories where id::text like ${FIXTURE}`;
    await admin`delete from tenant_members where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_settings where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
    if (aggregateIds.length > 0) {
      await admin`delete from outbox_events where aggregate_id in ${admin(aggregateIds)}`;
    }
  }

  async function setAutoApprove(enabled: boolean): Promise<void> {
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'platform_admin', true)`;
      await tx`
        update tenant_settings
        set setting_overrides = setting_overrides || ${tx.json({ place_claim_otp_auto_approve: enabled })}
        where tenant_id = ${TENANT_A}`;
    });
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    app = testSqlClient(1, resolveTestAppDatabaseUrl());
    app2 = testSqlClient(1, resolveTestAppDatabaseUrl());
    await cleanUp();

    await admin`
      insert into users (id, phone_e164) values
        (${OWNER}, '+8801744000011'), (${RIVAL}, '+8801744000012'), (${MOD}, '+8801744000013'),
        (${AGENT}, '+8801744000014'), (${MEMBER}, '+8801744000015'), (${MOD_B}, '+8801744000016')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Places Partner', 'Places Partner', '+8801744000099')`;
    await admin`
      insert into geo_areas
        (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release, boundary, boundary_simplified)
      values
        (${AREA_A}, 3, 'upazila', 'places-a', 'Places A', 'fixture', ${square(92.4, 92.5)}, ${square(92.4, 92.5)}),
        (${AREA_B}, 3, 'upazila', 'places-b', 'Places B', 'fixture', ${square(92.5, 92.6)}, ${square(92.5, 92.6)})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values
        (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'places-a', 'এ', 'A', ${POINT}, 'active'),
        (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'places-b', 'বি', 'B', 'SRID=4326;POINT(92.55 20.05)', 'active')`;
    await admin`insert into tenant_settings (tenant_id) values (${TENANT_A}), (${TENANT_B})`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${M_OWNER}, ${TENANT_A}, ${OWNER}, 'member'), (${M_RIVAL}, ${TENANT_A}, ${RIVAL}, 'member'),
        (${M_MOD}, ${TENANT_A}, ${MOD}, 'moderator'), (${M_AGENT}, ${TENANT_A}, ${AGENT}, 'agent'),
        (${M_MEMBER}, ${TENANT_A}, ${MEMBER}, 'member'), (${M_MOD_B}, ${TENANT_B}, ${MOD_B}, 'moderator')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en)
      values (${CATEGORY}, 'place', 'places-db-shop', 'দোকান', 'Shop')`;
  }, 60_000);

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await admin.end();
      await app.end();
      await app2.end();
    }
  });

  describe('who writes what on a place', () => {
    it("a member's new place is pending and theirs to read, with no owner or rating of their choosing", async () => {
      const id = newId();
      const [row] = await as(
        app,
        AS_MEMBER,
        (tx) => tx<
          {
            status_code: string;
            claimed_by_member_id: string | null;
            created_by_user_id: string;
            rating_count: number;
          }[]
        >`
        insert into places (id, category_id, slug, name_bn, location, source_code, status_code,
                            claimed_by_member_id, created_by_user_id, rating_count)
        values (${id}, ${CATEGORY}, ${`member-${id.slice(-6)}`}, 'নতুন দোকান', ${POINT}, 'user_submitted',
                'rejected', ${M_MEMBER}, ${OWNER}, 99)
        returning status_code, claimed_by_member_id, created_by_user_id, rating_count`,
      );
      expect(row).toEqual({
        status_code: 'pending_review',
        claimed_by_member_id: null,
        created_by_user_id: MEMBER,
        rating_count: 0,
      });
      // Someone else in the tenant doesn't see a pending place.
      const seen = await as(app, AS_RIVAL, (tx) => tx`select id from places where id = ${id}`);
      expect(seen).toHaveLength(0);
    });

    it('a plain member cannot edit a place; a claimed owner toggles open/closed but nothing else', async () => {
      const id = await place();
      const edited = await as(
        app,
        AS_MEMBER,
        (tx) => tx`
        update places set name_bn = 'ভাঙচুর' where id = ${id} returning id`,
      );
      expect(edited).toHaveLength(0);

      await admin.begin(async (tx) => {
        await tx`select set_config('app.role', 'system', true)`;
        await tx`update places set claimed_by_member_id = ${M_OWNER} where id = ${id}`;
      });
      const [after] = await as(
        app,
        AS_OWNER,
        (tx) => tx<{ status_code: string; claimed_by_member_id: string }[]>`
        update places set status_code = 'temporarily_closed', claimed_by_member_id = ${M_RIVAL}
        where id = ${id} returning status_code, claimed_by_member_id`,
      );
      expect(after).toEqual({ status_code: 'temporarily_closed', claimed_by_member_id: M_OWNER });
      const [again] = await as(
        app,
        AS_OWNER,
        (tx) => tx<{ status_code: string }[]>`
        update places set status_code = 'pending_review' where id = ${id} returning status_code`,
      );
      expect(again!.status_code).toBe('temporarily_closed');
    });

    it("a claimant's claim always starts pending, whatever they send", async () => {
      const id = await place();
      expect((await claim(AS_OWNER, id)).status_code).toBe('pending');
    });
  });

  describe('place_revisions', () => {
    it('records the creation and each edit, with who did it', async () => {
      const id = await place();
      await as(
        app,
        AS_AGENT,
        (tx) => tx`update places set name_bn = 'করিম স্টোর' where id = ${id}`,
      );
      const revisions = await revisionsOf(id);
      expect(revisions.map((r) => r.kind_code)).toEqual(['created', 'edited']);
      expect(revisions[0]!.changed_fields.name_bn).toEqual({ from: null, to: 'রহিম স্টোর' });
      expect(revisions[1]).toMatchObject({
        changed_by_user_id: AGENT,
        changed_fields: { name_bn: { from: 'রহিম স্টোর', to: 'করিম স্টোর' } },
      });
      expect(Object.keys(revisions[1]!.changed_fields)).toEqual(['name_bn']);
    });

    it('merges changes in one transaction into one revision, and drops a change undone in it', async () => {
      const id = await place();
      await as(app, AS_AGENT, async (tx) => {
        await tx`update places set name_bn = 'এক' where id = ${id}`;
        await tx`update places set name_bn = 'দুই', address_text = 'বাজার রোড' where id = ${id}`;
        await tx`update places set address_text = null where id = ${id}`;
      });
      const revisions = await revisionsOf(id);
      expect(revisions).toHaveLength(2);
      expect(revisions[1]!.changed_fields).toEqual({ name_bn: { from: 'রহিম স্টোর', to: 'দুই' } });

      // A no-op update writes no revision at all.
      await as(app, AS_AGENT, (tx) => tx`update places set name_bn = 'দুই' where id = ${id}`);
      expect(await revisionsOf(id)).toHaveLength(2);
    });

    it('records opening hours through record_place_hours_revision, editors only', async () => {
      const id = await place();
      await as(app, AS_AGENT, async (tx) => {
        await tx`insert into place_hours (place_id, iso_day_of_week, opens_at, closes_at)
                 values (${id}, 1, '09:00', '21:00')`;
        await tx`select record_place_hours_revision(${id}, '[]'::jsonb, place_hours_json(${id}))`;
      });
      const [, hours] = await revisionsOf(id);
      expect(hours!.changed_fields.hours).toEqual({
        from: [],
        to: [{ day: 1, opens: '09:00', closes: '21:00', next_day: false }],
      });
      expect(
        await stateOf(
          as(
            app,
            AS_MEMBER,
            (tx) => tx`select record_place_hours_revision(${id}, '[]'::jsonb, '[1]'::jsonb)`,
          ),
        ),
      ).toBe('42501');
    });

    it('is immutable once committed and never written by the app directly', async () => {
      const id = await place();
      const [created] = await revisionsOf(id);
      expect(
        await stateOf(
          admin`update place_revisions set kind_code = 'edited' where id = ${created!.id}`,
        ),
      ).toBe('42501');
      expect(await stateOf(admin`delete from place_revisions where id = ${created!.id}`)).toBe(
        '42501',
      );
      expect(
        await stateOf(
          as(
            app,
            AS_MOD,
            (tx) => tx`
            insert into place_revisions (place_id, changed_fields, kind_code)
            values (${id}, '{"name_bn": {"from": "a", "to": "b"}}', 'edited')`,
          ),
        ),
      ).toBe('42501');
    });

    it("is readable by the tenant's editors only — never a member, never another tenant", async () => {
      const id = await place();
      const count = (context: Context) =>
        as(
          app,
          context,
          async (tx) => (await tx`select id from place_revisions where place_id = ${id}`).length,
        );
      expect(await count(AS_MOD)).toBe(1);
      expect(await count(AS_AGENT)).toBe(1);
      expect(await count(AS_MEMBER)).toBe(0);
      expect(await count(AS_MOD_B)).toBe(0);
    });
  });

  describe('revert_place_revision', () => {
    it('puts the old values back as a `reverted` revision, with a moderation_actions row', async () => {
      const id = await place({ phones: ['+8801744000001'] });
      await as(
        app,
        AS_AGENT,
        (tx) => tx`
        update places set name_bn = 'স্প্যাম!!!', phones = '{+8801744000666}' where id = ${id}`,
      );
      const bad = (await revisionsOf(id)).at(-1)!;

      const [reverted] = await as(
        app,
        AS_MOD,
        (tx) =>
          tx<
            { revert_place_revision: string }[]
          >`select revert_place_revision(${id}, ${bad.id}, 'spam', null)`,
      );
      const [row] = await admin<{ name_bn: string; phones: string[] }[]>`
        select name_bn, phones from places where id = ${id}`;
      expect(row).toEqual({ name_bn: 'রহিম স্টোর', phones: ['+8801744000001'] });
      const last = (await revisionsOf(id)).at(-1)!;
      expect(last).toMatchObject({
        id: reverted!.revert_place_revision,
        kind_code: 'reverted',
        reverts_revision_id: bad.id,
        changed_by_user_id: MOD,
      });
      const actions = await admin`
        select action_code, reason_code, actor_user_id from moderation_actions where place_id = ${id}`;
      expect(actions).toEqual([
        { action_code: 'reverted', reason_code: 'spam', actor_user_id: MOD },
      ]);
    });

    it('refuses when a field changed again since (AE222), and for non-staff', async () => {
      const id = await place();
      await as(app, AS_AGENT, (tx) => tx`update places set name_bn = 'এক' where id = ${id}`);
      const first = (await revisionsOf(id)).at(-1)!;
      await as(app, AS_AGENT, (tx) => tx`update places set name_bn = 'দুই' where id = ${id}`);

      expect(
        await stateOf(
          as(
            app,
            AS_MOD,
            (tx) => tx`select revert_place_revision(${id}, ${first.id}, 'spam', null)`,
          ),
        ),
      ).toBe('AE222');
      expect(
        await stateOf(
          as(
            app,
            AS_AGENT,
            (tx) => tx`select revert_place_revision(${id}, ${first.id}, 'spam', null)`,
          ),
        ),
      ).toBe('42501');
      // Another tenant's moderator can't even find it.
      expect(
        await stateOf(
          as(
            app,
            AS_MOD_B,
            (tx) => tx`select revert_place_revision(${id}, ${first.id}, 'spam', null)`,
          ),
        ),
      ).toBe('P0002');
    });

    it('reverts opening hours too', async () => {
      const id = await place();
      const setHours = (opens: string) =>
        as(app, AS_AGENT, async (tx) => {
          const [row] = await tx<{ before: unknown }[]>`select place_hours_json(${id}) as before`;
          const before = row!.before;
          await tx`delete from place_hours where place_id = ${id}`;
          await tx`insert into place_hours (place_id, iso_day_of_week, opens_at, closes_at)
                   values (${id}, 5, ${opens}::time, '20:00')`;
          await tx`select record_place_hours_revision(${id}, ${tx.json(before as never)}, place_hours_json(${id}))`;
        });
      await setHours('10:00');
      await setHours('03:00');
      const bad = (await revisionsOf(id)).at(-1)!;
      await as(
        app,
        AS_MOD,
        (tx) => tx`select revert_place_revision(${id}, ${bad.id}, 'other', 'wrong hours')`,
      );
      const hours =
        await admin`select to_char(opens_at, 'HH24:MI') as opens from place_hours where place_id = ${id}`;
      expect(hours).toEqual([{ opens: '10:00' }]);
    });
  });

  describe('approve_place_claim', () => {
    it('approves one claim: store created as the pin, rivals rejected, saves and reviews carried over, all audited', async () => {
      const id = await place();
      await admin`insert into saved_places (tenant_id, user_id, place_id) values (${TENANT_A}, ${MEMBER}, ${id})`;
      await admin`
        insert into reviews (tenant_id, reviewer_member_id, place_id, rating)
        values (${TENANT_A}, ${M_MEMBER}, ${id}, 4), (${TENANT_A}, ${M_AGENT}, ${id}, 2)`;
      const mine = await claim(AS_OWNER, id);
      const rivals = await claim(AS_RIVAL, id);

      const [result] = await approve(AS_MOD, mine.id);
      expect(result).toMatchObject({
        place_id: id,
        created_store: true,
        claimant_user_id: OWNER,
        superseded_claim_ids: [rivals.id],
        superseded_user_ids: [RIVAL],
      });
      const storeId = result!.store_id as string;

      const [pl] =
        await admin`select claimed_by_member_id, claim_store_id from places where id = ${id}`;
      expect(pl).toEqual({ claimed_by_member_id: M_OWNER, claim_store_id: storeId });
      const [store] = await admin<
        {
          owner_member_id: string;
          place_id: string;
          status_code: string;
          same_point: boolean;
          rating_count: number;
          rating_avg: string;
        }[]
      >`
        select s.owner_member_id, s.place_id, s.status_code, st_equals(s.location::geometry, p.location::geometry) as same_point,
               s.rating_count, s.rating_avg::text as rating_avg
        from stores s join places p on p.id = s.place_id where s.id = ${storeId}`;
      expect(store).toEqual({
        owner_member_id: M_OWNER,
        place_id: id,
        status_code: 'active',
        same_point: true,
        rating_count: 2,
        rating_avg: '3.00',
      });
      const claims = await admin`
        select id, status_code, rejection_reason_code, store_id from place_claims where place_id = ${id} order by id`;
      expect(claims).toEqual([
        { id: mine.id, status_code: 'approved', rejection_reason_code: null, store_id: storeId },
        {
          id: rivals.id,
          status_code: 'rejected',
          rejection_reason_code: 'place_already_claimed',
          store_id: null,
        },
      ]);
      expect(await admin`select 1 from saved_places where place_id = ${id}`).toHaveLength(0);
      expect(await admin`select user_id from saved_stores where store_id = ${storeId}`).toEqual([
        { user_id: MEMBER },
      ]);
      expect(await admin`select 1 from reviews where place_id = ${id}`).toHaveLength(0);

      const actions = await admin`
        select place_claim_id, action_code, reason_code, actor_user_id from moderation_actions
        where place_claim_id in (${mine.id}, ${rivals.id}) order by action_code`;
      expect(actions).toEqual([
        {
          place_claim_id: mine.id,
          action_code: 'claim_approved',
          reason_code: 'meets_guidelines',
          actor_user_id: MOD,
        },
        {
          place_claim_id: rivals.id,
          action_code: 'claim_rejected',
          reason_code: 'place_already_claimed',
          actor_user_id: MOD,
        },
      ]);
      expect((await revisionsOf(id)).at(-1)).toMatchObject({
        kind_code: 'claimed',
        changed_by_user_id: MOD,
      });

      // Decided claims and claimed places can't be approved again.
      expect(await stateOf(approve(AS_MOD, rivals.id))).toBe('AE210');
      const late = await claim(AS_MEMBER, id);
      expect(await stateOf(approve(AS_MOD, late.id))).toBe('AE211');
    });

    it('lets exactly one of two concurrent approvals for one place commit', async () => {
      const id = await place();
      const a = await claim(AS_OWNER, id);
      const b = await claim(AS_RIVAL, id);
      // A holds the place lock until it commits; B waits on it, then finds the place claimed.
      const first = as(app, AS_MOD, async (tx) => {
        await tx`select * from approve_place_claim(${a.id}, null, false)`;
        await tx`select pg_sleep(0.3)`;
      });
      const second = as(
        app2,
        AS_MOD,
        (tx) => tx`select * from approve_place_claim(${b.id}, null, false)`,
      );
      const [one, two] = await Promise.allSettled([first, second]);
      expect(one.status).toBe('fulfilled');
      expect(two.status).toBe('rejected');
      const { code } = (two as PromiseRejectedResult).reason as { code?: string };
      expect(['AE211', 'AE210']).toContain(code);
      const approved =
        await admin`select id from place_claims where place_id = ${id} and status_code = 'approved'`;
      expect(approved).toEqual([{ id: a.id }]);
    });

    it('links an existing store of the claimant instead of creating one', async () => {
      const id = await place();
      const storeId = newId();
      await admin.begin(async (tx) => {
        await tx`select set_config('app.role', 'system', true)`;
        await tx`insert into stores (id, tenant_id, owner_member_id, slug, name_bn, status_code)
                 values (${storeId}, ${TENANT_A}, ${M_OWNER}, ${`own-${storeId.slice(-6)}`}, 'আমার দোকান', 'active')`;
      });
      const mine = await claim(AS_OWNER, id);
      // Someone else's store is refused.
      const other = await claim(AS_RIVAL, await place());
      expect(await stateOf(approve(AS_MOD, other.id, false, storeId))).toBe('AE213');

      const [result] = await approve(AS_MOD, mine.id, false, storeId);
      expect(result).toMatchObject({ store_id: storeId, created_store: false });
      expect(await admin`select place_id from stores where id = ${storeId}`).toEqual([
        { place_id: id },
      ]);
    });

    it('auto-approves only an OTP-verified claim of the caller, when the tenant allows it', async () => {
      const id = await place();
      const plain = await claim(AS_OWNER, id);
      expect(await stateOf(approve(AS_OWNER, plain.id, true))).toBe('AE214');
      await admin`update place_claims set status_code = 'rejected' where id = ${plain.id}`;

      const verified = await claim(AS_OWNER, id, true);
      expect(await stateOf(approve(AS_OWNER, verified.id, true))).toBe('AE214'); // tenant hasn't opted in
      expect(await stateOf(approve(AS_RIVAL, verified.id, true))).toBe('42501'); // not theirs

      await setAutoApprove(true);
      try {
        const [result] = await approve(AS_OWNER, verified.id, true);
        expect(result).toMatchObject({ created_store: true, claimant_user_id: OWNER });
      } finally {
        await setAutoApprove(false);
      }
      const [row] =
        await admin`select status_code, reviewed_by_user_id from place_claims where id = ${verified.id}`;
      expect(row).toEqual({ status_code: 'approved', reviewed_by_user_id: null });
      const actions = await admin`
        select action_code, reason_code, actor_user_id from moderation_actions where place_claim_id = ${verified.id}`;
      expect(actions).toEqual([
        { action_code: 'claim_approved', reason_code: 'otp_verified', actor_user_id: OWNER },
      ]);
    });

    it('never lets a moderator approve their own claim, or a member approve anything', async () => {
      const id = await place();
      const own = await claim(AS_MOD, id);
      expect(await stateOf(approve(AS_MOD, own.id))).toBe('42501');
      expect(await stateOf(approve(AS_MEMBER, own.id))).toBe('42501');
      // Another tenant's moderator doesn't find it.
      expect(await stateOf(approve(AS_MOD_B, own.id))).toBe('P0002');
    });
  });

  describe('moderation_actions targets', () => {
    it('needs exactly one of post, place, place claim', async () => {
      const id = await place();
      const insert = (placeId: string | null) =>
        as(
          app,
          AS_MOD,
          (tx) => tx`
          insert into moderation_actions (place_id, actor_user_id, action_code, reason_code)
          values (${placeId}, ${MOD}, 'approved', 'meets_guidelines')`,
        );
      expect(await stateOf(insert(null))).toBe('23514');
      expect(await stateOf(insert(id))).toBeUndefined();
    });

    it("lets a claimant record only their own claim's submission", async () => {
      const id = await place();
      const mine = await claim(AS_OWNER, id);
      const record = (context: Context, action: string) =>
        as(
          app,
          context,
          (tx) => tx`
          insert into moderation_actions (place_claim_id, actor_user_id, action_code, reason_code)
          values (${mine.id}, ${context.user_id!}, ${action}, 'owner_request')`,
        );
      expect(await stateOf(record(AS_OWNER, 'claim_submitted'))).toBeUndefined();
      expect(await stateOf(record(AS_OWNER, 'claim_approved'))).toBe('42501');
      expect(await stateOf(record(AS_RIVAL, 'claim_submitted'))).toBe('42501');
    });
  });
});
