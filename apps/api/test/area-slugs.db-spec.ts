import type { Sql } from 'postgres';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * Migration 0036 (ADR 042): an area's URL slug. From its English name,
 * unique per tenant (-2, -3… on a repeat), an id-based fallback without an
 * English name, and never rewritten on rename — a ranking URL must not move.
 */

const P = '0191e3a0-a5a5-7000-8000-';
const FIXTURE = `${P}%`;
const PARTNER = `${P}000000000001`;
const AREA = `${P}000000000011`;
const AREA_B = `${P}000000000012`;
const TENANT_A = `${P}000000000021`;
const TENANT_B = `${P}000000000022`;

describe('Area slugs (0036)', () => {
  let admin: Sql;

  let n = 0;
  const insert = async (tenant: string, nameEn: string | null) => {
    n += 1;
    const [row] = await admin<{ id: string; slug: string }[]>`
      insert into localities (tenant_id, name_bn, name_en) values (${tenant}, ${`এলাকা ${n}`}, ${nameEn})
      returning id, slug`;
    return row!;
  };

  async function cleanUp(): Promise<void> {
    await admin`delete from localities where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Slug Partner', 'Slug Partner', '+8801766520099')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release)
      values (${AREA}, 3, 'upazila', 'area-slugs', 'Area Slugs', 'fixture'),
        (${AREA_B}, 3, 'upazila', 'area-slugs-b', 'Area Slugs B', 'fixture')`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
        (${TENANT_A}, ${PARTNER}, ${AREA}, 'area-slugs-a', 'এ', 'A', st_point(90.4, 23.8)::geography, 'active'),
        (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'area-slugs-b', 'বি', 'B', st_point(90.4, 23.8)::geography, 'active')`;
  });

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await admin.end();
    }
  });

  it('comes from the English name, and repeats get -2, -3 within a tenant only', async () => {
    expect((await insert(TENANT_A, 'Mirpur 10')).slug).toBe('mirpur-10');
    expect((await insert(TENANT_A, 'Mirpur-10!')).slug).toBe('mirpur-10-2');
    expect((await insert(TENANT_A, '  mirpur 10 ')).slug).toBe('mirpur-10-3');
    expect((await insert(TENANT_B, 'Mirpur 10')).slug).toBe('mirpur-10');
  });

  it('falls back to the id without an English name', async () => {
    const row = await insert(TENANT_A, null);
    expect(row.slug).toBe(`area-${row.id.replaceAll('-', '').slice(0, 8)}`);
  });

  it('is kept when the area is renamed', async () => {
    const row = await insert(TENANT_A, 'Kazipara');
    await admin`update localities set name_en = 'Kazi Para' where id = ${row.id}`;
    const [after] = await admin<
      { slug: string }[]
    >`select slug from localities where id = ${row.id}`;
    expect(after!.slug).toBe('kazipara');
  });

  it('refuses a malformed or duplicate slug', async () => {
    await expect(
      admin`insert into localities (tenant_id, name_bn, slug) values (${TENANT_A}, 'খারাপ', 'Bad Slug')`,
    ).rejects.toThrow(/localities_slug_ck/);
    await expect(
      admin`insert into localities (tenant_id, name_bn, slug) values (${TENANT_A}, 'দ্বিতীয়', 'kazipara')`,
    ).rejects.toThrow(/localities_tenant_slug_uq/);
  });
});
