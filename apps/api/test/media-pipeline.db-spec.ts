import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * Migration 0019: what counts as "attached" (media_asset_is_referenced), the
 * system-only delete of unreferenced media, and a post's deletion
 * soft-deleting the media only it uses. Setup runs as the superuser; the
 * delete policy is checked as ae_app in the member and system contexts.
 */

const PARTNER = '0191e3a0-6161-7000-8000-000000000001';
const GEO_AREA = '0191e3a0-6161-7000-8000-000000000011';
const TENANT = '0191e3a0-6161-7000-8000-000000000021';
const USER = '0191e3a0-6161-7000-8000-000000000031';
const MEMBER = '0191e3a0-6161-7000-8000-000000000041';
const CATEGORY = '0191e3a0-6161-7000-8000-000000000051';
const SCHEMA = '0191e3a0-6161-7000-8000-000000000061';
const POST_A = '0191e3a0-6161-7000-8000-000000000071';
const POST_B = '0191e3a0-6161-7000-8000-000000000072';
const ONLY_A = '0191e3a0-6161-7000-8000-000000000081';
const SHARED = '0191e3a0-6161-7000-8000-000000000082';
const HELD = '0191e3a0-6161-7000-8000-000000000083';
const LOOSE = '0191e3a0-6161-7000-8000-000000000084';
const AVATAR = '0191e3a0-6161-7000-8000-000000000085';
const FIXTURE_PREFIX = '0191e3a0-6161-7000-8000-%';

async function as<T>(
  sql: Sql,
  context: Record<string, string>,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    for (const [key, value] of Object.entries(context)) {
      await tx`select set_config(${`app.${key}`}, ${value}, true)`;
    }
    return work(tx);
  }) as Promise<T>;
}

const SYSTEM = { role: 'system', is_platform_admin: 'true' };
const MEMBER_CONTEXT = { tenant_id: TENANT, user_id: USER, member_id: MEMBER, role: 'member' };

describe('Media pipeline (0019)', () => {
  let admin: Sql;
  let app: Sql;

  async function cleanUp(): Promise<void> {
    await admin`delete from media_attachments where tenant_id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from posts where tenant_id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from media_assets where tenant_id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from category_field_schemas where category_id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from categories where id::text like ${FIXTURE_PREFIX}`;
    await admin`update user_profiles set avatar_storage_key = null where user_id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from tenant_members where tenant_id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from users where id::text like ${FIXTURE_PREFIX}`;
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    app = testSqlClient(1, resolveTestAppDatabaseUrl());
    await cleanUp();

    await admin`insert into users (id, phone_e164) values (${USER}, '+8801766000001')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Media Pipeline Partner', 'Media Pipeline Partner', '+8801766000099')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release)
      values (${GEO_AREA}, 3, 'upazila', 'media-pipeline-a', 'Media Pipeline Area', 'fixture')`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values (${TENANT}, ${PARTNER}, ${GEO_AREA}, 'media-pipeline', 'এ', 'A', st_point(90.4, 23.8)::geography, 'active')`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values (${MEMBER}, ${TENANT}, ${USER}, 'member')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en)
      values (${CATEGORY}, 'marketplace', 'media-pipeline-cat', 'ক', 'C')`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, status_code, published_at)
      values (${SCHEMA}, ${CATEGORY}, 1, '{"type":"object"}', 'published', now())`;
    await admin`
      insert into posts (id, tenant_id, author_member_id, category_id, field_schema_id, title) values
        (${POST_A}, ${TENANT}, ${MEMBER}, ${CATEGORY}, ${SCHEMA}, 'A'),
        (${POST_B}, ${TENANT}, ${MEMBER}, ${CATEGORY}, ${SCHEMA}, 'B')`;

    for (const [id, hold] of [
      [ONLY_A, false],
      [SHARED, false],
      [HELD, true],
      [LOOSE, false],
      [AVATAR, false],
    ] as const) {
      await admin`
        insert into media_assets
          (id, tenant_id, uploaded_by_user_id, kind_code, storage_key, mime_type, byte_size,
           checksum_sha256, status_code, evidence_hold)
        values (${id}, ${TENANT}, ${USER}, 'image', ${`media-pipeline/${id}`}, 'image/webp', 10,
                ${'a'.repeat(64)}, 'ready', ${hold})`;
    }
    await admin`
      insert into media_attachments (tenant_id, media_asset_id, post_id) values
        (${TENANT}, ${ONLY_A}, ${POST_A}),
        (${TENANT}, ${SHARED}, ${POST_A}),
        (${TENANT}, ${SHARED}, ${POST_B}),
        (${TENANT}, ${HELD}, ${POST_A})`;
    await admin`
      insert into user_profiles (user_id, display_name, avatar_storage_key)
      values (${USER}, 'Media Tester', ${`media-pipeline/${AVATAR}`})
      on conflict (user_id) do update set avatar_storage_key = excluded.avatar_storage_key`;
  });

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await Promise.all([admin.end(), app.end()]);
    }
  });

  it('counts attachments and avatars as references', async () => {
    const rows = await admin<{ id: string; referenced: boolean }[]>`
      select id, public.media_asset_is_referenced(id, storage_key) as referenced
      from media_assets where tenant_id = ${TENANT} order by id`;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.referenced]))).toEqual({
      [ONLY_A]: true,
      [SHARED]: true,
      [HELD]: true,
      [LOOSE]: false,
      [AVATAR]: true,
    });
  });

  it('lets only the system role delete, and only unreferenced media', async () => {
    const memberDelete = await as(
      app,
      MEMBER_CONTEXT,
      (tx) => tx`delete from media_assets where id = ${LOOSE}`,
    );
    expect(memberDelete.count).toBe(0);

    const referenced = await as(
      app,
      SYSTEM,
      (tx) => tx`delete from media_assets where id in (${ONLY_A}, ${AVATAR})`,
    );
    expect(referenced.count).toBe(0);

    const loose = await as(app, SYSTEM, (tx) => tx`delete from media_assets where id = ${LOOSE}`);
    expect(loose.count).toBe(1);
  });

  it("soft-deletes a deleted post's own media, not shared or held media", async () => {
    await admin`
      update posts set deleted_at = now(), deletion_reason_code = 'user_deleted' where id = ${POST_A}`;
    const rows = await admin<{ id: string; deleted: boolean; purge_days: number | null }[]>`
      select id, deleted_at is not null as deleted,
             extract(day from (purge_due_at - deleted_at))::int as purge_days
      from media_assets where id in (${ONLY_A}, ${SHARED}, ${HELD}) order by id`;
    expect(rows).toEqual([
      { id: ONLY_A, deleted: true, purge_days: 30 },
      { id: SHARED, deleted: false, purge_days: null },
      // Soft-deleted with the post, but never due for purge while held.
      { id: HELD, deleted: true, purge_days: null },
    ]);
  });

  it('seeds the upload and variant settings', async () => {
    const rows = await admin<{ key: string }[]>`
      select key from platform_settings where key like 'media_%' order by key`;
    expect(rows.map((r) => r.key)).toEqual(
      expect.arrayContaining([
        'media_image_quality',
        'media_max_input_pixels',
        'media_upload_bytes_per_day',
        'media_uploads_per_day',
        'media_uploads_per_hour',
        'media_variant_card_px',
        'media_variant_full_px',
        'media_variant_thumb_px',
      ]),
    );
  });
});
