import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * Migration 0043 (ADR 048), as ae_app: the name key and similarity, the
 * radius search across tenant boundaries, duplicate_candidates RLS, and
 * merge_place / undo_place_merge — everything that moves, the redirect, the
 * audit trail, and the refusals.
 */

const FIXTURE = '0191e3a0-d0b1-7000-8000-%';
const PARTNER = '0191e3a0-d0b1-7000-8000-000000000001';
const AREA_A = '0191e3a0-d0b1-7000-8000-000000000011';
const AREA_B = '0191e3a0-d0b1-7000-8000-000000000012';
const TENANT_A = '0191e3a0-d0b1-7000-8000-000000000021';
const TENANT_B = '0191e3a0-d0b1-7000-8000-000000000022';
const MOD = '0191e3a0-d0b1-7000-8000-000000000031';
const MEMBER = '0191e3a0-d0b1-7000-8000-000000000032';
const SAVER = '0191e3a0-d0b1-7000-8000-000000000033';
const OWNER = '0191e3a0-d0b1-7000-8000-000000000034';
const OWNER2 = '0191e3a0-d0b1-7000-8000-000000000035';
const MOD_B = '0191e3a0-d0b1-7000-8000-000000000036';
const M_MOD = '0191e3a0-d0b1-7000-8000-000000000041';
const M_MEMBER = '0191e3a0-d0b1-7000-8000-000000000042';
const M_SAVER = '0191e3a0-d0b1-7000-8000-000000000043';
const M_OWNER = '0191e3a0-d0b1-7000-8000-000000000044';
const M_OWNER2 = '0191e3a0-d0b1-7000-8000-000000000045';
const M_MOD_B = '0191e3a0-d0b1-7000-8000-000000000046';
const CATEGORY = '0191e3a0-d0b1-7000-8000-000000000051';

const STOPWORDS = ['store', 'stor', 'shtor', 'স্টোর', 'ষ্টোর'];
// A and B meet at lng 92.5.
const square = (west: number, east: number) =>
  `SRID=4326;MULTIPOLYGON(((${west} 20.8,${east} 20.8,${east} 20.9,${west} 20.9,${west} 20.8)))`;
const at = (lng: number, lat = 20.85) => `SRID=4326;POINT(${lng} ${lat})`;

type Context = Record<string, string>;
const AS_MOD: Context = { tenant_id: TENANT_A, user_id: MOD, member_id: M_MOD, role: 'moderator' };
const AS_MEMBER: Context = {
  tenant_id: TENANT_A,
  user_id: MEMBER,
  member_id: M_MEMBER,
  role: 'member',
};
const AS_MOD_B: Context = {
  tenant_id: TENANT_B,
  user_id: MOD_B,
  member_id: M_MOD_B,
  role: 'moderator',
};

async function as<T>(sql: Sql, context: Context, work: (tx: TransactionSql) => Promise<T>) {
  return sql.begin(async (tx) => {
    for (const [key, value] of Object.entries(context)) {
      await tx`select set_config(${`app.${key}`}, ${value}, true)`;
    }
    return work(tx);
  }) as Promise<T>;
}

async function stateOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

let next = 0x1000;
const newId = () => `0191e3a0-d0b1-7000-8000-${(next++).toString(16).padStart(12, '0')}`;

describe('Duplicate detection and merge (0043)', () => {
  let admin: Sql;
  let app: Sql;

  const place = async (
    nameBn: string,
    lng: number,
    extra: { tenant?: string; translit?: string; phones?: string[] } = {},
  ): Promise<string> => {
    const id = newId();
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`
        insert into places (id, tenant_id, category_id, slug, name_bn, name_translit, phones, status_code, location, source_code)
        values (${id}, ${extra.tenant ?? TENANT_A}, ${CATEGORY}, ${`dup-${id.slice(-6)}`}, ${nameBn},
                ${extra.translit ?? null}, ${extra.phones ?? []}, 'published', ${at(lng)}, 'agent_survey')`;
    });
    return id;
  };

  const signals = (context: Context, nameBn: string, lng: number, phones: string[] = []) =>
    as(
      app,
      context,
      (tx) => tx<
        { place_id: string; tenant_id: string; name_similarity: number; phone_match: boolean }[]
      >`
      select place_id, tenant_id, name_similarity, phone_match
      from place_duplicate_signals(20.85, ${lng}, ${nameBn}, null, null, ${phones}, ${CATEGORY}, null,
                                   150, ${STOPWORDS}, 0.45, 10)`,
    );

  const merge = (context: Context, loser: string, target: string) =>
    as(app, context, async (tx) => {
      const [row] = await tx<
        { id: string }[]
      >`select merge_place(${loser}, ${target}, 'duplicate', null) as id`;
      return row!.id;
    });
  const undo = (context: Context, mergeId: string) =>
    as(app, context, (tx) => tx`select undo_place_merge(${mergeId})`);

  async function cleanUp(): Promise<void> {
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from moderation_actions where tenant_id::text like ${FIXTURE}`;
    });
    const ids = (
      await admin<{ id: string }[]>`
        select id from places where tenant_id::text like ${FIXTURE}
        union all select id from stores where tenant_id::text like ${FIXTURE}`
    ).map((r) => r.id);
    await admin`delete from place_merges where tenant_id::text like ${FIXTURE}`;
    await admin`delete from duplicate_candidates where tenant_id::text like ${FIXTURE}`;
    await admin`delete from lead_events where tenant_id::text like ${FIXTURE}`;
    await admin`delete from reviews where tenant_id::text like ${FIXTURE}`;
    await admin`delete from saved_places where tenant_id::text like ${FIXTURE}`;
    await admin`delete from media_attachments where tenant_id::text like ${FIXTURE}`;
    await admin`delete from media_assets where tenant_id::text like ${FIXTURE}`;
    await admin`delete from place_claims where tenant_id::text like ${FIXTURE}`;
    await admin`update places set claim_store_id = null, merged_into_place_id = null, merged_at = null where tenant_id::text like ${FIXTURE}`;
    await admin`delete from stores where tenant_id::text like ${FIXTURE}`;
    await admin`delete from places where tenant_id::text like ${FIXTURE}`;
    if (ids.length > 0) await admin`delete from outbox_events where aggregate_id in ${admin(ids)}`;
    await admin`delete from categories where id::text like ${FIXTURE}`;
    await admin`delete from tenant_members where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_settings where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    app = testSqlClient(1, resolveTestAppDatabaseUrl());
    await cleanUp();
    await admin`
      insert into users (id, phone_e164) values
        (${MOD}, '+8801766000001'), (${MEMBER}, '+8801766000002'), (${SAVER}, '+8801766000003'),
        (${OWNER}, '+8801766000004'), (${OWNER2}, '+8801766000005'), (${MOD_B}, '+8801766000006')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Dup Partner', 'Dup Partner', '+8801766000099')`;
    await admin`
      insert into geo_areas
        (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release, boundary, boundary_simplified)
      values
        (${AREA_A}, 3, 'upazila', 'dup-a', 'Dup A', 'fixture', ${square(92.4, 92.5)}, ${square(92.4, 92.5)}),
        (${AREA_B}, 3, 'upazila', 'dup-b', 'Dup B', 'fixture', ${square(92.5, 92.6)}, ${square(92.5, 92.6)})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'dup-a', 'এ', 'A', ${at(92.45)}, 'active'),
             (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'dup-b', 'বি', 'B', ${at(92.55)}, 'active')`;
    await admin`insert into tenant_settings (tenant_id) values (${TENANT_A}), (${TENANT_B})`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${M_MOD}, ${TENANT_A}, ${MOD}, 'moderator'), (${M_MEMBER}, ${TENANT_A}, ${MEMBER}, 'member'),
        (${M_SAVER}, ${TENANT_A}, ${SAVER}, 'member'), (${M_OWNER}, ${TENANT_A}, ${OWNER}, 'member'),
        (${M_OWNER2}, ${TENANT_A}, ${OWNER2}, 'member'), (${M_MOD_B}, ${TENANT_B}, ${MOD_B}, 'moderator')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en)
      values (${CATEGORY}, 'place', 'dup-shop', 'দোকান', 'Shop')`;
  }, 60_000);

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await admin.end();
      await app.end();
    }
  });

  describe('similarity', () => {
    it('compares names without their generic words, across Bengali and Latin', async () => {
      const [row] = await admin<{ key: string; same: number; different: number; latin: number }[]>`
        select duplicate_name_key('রহিম স্টোর', ${STOPWORDS}) as key,
               duplicate_name_similarity('মায়ের দোয়া স্টোর', null, null, 'মায়ের দোআ ষ্টোর', null, null, ${STOPWORDS}) as same,
               duplicate_name_similarity('রহিম স্টোর', null, null, 'করিম স্টোর', null, null, ${STOPWORDS}) as different,
               duplicate_name_similarity('মায়ের দোয়া স্টোর', null, 'mayer doya stor', 'Mayer Doa', 'Mayer Doa Store', null, ${STOPWORDS}) as latin`;
      expect(row!.key).toBe('রহিম');
      expect(row!.same).toBeGreaterThan(0.5);
      expect(row!.different).toBeLessThan(0.2);
      expect(row!.latin).toBeGreaterThan(0.5);
    });

    it('finds look-alikes within the radius in any tenant, and nothing farther away', async () => {
      // Just across the A/B boundary (~30 m), and 800 m away in A.
      const across = await place('মায়ের দোয়া স্টোর', 92.5003, { tenant: TENANT_B });
      const far = await place('মায়ের দোয়া স্টোর', 92.4925);
      const phoneTwin = await place('একদম আলাদা নাম', 92.4999, { phones: ['+8801766000777'] });
      const found = await signals(AS_MEMBER, 'মায়ের দোআ ষ্টোর', 92.4999, ['+8801766000777']);
      const ids = found.map((f) => f.place_id);
      expect(ids).toContain(across);
      expect(found.find((f) => f.place_id === across)?.tenant_id).toBe(TENANT_B);
      expect(ids).toContain(phoneTwin);
      expect(found.find((f) => f.place_id === phoneTwin)?.phone_match).toBe(true);
      expect(ids).not.toContain(far);
    });
  });

  describe('duplicate_candidates', () => {
    it("is the tenant's staff's, filed by the system, one row per pair", async () => {
      const a = await place('এক', 92.41);
      const b = await place('এক', 92.4101);
      const file = (entity: string, candidate: string) =>
        as(
          app,
          { tenant_id: TENANT_A, role: 'system' },
          (tx) => tx`
          insert into duplicate_candidates (entity_type_code, place_id, candidate_place_id, candidate_tenant_id,
                                            score, classification_code, source_code)
          values ('place', ${entity}, ${candidate}, ${TENANT_A}, 0.9, 'likely', 'batch')
          on conflict do nothing returning id`,
        );
      expect(await file(a, b)).toHaveLength(1);
      expect(await file(b, a)).toHaveLength(0); // same pair, other way round

      const count = (context: Context) =>
        as(
          app,
          context,
          async (tx) =>
            (await tx`select id from duplicate_candidates where place_id = ${a}`).length,
        );
      expect(await count(AS_MOD)).toBe(1);
      expect(await count(AS_MEMBER)).toBe(0);
      expect(await count(AS_MOD_B)).toBe(0);
      expect(
        await stateOf(
          as(
            app,
            AS_MEMBER,
            (tx) => tx`
            insert into duplicate_candidates (entity_type_code, place_id, candidate_place_id, candidate_tenant_id,
                                              score, classification_code, source_code)
            values ('place', ${b}, ${a}, ${TENANT_A}, 0.9, 'likely', 'batch')`,
          ),
        ),
      ).toBe('42501');
    });
  });

  describe('merge_place / undo_place_merge', () => {
    it('moves photos, revisions, saves, reviews, lead history and claims; the loser redirects; undo puts it all back', async () => {
      const target = await place('মায়ের দোয়া স্টোর', 92.42);
      const loser = await place('মায়ের দোআ ষ্টোর', 92.4201);
      // The loser's things.
      const media = newId();
      await admin`
        insert into media_assets (id, tenant_id, uploaded_by_user_id, kind_code, storage_key, mime_type, byte_size, checksum_sha256, status_code)
        values (${media}, ${TENANT_A}, ${MEMBER}, 'image', 'dup/one', 'image/webp', 10, ${'d'.repeat(64)}, 'ready')`;
      await admin`insert into media_attachments (tenant_id, media_asset_id, place_id) values (${TENANT_A}, ${media}, ${loser})`;
      await admin`insert into saved_places (tenant_id, user_id, place_id) values (${TENANT_A}, ${SAVER}, ${loser}), (${TENANT_A}, ${MEMBER}, ${loser})`;
      await admin`insert into saved_places (tenant_id, user_id, place_id) values (${TENANT_A}, ${MEMBER}, ${target})`;
      await admin`
        insert into reviews (tenant_id, reviewer_member_id, place_id, rating)
        values (${TENANT_A}, ${M_SAVER}, ${loser}, 5), (${TENANT_A}, ${M_MEMBER}, ${loser}, 1), (${TENANT_A}, ${M_MEMBER}, ${target}, 3)`;
      await admin`
        insert into lead_events (tenant_id, channel_code, source_code, place_id)
        values (${TENANT_A}, 'call_click', 'place_page', ${loser}), (${TENANT_A}, 'call_click', 'place_page', ${loser})`;
      const [claim] = await admin<{ id: string }[]>`
        insert into place_claims (tenant_id, place_id, claimant_member_id, verification_method_code, evidence_codes)
        values (${TENANT_A}, ${loser}, ${M_OWNER}, 'trade_license', '{trade_license}') returning id`;
      const loserRevisions = (await admin`select id from place_revisions where place_id = ${loser}`)
        .length;

      expect(await stateOf(merge(AS_MEMBER, loser, target))).toBe('42501');
      expect(await stateOf(merge(AS_MOD_B, loser, target))).toBe('P0002');
      expect(await stateOf(merge(AS_MOD, loser, loser))).toBe('AE230');

      const mergeId = await merge(AS_MOD, loser, target);

      const where = async () => ({
        media: (
          await admin<
            { place_id: string }[]
          >`select place_id from media_attachments where media_asset_id = ${media}`
        )[0]?.place_id,
        saves: (
          await admin<
            { user_id: string; place_id: string }[]
          >`select user_id, place_id from saved_places where place_id in (${loser}, ${target}) order by place_id, user_id`
        )
          .map(
            (r) =>
              `${r.user_id === SAVER ? 'saver' : 'member'}@${r.place_id === loser ? 'loser' : 'target'}`,
          )
          .sort(),
        reviews: (
          await admin<
            { reviewer_member_id: string; place_id: string }[]
          >`select reviewer_member_id, place_id from reviews where place_id in (${loser}, ${target})`
        )
          .map(
            (r) =>
              `${r.reviewer_member_id === M_SAVER ? 'saver' : 'member'}@${r.place_id === loser ? 'loser' : 'target'}`,
          )
          .sort(),
        leads: (
          await admin<
            { n: number }[]
          >`select count(*)::int as n from lead_events where place_id = ${target}`
        )[0]!.n,
        claim: (
          await admin<
            { place_id: string }[]
          >`select place_id from place_claims where id = ${claim!.id}`
        )[0]?.place_id,
        loserRevisions: (await admin`select id from place_revisions where place_id = ${loser}`)
          .length,
      });

      const after = await where();
      expect(after).toEqual({
        media: target,
        saves: ['member@target', 'saver@target'],
        // The member had already reviewed the target: their review of the loser stays put.
        reviews: ['member@loser', 'member@target', 'saver@target'],
        leads: 2,
        claim: target,
        loserRevisions: 0,
      });
      const [redirect] = await admin<
        { merged_into_place_id: string; deleted: boolean; rating_count: number }[]
      >`
        select merged_into_place_id, deleted_at is not null as deleted,
               (select rating_count from places where id = ${target}) as rating_count
        from places where id = ${loser}`;
      expect(redirect).toEqual({ merged_into_place_id: target, deleted: true, rating_count: 2 });
      const [resolved] = await as(
        app,
        AS_MEMBER,
        (tx) => tx<{ target: string }[]>`
        select place_redirect_target(${loser}) as target`,
      );
      expect(resolved!.target).toBe(target);
      expect(
        await admin`select action_code, reason_code from moderation_actions where place_id = ${loser}`,
      ).toEqual([{ action_code: 'merged', reason_code: 'duplicate' }]);
      // Can't merge a merged place again.
      expect(await stateOf(merge(AS_MOD, loser, target))).toBe('AE230');

      await undo(AS_MOD, mergeId);
      const back = await where();
      expect(back).toEqual({
        media: loser,
        saves: ['member@loser', 'member@target', 'saver@loser'],
        reviews: ['member@loser', 'member@target', 'saver@loser'],
        leads: 0,
        claim: loser,
        loserRevisions,
      });
      const [restored] =
        await admin`select merged_into_place_id, deleted_at from places where id = ${loser}`;
      expect(restored).toEqual({ merged_into_place_id: null, deleted_at: null });
      expect(await stateOf(undo(AS_MOD, mergeId))).toBe('AE233');
      expect(
        (
          await admin<
            { action_code: string }[]
          >`select action_code from moderation_actions where place_id = ${loser} order by id`
        ).map((r) => r.action_code),
      ).toEqual(['merged', 'merge_undone']);
    });

    it("moves a verified owner and their store's pin; refuses when both places have one", async () => {
      const target = await place('এক নাম', 92.43);
      const loser = await place('এক নাম', 92.4301);
      const store = newId();
      await admin.begin(async (tx) => {
        await tx`select set_config('app.role', 'system', true)`;
        await tx`insert into stores (id, tenant_id, owner_member_id, place_id, slug, name_bn, status_code, location)
                 values (${store}, ${TENANT_A}, ${M_OWNER}, ${loser}, ${`dup-store-${store.slice(-6)}`}, 'এক নাম', 'active', ${at(92.4301)})`;
        await tx`update places set claimed_by_member_id = ${M_OWNER}, claim_store_id = ${store} where id = ${loser}`;
      });
      await merge(AS_MOD, loser, target);
      const [t] =
        await admin`select claimed_by_member_id, claim_store_id from places where id = ${target}`;
      expect(t).toEqual({ claimed_by_member_id: M_OWNER, claim_store_id: store });
      const [s] = await admin<{ place_id: string; moved: boolean }[]>`
        select s.place_id, st_equals(s.location::geometry, p.location::geometry) as moved
        from stores s join places p on p.id = ${target} where s.id = ${store}`;
      expect(s).toEqual({ place_id: target, moved: true });

      // Now a second claimed place can't be merged into the (claimed) target.
      const other = await place('এক নাম', 92.4302);
      const store2 = newId();
      await admin.begin(async (tx) => {
        await tx`select set_config('app.role', 'system', true)`;
        await tx`insert into stores (id, tenant_id, owner_member_id, place_id, slug, name_bn, status_code)
                 values (${store2}, ${TENANT_A}, ${M_OWNER2}, ${other}, ${`dup-store-${store2.slice(-6)}`}, 'এক নাম', 'active')`;
        await tx`update places set claimed_by_member_id = ${M_OWNER2}, claim_store_id = ${store2} where id = ${other}`;
      });
      expect(await stateOf(merge(AS_MOD, other, target))).toBe('AE231');
    });

    it('cannot be undone once merge_undo_days have passed', async () => {
      const target = await place('দুই', 92.44);
      const loser = await place('দুই', 92.4401);
      const mergeId = await merge(AS_MOD, loser, target);
      await admin`update place_merges set undo_until = now() - interval '1 minute' where id = ${mergeId}`;
      expect(await stateOf(undo(AS_MOD, mergeId))).toBe('AE232');
    });
  });
});
