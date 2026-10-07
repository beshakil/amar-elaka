import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * Migration 0046 (ADR 051), as ae_app: report_place() — one open report per
 * reporter, never on one's own place, a moderation_actions row per report,
 * and the "possibly closed" flag at place_closed_report_threshold DISTINCT
 * reporters (with its own system moderation_actions row); only the function
 * or staff set that flag (and merged_into_place_id); suggest_place_edit() and
 * place_edit_suggestions RLS (the suggester's own, staff of the same tenant,
 * nobody inserts directly); place_pair_signals() across a tenant border.
 */

const FIXTURE = '0191e3a0-a51e-7000-8000-%';
const PARTNER = '0191e3a0-a51e-7000-8000-000000000001';
const AREA_A = '0191e3a0-a51e-7000-8000-000000000011';
const AREA_B = '0191e3a0-a51e-7000-8000-000000000012';
const TENANT_A = '0191e3a0-a51e-7000-8000-000000000021';
const TENANT_B = '0191e3a0-a51e-7000-8000-000000000022';
const CATEGORY = '0191e3a0-a51e-7000-8000-000000000051';
const user = (n: number) => `0191e3a0-a51e-7000-8000-${(0x100 + n).toString(16).padStart(12, '0')}`;
const member = (n: number) =>
  `0191e3a0-a51e-7000-8000-${(0x200 + n).toString(16).padStart(12, '0')}`;
// 1 owner, 2–5 reporters, 6 moderator (A), 7 moderator (B)
const OWNER = 1;
const MOD = 6;
const MOD_B = 7;

const square = (west: number, east: number) =>
  `SRID=4326;MULTIPOLYGON(((${west} 20.0,${east} 20.0,${east} 20.1,${west} 20.1,${west} 20.0)))`;
const POINT = 'SRID=4326;POINT(92.45 20.05)';

type Context = Record<string, string>;
const as_ = (n: number, role = 'member', tenant = TENANT_A): Context => ({
  tenant_id: tenant,
  user_id: user(n),
  member_id: member(n),
  role,
});

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
const newId = () => `0191e3a0-a51e-7000-8000-${(next++).toString(16).padStart(12, '0')}`;

interface Action {
  action_code: string;
  actor_user_id: string | null;
  reason_code: string;
  evidence_refs: string[];
}

describe('Place reports and edit suggestions (0046)', () => {
  let admin: Sql;
  let app: Sql;

  const place = async (
    extra: { tenant?: string; point?: string; status?: string; owner?: number; name?: string } = {},
  ): Promise<string> => {
    const id = newId();
    await admin`
      insert into places (id, tenant_id, category_id, slug, name_bn, phones, status_code, location,
                          source_code, claimed_by_member_id)
      values (${id}, ${extra.tenant ?? TENANT_A}, ${CATEGORY}, ${`fixture-${id.slice(-6)}`},
              ${extra.name ?? 'রহিম স্টোর'}, ${['+8801755000001']}, ${extra.status ?? 'published'},
              ${extra.point ?? POINT}, 'agent_survey',
              ${extra.owner === undefined ? null : member(extra.owner)})`;
    return id;
  };

  const report = (n: number, placeId: string, reason = 'closed_permanently') =>
    as(
      app,
      as_(n),
      (tx) => tx<{ report_id: string; created: boolean; flagged: boolean }[]>`
        select * from report_place(${placeId}, ${reason}, 'it shut down')`,
    ).then((rows) => rows[0]!);

  const actionsOf = (placeId: string) =>
    admin<Action[]>`
      select action_code, actor_user_id, reason_code, evidence_refs
      from moderation_actions where place_id = ${placeId} order by id`;

  async function cleanUp(): Promise<void> {
    const rows = await admin<{ id: string }[]>`
      select id from places where tenant_id::text like ${FIXTURE}`;
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from moderation_actions where tenant_id::text like ${FIXTURE}`;
    });
    await admin`delete from place_edit_suggestions where tenant_id::text like ${FIXTURE}`;
    await admin`delete from duplicate_candidates where tenant_id::text like ${FIXTURE}`;
    await admin`delete from reports where tenant_id::text like ${FIXTURE}`;
    await admin`delete from place_hours where tenant_id::text like ${FIXTURE}`;
    await admin`delete from places where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_members where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_settings where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from categories where id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
    if (rows.length > 0) {
      await admin`delete from outbox_events where aggregate_id in ${admin(rows.map((r) => r.id))}`;
    }
  }

  async function setThreshold(value: number | null): Promise<void> {
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'platform_admin', true)`;
      await tx`
        update tenant_settings
        set setting_overrides = ${
          value === null
            ? tx`setting_overrides - 'place_closed_report_threshold'`
            : tx`setting_overrides || ${tx.json({ place_closed_report_threshold: value })}`
        }
        where tenant_id = ${TENANT_A}`;
    });
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    app = testSqlClient(1, resolveTestAppDatabaseUrl());
    await cleanUp();
    for (let n = 1; n <= 7; n++) {
      await admin`insert into users (id, phone_e164) values (${user(n)}, ${`+88017550000${n}0`})`;
    }
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Reports Partner', 'Reports Partner', '+8801755000999')`;
    await admin`
      insert into geo_areas
        (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release, boundary, boundary_simplified)
      values
        (${AREA_A}, 3, 'upazila', 'reports-a', 'Reports A', 'fixture', ${square(92.4, 92.5)}, ${square(92.4, 92.5)}),
        (${AREA_B}, 3, 'upazila', 'reports-b', 'Reports B', 'fixture', ${square(92.5, 92.6)}, ${square(92.5, 92.6)})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values
        (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'reports-a', 'এ', 'A', ${POINT}, 'active'),
        (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'reports-b', 'বি', 'B', 'SRID=4326;POINT(92.55 20.05)', 'active')`;
    await admin`insert into tenant_settings (tenant_id) values (${TENANT_A}), (${TENANT_B})`;
    for (let n = 1; n <= 6; n++) {
      await admin`
        insert into tenant_members (id, tenant_id, user_id, role_code)
        values (${member(n)}, ${TENANT_A}, ${user(n)}, ${n === MOD ? 'moderator' : 'member'})`;
    }
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code)
      values (${member(MOD_B)}, ${TENANT_B}, ${user(MOD_B)}, 'moderator')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en)
      values (${CATEGORY}, 'place', 'reports-db-shop', 'দোকান', 'Shop')`;
  }, 60_000);

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await admin.end();
      await app.end();
    }
  });

  describe('report_place', () => {
    it('flags "possibly closed" at the third DISTINCT reporter, never at a repeat', async () => {
      const id = await place();
      const first = await report(2, id);
      expect(first).toMatchObject({ created: true, flagged: false });
      // The same member again: their open report comes back, nothing counted twice.
      const again = await report(2, id);
      expect(again).toEqual({ report_id: first.report_id, created: false, flagged: false });
      expect(await report(3, id)).toMatchObject({ created: true, flagged: false });
      // Another reason doesn't count toward closed.
      expect(await report(4, id, 'wrong_location')).toMatchObject({ flagged: false });
      const third = await report(5, id);
      expect(third).toMatchObject({ created: true, flagged: true });

      const [row] = await admin<{ possibly_closed_at: Date | null; status_code: string }[]>`
        select possibly_closed_at, status_code from places where id = ${id}`;
      expect(row!.possibly_closed_at).not.toBeNull();
      // Flagged, not hidden: a moderator confirms.
      expect(row!.status_code).toBe('published');

      const actions = await actionsOf(id);
      expect(actions.map((a) => a.action_code)).toEqual([
        'place_reported',
        'place_reported',
        'place_reported',
        'place_reported',
        'flagged_possibly_closed',
      ]);
      expect(actions[0]).toMatchObject({ actor_user_id: user(2), reason_code: 'member_report' });
      const flag = actions.at(-1)!;
      expect(flag.actor_user_id).toBeNull();
      expect(flag.reason_code).toBe('community_reports');
      // The three closed reports are the evidence (not the wrong_location one).
      expect(flag.evidence_refs).toHaveLength(3);
    });

    it('a tenant may turn the flag off (threshold 0)', async () => {
      await setThreshold(0);
      try {
        const id = await place();
        for (const n of [2, 3, 4, 5]) expect((await report(n, id)).flagged).toBe(false);
      } finally {
        await setThreshold(null);
      }
    });

    it("refuses one's own place, a pending one and one in another tenant", async () => {
      const own = await place({ owner: OWNER });
      expect(await stateOf(report(OWNER, own))).toBe('AE201');
      const pending = await place({ status: 'pending_review' });
      expect(await stateOf(report(2, pending))).toBe('P0002');
      const elsewhere = await place({ tenant: TENANT_B, point: 'SRID=4326;POINT(92.55 20.05)' });
      expect(await stateOf(report(2, elsewhere))).toBe('P0002');
    });

    it('nobody but report_place() and staff sets possibly_closed_at or merged_into_place_id', async () => {
      const id = await place({ owner: OWNER });
      const target = await place();
      // The claimed owner may update their place, but not these columns.
      await as(
        app,
        as_(OWNER),
        (tx) => tx`
        update places set possibly_closed_at = now(), merged_into_place_id = ${target},
                          description = 'owner edit'
        where id = ${id}`,
      );
      const [row] = await admin<
        {
          possibly_closed_at: Date | null;
          merged_into_place_id: string | null;
          description: string;
        }[]
      >`select possibly_closed_at, merged_into_place_id, description from places where id = ${id}`;
      expect(row).toEqual({
        possibly_closed_at: null,
        merged_into_place_id: null,
        description: 'owner edit',
      });
      // A moderator may (the decisions use this).
      await as(
        app,
        as_(MOD, 'moderator'),
        (tx) => tx`
        update places set possibly_closed_at = now() where id = ${id}`,
      );
      const [after] = await admin<{ flagged: boolean }[]>`
        select possibly_closed_at is not null as flagged from places where id = ${id}`;
      expect(after!.flagged).toBe(true);
    });

    it("reports stay in their tenant: tenant B's moderator sees none of A's", async () => {
      const id = await place();
      await report(3, id, 'inappropriate');
      const seen = await as(
        app,
        as_(MOD_B, 'moderator', TENANT_B),
        (tx) => tx`
        select id from reports where place_id = ${id}`,
      );
      expect(seen).toHaveLength(0);
      const mine = await as(app, as_(3), (tx) => tx`select id from reports where place_id = ${id}`);
      expect(mine).toHaveLength(1);
    });
  });

  describe('suggest_place_edit and place_edit_suggestions', () => {
    const suggest = (n: number, placeId: string) =>
      as(
        app,
        as_(n),
        (tx) => tx<{ id: string }[]>`
          select suggest_place_edit(${placeId}, ${tx.json({ phones: ['+8801755000777'] })},
                                    ${tx.json({ phones: ['+8801755000001'] })}, 'new number') as id`,
      ).then((rows) => rows[0]!.id);

    it('files a pending suggestion with its moderation_actions row; one pending per member', async () => {
      const id = await place();
      const suggestion = await suggest(2, id);
      expect(await stateOf(suggest(2, id))).toBe('AE202');
      // Another member may suggest too.
      await suggest(3, id);
      const actions = await actionsOf(id);
      expect(actions.map((a) => a.action_code)).toEqual([
        'suggestion_submitted',
        'suggestion_submitted',
      ]);
      expect(actions[0]!.evidence_refs).toEqual([suggestion]);
      // Nothing changed on the place.
      const [row] = await admin<{ phones: string[] }[]>`select phones from places where id = ${id}`;
      expect(row!.phones).toEqual(['+8801755000001']);
    });

    it('the suggester reads their own; staff of the same tenant read all; tenant B none', async () => {
      const id = await place();
      await suggest(4, id);
      await suggest(5, id);
      const read = (context: Context) =>
        as(app, context, (tx) => tx`select id from place_edit_suggestions where place_id = ${id}`);
      expect(await read(as_(4))).toHaveLength(1);
      expect(await read(as_(MOD, 'moderator'))).toHaveLength(2);
      expect(await read(as_(MOD_B, 'moderator', TENANT_B))).toHaveLength(0);
    });

    it('nobody inserts a suggestion directly, and a member cannot decide one', async () => {
      const id = await place();
      expect(
        await stateOf(
          as(
            app,
            as_(2),
            (tx) => tx`
            insert into place_edit_suggestions (place_id, suggester_member_id, changes)
            values (${id}, ${member(2)}, ${tx.json({ phones: ['+8801755000778'] })})`,
          ),
        ),
      ).toBe('42501');
      const suggestion = await suggest(3, id);
      const updated = await as(
        app,
        as_(3),
        (tx) => tx`
        update place_edit_suggestions set status_code = 'withdrawn' where id = ${suggestion}
        returning id`,
      );
      expect(updated).toHaveLength(0);
    });

    it('refuses unknown fields and empty changes', async () => {
      const id = await place();
      for (const changes of [{}, { name: 'x' }]) {
        expect(
          await stateOf(
            as(
              app,
              as_(2),
              (tx) => tx`
              select suggest_place_edit(${id}, ${tx.json(changes)}, '{}'::jsonb, null)`,
            ),
          ),
        ).toBe('23514');
      }
    });
  });

  describe('place_pair_signals', () => {
    it("measures a pair across a tenant border, from the reported place's tenant", async () => {
      const a = await place({
        name: 'মায়ের দোয়া স্টোর',
        point: 'SRID=4326;POINT(92.4999 20.05)',
      });
      const b = await place({
        tenant: TENANT_B,
        name: 'মায়ের দোয়া ষ্টোর',
        point: 'SRID=4326;POINT(92.5001 20.05)',
      });
      const signals = (context: Context, x: string, y: string) =>
        as(
          app,
          context,
          (tx) =>
            tx<
              {
                other_tenant_id: string;
                distance_m: number;
                name_similarity: number;
                phone_match: boolean;
              }[]
            >`select * from place_pair_signals(${x}, ${y}, '{}'::text[])`,
        );
      const [pair] = await signals(as_(2), a, b);
      expect(pair!.other_tenant_id).toBe(TENANT_B);
      expect(pair!.distance_m).toBeLessThan(30);
      expect(pair!.name_similarity).toBeGreaterThan(0.5);
      expect(pair!.phone_match).toBe(true);
      // Only from the reported place's own tenant.
      expect(await signals(as_(MOD_B, 'moderator', TENANT_B), a, b)).toHaveLength(0);
    });
  });
});
