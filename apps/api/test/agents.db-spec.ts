import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * Field agent mode at the database (0062, ADR 066): RLS across agents and
 * areas on tasks, submissions and phone checks; the capture stays as captured;
 * agent_submission_outcomes() only for the agent themselves or the staff.
 */

const P = '0191e3a0-a6d8-7000-8000-';
const FIXTURE = `${P}%`;
const PARTNER = `${P}000000000001`;
const GEO_A = `${P}000000000011`;
const GEO_B = `${P}000000000012`;
const TENANT_A = `${P}000000000021`;
const TENANT_B = `${P}000000000022`;
const CATEGORY = `${P}000000000051`;
const PLACE_A = `${P}000000000061`;
const PLACE_B = `${P}000000000062`;
const U = (n: number) => `${P}0000000001${String(n).padStart(2, '0')}`;
const M = (n: number) => `${P}0000000002${String(n).padStart(2, '0')}`;
const FA = (n: number) => `${P}0000000003${String(n).padStart(2, '0')}`;

// 1, 2: agents in A; 3: A's moderator; 4: a member in A; 5: an agent in B.
const TENANT_OF: Record<number, string> = {
  1: TENANT_A,
  2: TENANT_A,
  3: TENANT_A,
  4: TENANT_A,
  5: TENANT_B,
};
const ROLE_OF: Record<number, string> = {
  1: 'agent',
  2: 'agent',
  3: 'moderator',
  4: 'member',
  5: 'agent',
};

type Context = Partial<Record<'tenant_id' | 'user_id' | 'member_id' | 'role', string>>;
const as = (n: number): Context => ({
  tenant_id: TENANT_OF[n]!,
  user_id: U(n),
  member_id: M(n),
  role: ROLE_OF[n]!,
});
const SYSTEM = (tenant: string): Context => ({ role: 'system', tenant_id: tenant });
const pt = (lng: number, lat: number) => `SRID=4326;POINT(${lng} ${lat})`;

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

async function sqlError(promise: Promise<unknown>): Promise<{ code?: string }> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught as { code?: string },
  );
  if (!error) throw new Error('expected the statement to be rejected, but it succeeded');
  return error;
}

describe('Field agent mode (0062)', () => {
  let app: Sql;
  let admin: Sql;
  const submissionOf: Record<number, string> = {};

  async function cleanup(): Promise<void> {
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      for (const t of [
        'agent_submissions',
        'agent_phone_checks',
        'agent_tasks',
        'agent_visits',
        'field_agents',
        'places',
        'tenant_members',
      ]) {
        await tx.unsafe(`delete from ${t} where tenant_id::text like $1`, [FIXTURE]);
      }
      await tx`delete from tenants where id::text like ${FIXTURE}`;
      await tx`delete from categories where id::text like ${FIXTURE}`;
      await tx`delete from partners where id::text like ${FIXTURE}`;
      await tx`delete from geo_areas where id::text like ${FIXTURE}`;
      await tx`delete from users where id::text like ${FIXTURE}`;
    });
  }

  /** A synced new-shop submission for agent n, as the API writes it (place + visit + row). */
  async function seedSubmission(n: number, placeId: string): Promise<string> {
    const id = crypto.randomUUID();
    await withContext(admin, SYSTEM(TENANT_OF[n]!), async (tx) => {
      const [visit] = await tx<{ id: string }[]>`
        insert into agent_visits (tenant_id, field_agent_id, place_id, purpose_code, outcome_code, visited_at,
                                  check_in_location, client_visit_id)
        values (${TENANT_OF[n]!}, ${FA(n)}, ${placeId}, 'onboarding', 'submitted', now(), ${pt(90.4, 23.8)}, ${id})
        returning id`;
      await tx`
        insert into agent_submissions (id, tenant_id, field_agent_id, kind_code, captured_at, location, accuracy_m,
                                       payload, place_id, agent_visit_id)
        values (${id}, ${TENANT_OF[n]!}, ${FA(n)}, 'new_shop', now(), ${pt(90.4, 23.8)}, 8, '{}', ${placeId},
                ${visit!.id})`;
    });
    return id;
  }

  beforeAll(async () => {
    app = testSqlClient(4, resolveTestAppDatabaseUrl());
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanup();
    for (const n of Object.keys(TENANT_OF).map(Number)) {
      await admin`insert into users (id, phone_e164) values (${U(n)}, ${`+88017980000${String(n).padStart(2, '0')}`})`;
    }
    await admin`insert into partners (id, legal_name, display_name, phone_e164)
                values (${PARTNER}, 'Agent Partner', 'Agent Partner', '+8801798000099')`;
    await admin`insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
      (${GEO_A}, 3, 'upazila', 'agents-db-a', 'Agents A', 'fixture'),
      (${GEO_B}, 3, 'upazila', 'agents-db-b', 'Agents B', 'fixture')`;
    await admin`insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
      (${TENANT_A}, ${PARTNER}, ${GEO_A}, 'agents-db-a', 'এ', 'A', st_point(90.40, 23.80)::geography, 'active'),
      (${TENANT_B}, ${PARTNER}, ${GEO_B}, 'agents-db-b', 'বি', 'B', st_point(90.43, 23.80)::geography, 'active')`;
    for (const n of Object.keys(TENANT_OF).map(Number)) {
      await admin`insert into tenant_members (id, tenant_id, user_id, role_code)
                  values (${M(n)}, ${TENANT_OF[n]!}, ${U(n)}, ${ROLE_OF[n]!})`;
    }
    for (const n of [1, 2, 5]) {
      await admin`insert into field_agents (id, tenant_id, member_id, agent_code, employment_type_code, joined_on)
                  values (${FA(n)}, ${TENANT_OF[n]!}, ${M(n)}, ${`AG-${n}`}, 'commission_only', current_date)`;
    }
    await admin`insert into categories (id, kind_code, slug, name_bn, name_en)
                values (${CATEGORY}, 'place', 'agents-db-shop', 'দোকান', 'Shop')`;
    for (const [place, tenant] of [
      [PLACE_A, TENANT_A],
      [PLACE_B, TENANT_B],
    ] as const) {
      await withContext(
        admin,
        SYSTEM(tenant),
        (tx) => tx`
        insert into places (id, tenant_id, category_id, slug, name_bn, location, status_code, source_code)
        values (${place}, ${tenant}, ${CATEGORY}, ${`agents-db-${place.slice(-2)}`}, 'দোকান',
                ${pt(90.4, 23.8)}::geography, 'pending_review', 'agent_survey')`,
      );
    }
    submissionOf[1] = await seedSubmission(1, PLACE_A);
    submissionOf[2] = await seedSubmission(2, PLACE_A);
    submissionOf[5] = await seedSubmission(5, PLACE_B);
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await app.end();
      await admin.end();
    }
  });

  const visibleSubmissions = (n: number) =>
    withContext(app, as(n), (tx) => tx<{ id: string }[]>`select id from agent_submissions`).then(
      (rows) => rows.map((r) => r.id).sort(),
    );

  it('shows an agent only their own submissions; the area staff all of the area; nobody another area', async () => {
    expect(await visibleSubmissions(1)).toEqual([submissionOf[1]]);
    expect(await visibleSubmissions(2)).toEqual([submissionOf[2]]);
    expect(await visibleSubmissions(3)).toEqual([submissionOf[1], submissionOf[2]].sort());
    expect(await visibleSubmissions(4)).toEqual([]);
    expect(await visibleSubmissions(5)).toEqual([submissionOf[5]]);
  });

  it('lets an agent insert only as themselves, and never change a capture', async () => {
    const forged = await sqlError(
      withContext(
        app,
        as(1),
        (tx) => tx`
        insert into agent_submissions (id, field_agent_id, kind_code, captured_at, location, accuracy_m, payload,
                                       place_id, agent_visit_id)
        select gen_random_uuid(), ${FA(2)}, 'verify_shop', now(), ${pt(90.4, 23.8)}, 5, '{}', ${PLACE_A}, id
        from agent_visits where client_visit_id = ${submissionOf[1]!}`,
      ),
    );
    expect(forged.code).toBe('42501');
    const changed = await withContext(
      app,
      as(1),
      (tx) =>
        tx`update agent_submissions set accuracy_m = 1 where id = ${submissionOf[1]!} returning id`,
    );
    expect(changed).toHaveLength(0);
  });

  it('keeps tasks to the agent they are for; the area staff assign them', async () => {
    const [task] = await withContext(
      app,
      as(3),
      (tx) => tx<{ id: string }[]>`
      insert into agent_tasks (field_agent_id, type_code, title, due_on)
      values (${FA(1)}, 'map_shop', 'বাজার রোড', current_date) returning id`,
    );
    const seen = async (n: number) =>
      withContext(
        app,
        as(n),
        (tx) => tx<{ id: string }[]>`select id from agent_tasks where id = ${task!.id}`,
      );
    expect(await seen(1)).toHaveLength(1);
    expect(await seen(2)).toHaveLength(0);
    expect(await seen(5)).toHaveLength(0);
    const byAgent = await sqlError(
      withContext(
        app,
        as(1),
        (tx) => tx`
        insert into agent_tasks (field_agent_id, type_code, title, due_on)
        values (${FA(1)}, 'map_shop', 'নিজের কাজ', current_date)`,
      ),
    );
    expect(byAgent.code).toBe('42501');
  });

  it('keeps a phone check to its agent', async () => {
    await withContext(
      app,
      as(1),
      (tx) => tx`
      insert into agent_phone_checks (field_agent_id, submission_id, phone_hash)
      values (${FA(1)}, ${submissionOf[1]!}, ${'a'.repeat(64)})`,
    );
    const seen = async (n: number) =>
      withContext(app, as(n), (tx) => tx<{ id: string }[]>`select id from agent_phone_checks`);
    expect(await seen(1)).toHaveLength(1);
    expect(await seen(2)).toHaveLength(0);
    expect(await seen(3)).toHaveLength(1);
    expect(await seen(5)).toHaveLength(0);
  });

  it('answers outcomes to the agent themselves and the staff only', async () => {
    const outcomes = (n: number, agent: string | null) =>
      withContext(
        app,
        as(n),
        (tx) => tx<{ submission_id: string; review_status: string }[]>`
        select submission_id, review_status
        from public.agent_submission_outcomes(${agent}::uuid, now() - interval '1 day', now() + interval '1 day')`,
      );
    expect((await outcomes(1, FA(1))).map((r) => r.submission_id)).toEqual([submissionOf[1]]);
    expect((await outcomes(1, FA(1)))[0]!.review_status).toBe('pending');
    expect((await sqlError(outcomes(1, FA(2)))).code).toBe('42501');
    expect((await sqlError(outcomes(4, null))).code).toBe('42501');
    expect(await outcomes(3, null)).toHaveLength(2);
    // Another area's agent is invisible even when named.
    expect(await outcomes(3, FA(5))).toHaveLength(0);
  });
});
