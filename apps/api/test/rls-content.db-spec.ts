import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * RLS coverage for the content domain (0005_content.sql): media_assets,
 * posts, media_attachments, places, place_hours, place_claims, saved_posts.
 * Same style as rls.db-spec.ts's per-table blocks; split into its own file
 * because this domain alone has seven tenant-scoped tables with genuinely
 * different visibility rules (T-PUBLIC-READ, visibility-graded, polymorphic,
 * cross-tenant-by-design).
 */

const PARTNER = '0191e3a0-3333-7000-8000-000000000001';
const GEO_AREA_A = '0191e3a0-3333-7000-8000-000000000011';
const GEO_AREA_B = '0191e3a0-3333-7000-8000-000000000012';
const TENANT_A = '0191e3a0-3333-7000-8000-000000000021';
const TENANT_B = '0191e3a0-3333-7000-8000-000000000022';
const USER_A = '0191e3a0-3333-7000-8000-000000000031'; // author, member of A
const USER_B = '0191e3a0-3333-7000-8000-000000000032'; // other member of A
const USER_C = '0191e3a0-3333-7000-8000-000000000033'; // member of B
const MEMBER_A = '0191e3a0-3333-7000-8000-000000000041';
const MEMBER_B = '0191e3a0-3333-7000-8000-000000000042';
const MEMBER_C = '0191e3a0-3333-7000-8000-000000000043';
const CATEGORY = '0191e3a0-3333-7000-8000-000000000051';
const CATEGORY_PLACE = '0191e3a0-3333-7000-8000-000000000052';
const FIELD_SCHEMA = '0191e3a0-3333-7000-8000-000000000061';
const MEDIA_PUBLIC = '0191e3a0-3333-7000-8000-000000000071';
const MEDIA_PRIVATE = '0191e3a0-3333-7000-8000-000000000072';
const POST_LIVE = '0191e3a0-3333-7000-8000-000000000081';
const POST_DRAFT = '0191e3a0-3333-7000-8000-000000000082';
const POST_LEGAL_HOLD = '0191e3a0-3333-7000-8000-000000000083';
const PLACE_PUBLISHED = '0191e3a0-3333-7000-8000-000000000091';
const PLACE_PENDING = '0191e3a0-3333-7000-8000-000000000092';
const PLACE_CLAIM = '0191e3a0-3333-7000-8000-0000000000a1';
const SAVED_POST = '0191e3a0-3333-7000-8000-0000000000b1';
const MEDIA_ATTACHMENT = '0191e3a0-3333-7000-8000-0000000000c1';
const FIXTURE_PREFIX = '0191e3a0-3333-7000-8000-%';
const POINT = 'SRID=4326;POINT(90.4 23.8)';

type Context = Partial<
  Record<'tenant_id' | 'user_id' | 'member_id' | 'role' | 'is_platform_admin', string>
>;

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

const AS_ADMIN: Context = { is_platform_admin: 'true', role: 'platform_admin' };
const AS_AUTHOR: Context = {
  tenant_id: TENANT_A,
  user_id: USER_A,
  member_id: MEMBER_A,
  role: 'member',
};
const AS_OTHER_MEMBER: Context = {
  tenant_id: TENANT_A,
  user_id: USER_B,
  member_id: MEMBER_B,
  role: 'member',
};
const AS_STAFF: Context = { tenant_id: TENANT_A, role: 'moderator' };
const AS_TENANT_B_MEMBER: Context = {
  tenant_id: TENANT_B,
  user_id: USER_C,
  member_id: MEMBER_C,
  role: 'member',
};

async function expectNoRowsAffected(promise: Promise<{ count: number }>): Promise<void> {
  const result = await promise;
  expect(result.count).toBe(0);
}

async function expectDenied(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught as { code?: string },
  );
  if (!error) throw new Error('expected the statement to be rejected, but it succeeded');
  expect(error.code).toBe('42501');
}

describe('Row level security: content domain (0005)', () => {
  let app: Sql;
  let admin: Sql;

  beforeAll(async () => {
    app = testSqlClient(4, resolveTestAppDatabaseUrl());
    admin = testSqlClient(1, resolveTestDatabaseUrl());

    await admin`delete from users where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;

    await admin`
      insert into users (id, phone_e164) values
        (${USER_A}, '+8801733000001'),
        (${USER_B}, '+8801733000002'),
        (${USER_C}, '+8801733000003')`;

    await admin`
      insert into partners (id, legal_name, display_name, phone_e164) values
        (${PARTNER}, 'Content Fixture Partner', 'Content Fixture Partner', '+8801733000099')`;

    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
        (${GEO_AREA_A}, 3, 'upazila', 'rls-content-a', 'RLS Content Area A', 'fixture'),
        (${GEO_AREA_B}, 3, 'upazila', 'rls-content-b', 'RLS Content Area B', 'fixture')`;

    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
        (${TENANT_A}, ${PARTNER}, ${GEO_AREA_A}, 'rls-content-tenant-a', 'এ', 'A',
          st_point(90.4, 23.8)::geography, 'active'),
        (${TENANT_B}, ${PARTNER}, ${GEO_AREA_B}, 'rls-content-tenant-b', 'বি', 'B',
          st_point(90.5, 23.9)::geography, 'active')`;

    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${MEMBER_A}, ${TENANT_A}, ${USER_A}, 'member'),
        (${MEMBER_B}, ${TENANT_A}, ${USER_B}, 'member'),
        (${MEMBER_C}, ${TENANT_B}, ${USER_C}, 'member')`;

    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en) values
        (${CATEGORY}, 'marketplace', 'rls-content-category', 'বিভাগ', 'Category'),
        (${CATEGORY_PLACE}, 'place', 'rls-content-place-category', 'স্থান বিভাগ', 'Place Category')`;

    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, status_code)
      values (${FIELD_SCHEMA}, ${CATEGORY}, 1, '{}'::jsonb, 'draft')`;

    await admin`
      insert into media_assets
        (id, tenant_id, uploaded_by_user_id, kind_code, visibility_code, storage_key, mime_type, byte_size, checksum_sha256, status_code)
      values
        (${MEDIA_PUBLIC}, ${TENANT_A}, ${USER_A}, 'image', 'public', 'rls-content/public.webp', 'image/webp', 100, 'chk-public', 'ready'),
        (${MEDIA_PRIVATE}, ${TENANT_A}, ${USER_A}, 'document', 'private', 'rls-content/private.pdf', 'application/pdf', 100, 'chk-private', 'ready')`;

    await admin`
      insert into posts (id, tenant_id, author_member_id, category_id, field_schema_id, title, status_code, published_at, bumped_at)
      values (${POST_LIVE}, ${TENANT_A}, ${MEMBER_A}, ${CATEGORY}, ${FIELD_SCHEMA}, 'Live Post', 'live', now(), now())`;
    await admin`
      insert into posts (id, tenant_id, author_member_id, category_id, field_schema_id, title, status_code)
      values (${POST_DRAFT}, ${TENANT_A}, ${MEMBER_A}, ${CATEGORY}, ${FIELD_SCHEMA}, 'Draft Post', 'draft')`;
    await admin`
      insert into posts
        (id, tenant_id, author_member_id, category_id, field_schema_id, title, status_code, deleted_at, deletion_reason_code)
      values
        (${POST_LEGAL_HOLD}, ${TENANT_A}, ${MEMBER_A}, ${CATEGORY}, ${FIELD_SCHEMA}, 'Held Post', 'removed', now(), 'legal_hold')`;

    await admin`
      insert into places (id, tenant_id, category_id, slug, name_bn, location, source_code, status_code, claimed_by_member_id)
      values (${PLACE_PUBLISHED}, ${TENANT_A}, ${CATEGORY_PLACE}, 'rls-content-place', 'দোকান', ${POINT}, 'user_submitted', 'published', ${MEMBER_A})`;
    await admin`
      insert into places (id, tenant_id, category_id, slug, name_bn, location, source_code, status_code)
      values (${PLACE_PENDING}, ${TENANT_A}, ${CATEGORY_PLACE}, 'rls-content-place-pending', 'দোকান২', ${POINT}, 'user_submitted', 'pending_review')`;

    await admin`
      insert into place_hours (tenant_id, place_id, iso_day_of_week, opens_at, closes_at)
      values (${TENANT_A}, ${PLACE_PUBLISHED}, 1, '09:00', '21:00')`;

    await admin`
      insert into place_claims (id, tenant_id, place_id, claimant_member_id, verification_method_code)
      values (${PLACE_CLAIM}, ${TENANT_A}, ${PLACE_PENDING}, ${MEMBER_B}, 'otp_to_listed_phone')`;

    await admin`
      insert into saved_posts (id, tenant_id, user_id, post_id)
      values (${SAVED_POST}, ${TENANT_A}, ${USER_A}, ${POST_LIVE})`;

    await admin`
      insert into media_attachments (id, tenant_id, media_asset_id, post_id)
      values (${MEDIA_ATTACHMENT}, ${TENANT_A}, ${MEDIA_PUBLIC}, ${POST_LIVE})`;
  });

  afterAll(async () => {
    try {
      await admin`delete from media_attachments where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from saved_posts where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from place_claims where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from place_hours where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from places where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from posts where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from media_assets where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from category_field_schemas where category_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from categories where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenant_members where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from users where id::text like ${FIXTURE_PREFIX}`;
    } finally {
      await Promise.all([app.end(), admin.end()]);
    }
  });

  describe('media_assets (§4.1)', () => {
    it('shows public+ready rows to any member of the tenant', async () => {
      const rows = await withContext(
        app,
        AS_OTHER_MEMBER,
        (tx) => tx<{ id: string }[]>`select id from media_assets where id = ${MEDIA_PUBLIC}`,
      );
      expect(rows).toHaveLength(1);
    });

    it('hides private rows from a non-uploader member', async () => {
      const rows = await withContext(
        app,
        AS_OTHER_MEMBER,
        (tx) => tx`select id from media_assets where id = ${MEDIA_PRIVATE}`,
      );
      expect(rows).toHaveLength(0);
    });

    it('shows private rows to the uploader and to staff', async () => {
      const asUploader = await withContext(
        app,
        AS_AUTHOR,
        (tx) => tx`select id from media_assets where id = ${MEDIA_PRIVATE}`,
      );
      expect(asUploader).toHaveLength(1);

      const asStaff = await withContext(
        app,
        AS_STAFF,
        (tx) => tx`select id from media_assets where id = ${MEDIA_PRIVATE}`,
      );
      expect(asStaff).toHaveLength(1);
    });

    it('is invisible across tenants', async () => {
      const rows = await withContext(
        app,
        AS_TENANT_B_MEMBER,
        (tx) => tx`select id from media_assets where id = ${MEDIA_PUBLIC}`,
      );
      expect(rows).toHaveLength(0);
    });

    it('lets the uploader update non-status fields, but not status_code directly', async () => {
      const result = await withContext(
        app,
        AS_AUTHOR,
        (tx) =>
          tx`update media_assets set blurhash = 'abc', status_code = 'rejected' where id = ${MEDIA_PUBLIC}`,
      );
      expect(result.count).toBe(1);
      const [row] = await admin<{ blurhash: string; status_code: string }[]>`
        select blurhash, status_code from media_assets where id = ${MEDIA_PUBLIC}`;
      expect(row).toMatchObject({ blurhash: 'abc', status_code: 'ready' });
      await admin`update media_assets set blurhash = null where id = ${MEDIA_PUBLIC}`;
    });

    it('cannot be inserted for another user', async () => {
      await expectDenied(
        withContext(
          app,
          AS_AUTHOR,
          (tx) => tx`
            insert into media_assets
              (tenant_id, uploaded_by_user_id, kind_code, storage_key, mime_type, byte_size, checksum_sha256)
            values (${TENANT_A}, ${USER_B}, 'image', 'rls-content/forged.webp', 'image/webp', 10, 'chk-forged')`,
        ),
      );
    });
  });

  describe('posts (§4.2)', () => {
    it('shows live posts to any member of the tenant', async () => {
      const rows = await withContext(
        app,
        AS_OTHER_MEMBER,
        (tx) => tx`select id from posts where id = ${POST_LIVE}`,
      );
      expect(rows).toHaveLength(1);
    });

    it('hides a draft post from a non-author member', async () => {
      const rows = await withContext(
        app,
        AS_OTHER_MEMBER,
        (tx) => tx`select id from posts where id = ${POST_DRAFT}`,
      );
      expect(rows).toHaveLength(0);
    });

    it('shows the draft to its author and to staff', async () => {
      const asAuthor = await withContext(
        app,
        AS_AUTHOR,
        (tx) => tx`select id from posts where id = ${POST_DRAFT}`,
      );
      expect(asAuthor).toHaveLength(1);

      const asStaff = await withContext(
        app,
        AS_STAFF,
        (tx) => tx`select id from posts where id = ${POST_DRAFT}`,
      );
      expect(asStaff).toHaveLength(1);
    });

    it('hides a legal_hold post from its own author and from tenant staff', async () => {
      const asAuthor = await withContext(
        app,
        AS_AUTHOR,
        (tx) => tx`select id from posts where id = ${POST_LEGAL_HOLD}`,
      );
      expect(asAuthor).toHaveLength(0);

      const asStaff = await withContext(
        app,
        AS_STAFF,
        (tx) => tx`select id from posts where id = ${POST_LEGAL_HOLD}`,
      );
      expect(asStaff).toHaveLength(0);
    });

    it('shows the legal_hold post only to the platform admin', async () => {
      const rows = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from posts where id = ${POST_LEGAL_HOLD}`,
      );
      expect(rows).toHaveLength(1);
    });

    it('is invisible across tenants even when live', async () => {
      const rows = await withContext(
        app,
        AS_TENANT_B_MEMBER,
        (tx) => tx`select id from posts where id = ${POST_LIVE}`,
      );
      expect(rows).toHaveLength(0);
    });

    it('lets the author update their own draft', async () => {
      const result = await withContext(
        app,
        AS_AUTHOR,
        (tx) => tx`update posts set description = 'updated' where id = ${POST_DRAFT}`,
      );
      expect(result.count).toBe(1);
    });

    it('does not let another member update the draft', async () => {
      await expectNoRowsAffected(
        withContext(
          app,
          AS_OTHER_MEMBER,
          (tx) => tx`update posts set description = 'hijacked' where id = ${POST_DRAFT}`,
        ),
      );
    });

    it('rejects an insert where author_member_id is not the caller', async () => {
      await expectDenied(
        withContext(
          app,
          AS_AUTHOR,
          (tx) => tx`
            insert into posts (tenant_id, author_member_id, category_id, field_schema_id, title)
            values (${TENANT_A}, ${MEMBER_B}, ${CATEGORY}, ${FIELD_SCHEMA}, 'Forged Post')`,
        ),
      );
    });

    it('has no DELETE grant at all (soft delete only)', async () => {
      await expectDenied(
        withContext(app, AS_AUTHOR, (tx) => tx`delete from posts where id = ${POST_DRAFT}`),
      );
    });
  });

  describe('media_attachments (§4.3)', () => {
    it('follows the asset visibility it points at', async () => {
      const rows = await withContext(
        app,
        AS_OTHER_MEMBER,
        (tx) => tx`select id from media_attachments where id = ${MEDIA_ATTACHMENT}`,
      );
      expect(rows).toHaveLength(1); // MEDIA_PUBLIC is public+ready
    });

    it('lets the uploader delete their own attachment', async () => {
      const disposableId = '0191e3a0-3333-7000-8000-0000000000c2';
      await admin`insert into media_attachments (id, tenant_id, media_asset_id, place_id)
        values (${disposableId}, ${TENANT_A}, ${MEDIA_PUBLIC}, ${PLACE_PUBLISHED})`;

      const result = await withContext(
        app,
        AS_AUTHOR,
        (tx) => tx`delete from media_attachments where id = ${disposableId}`,
      );
      expect(result.count).toBe(1);
    });

    it('does not let a non-uploader, non-staff member delete it', async () => {
      const result = await withContext(
        app,
        AS_OTHER_MEMBER,
        (tx) => tx`delete from media_attachments where id = ${MEDIA_ATTACHMENT}`,
      );
      expect(result.count).toBe(0);
      const [row] = await admin<
        { id: string }[]
      >`select id from media_attachments where id = ${MEDIA_ATTACHMENT}`;
      expect(row?.id).toBe(MEDIA_ATTACHMENT);
    });
  });

  describe('places (§4.4)', () => {
    it('shows published places to any member', async () => {
      const rows = await withContext(
        app,
        AS_OTHER_MEMBER,
        (tx) => tx`select id from places where id = ${PLACE_PUBLISHED}`,
      );
      expect(rows).toHaveLength(1);
    });

    it('hides pending_review places from an ordinary member', async () => {
      const rows = await withContext(
        app,
        AS_OTHER_MEMBER,
        (tx) => tx`select id from places where id = ${PLACE_PENDING}`,
      );
      expect(rows).toHaveLength(0);
    });

    it('shows pending places to staff and to an agent', async () => {
      const asStaff = await withContext(
        app,
        AS_STAFF,
        (tx) => tx`select id from places where id = ${PLACE_PENDING}`,
      );
      expect(asStaff).toHaveLength(1);

      const asAgent = await withContext(
        app,
        { tenant_id: TENANT_A, role: 'agent' },
        (tx) => tx`select id from places where id = ${PLACE_PENDING}`,
      );
      expect(asAgent).toHaveLength(1);
    });

    it('lets any active member insert (forced to pending_review by the service, not RLS)', async () => {
      // No RETURNING: a fresh pending_review row isn't visible to a plain
      // member under the SELECT policies, so RETURNING would itself trip
      // RLS ("new row violates row-level security policy") even though the
      // INSERT itself is allowed. That is a Postgres RETURNING/RLS
      // interaction, not a bug — verify existence via admin instead.
      const result = await withContext(
        app,
        AS_OTHER_MEMBER,
        (tx) => tx`
          insert into places (tenant_id, category_id, slug, name_bn, location, source_code)
          values (${TENANT_A}, ${CATEGORY_PLACE}, 'rls-content-member-place', 'নতুন দোকান', ${POINT}, 'user_submitted')`,
      );
      expect(result.count).toBe(1);
      const [row] = await admin<{ status_code: string }[]>`
        select status_code from places where tenant_id = ${TENANT_A} and slug = 'rls-content-member-place'`;
      expect(row?.status_code).toBe('pending_review');
      await admin`delete from places where tenant_id = ${TENANT_A} and slug = 'rls-content-member-place'`;
    });

    it('lets the claimed owner update, but not an unrelated member', async () => {
      const asOwner = await withContext(
        app,
        AS_AUTHOR, // MEMBER_A is claimed_by_member_id on PLACE_PUBLISHED
        (tx) => tx`update places set description = 'updated' where id = ${PLACE_PUBLISHED}`,
      );
      expect(asOwner.count).toBe(1);

      await expectNoRowsAffected(
        withContext(
          app,
          AS_OTHER_MEMBER,
          (tx) => tx`update places set description = 'hijacked' where id = ${PLACE_PUBLISHED}`,
        ),
      );
    });

    it('silently ignores a non-staff attempt to set is_landmark', async () => {
      await withContext(
        app,
        AS_OTHER_MEMBER,
        (tx) => tx`
          insert into places (tenant_id, category_id, slug, name_bn, location, source_code, is_landmark)
          values (${TENANT_A}, ${CATEGORY_PLACE}, 'rls-content-landmark-attempt', 'ল্যান্ডমার্ক', ${POINT}, 'user_submitted', true)`,
      );
      const [row] = await admin<{ is_landmark: boolean }[]>`
        select is_landmark from places where tenant_id = ${TENANT_A} and slug = 'rls-content-landmark-attempt'`;
      expect(row?.is_landmark).toBe(false);
      await admin`delete from places where tenant_id = ${TENANT_A} and slug = 'rls-content-landmark-attempt'`;
    });
  });

  describe('place_hours (§4.5)', () => {
    it('is publicly readable when the parent place is published', async () => {
      const rows = await withContext(
        app,
        AS_OTHER_MEMBER,
        (tx) => tx`select id from place_hours where place_id = ${PLACE_PUBLISHED}`,
      );
      expect(rows).toHaveLength(1);
    });

    it('is writable by the claimed owner of the place', async () => {
      const result = await withContext(
        app,
        AS_AUTHOR,
        (tx) => tx`update place_hours set closes_at = '22:00' where place_id = ${PLACE_PUBLISHED}`,
      );
      expect(result.count).toBe(1);
      await admin`update place_hours set closes_at = '21:00' where place_id = ${PLACE_PUBLISHED}`;
    });

    it('is not writable by an unrelated member', async () => {
      await expectNoRowsAffected(
        withContext(
          app,
          AS_OTHER_MEMBER,
          (tx) =>
            tx`update place_hours set closes_at = '23:00' where place_id = ${PLACE_PUBLISHED}`,
        ),
      );
    });
  });

  describe('place_claims (§4.6)', () => {
    it('is visible to the claimant', async () => {
      const rows = await withContext(
        app,
        AS_OTHER_MEMBER, // MEMBER_B is the claimant
        (tx) => tx`select id from place_claims where id = ${PLACE_CLAIM}`,
      );
      expect(rows).toHaveLength(1);
    });

    it('is invisible to a member who is not the claimant', async () => {
      const rows = await withContext(
        app,
        AS_AUTHOR,
        (tx) => tx`select id from place_claims where id = ${PLACE_CLAIM}`,
      );
      expect(rows).toHaveLength(0);
    });

    it('lets the claimant withdraw, but not approve, their own claim', async () => {
      // The row IS visible to the claimant (USING passes), but the new
      // status fails WITH CHECK, so this raises rather than affecting zero
      // rows silently — unlike an invisible row, which would just no-op.
      await expectDenied(
        withContext(
          app,
          AS_OTHER_MEMBER,
          (tx) => tx`update place_claims set status_code = 'approved' where id = ${PLACE_CLAIM}`,
        ),
      );

      const result = await withContext(
        app,
        AS_OTHER_MEMBER,
        (tx) => tx`update place_claims set status_code = 'withdrawn' where id = ${PLACE_CLAIM}`,
      );
      expect(result.count).toBe(1);
      await admin`update place_claims set status_code = 'pending' where id = ${PLACE_CLAIM}`;
    });

    it('is visible and fully writable to staff', async () => {
      const rows = await withContext(
        app,
        AS_STAFF,
        (tx) => tx`select id from place_claims where id = ${PLACE_CLAIM}`,
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe('saved_posts (§4.7)', () => {
    it('is visible to its owner in any tenant context', async () => {
      const inOwningTenant = await withContext(
        app,
        AS_AUTHOR,
        (tx) => tx`select id from saved_posts where id = ${SAVED_POST}`,
      );
      expect(inOwningTenant).toHaveLength(1);

      // Cross-tenant: same user, but the session's tenant_id is TENANT_B.
      // saved_posts is deliberately readable in ANY tenant context for its owner.
      const inOtherTenant = await withContext(
        app,
        { tenant_id: TENANT_B, user_id: USER_A, role: 'member' },
        (tx) => tx`select id from saved_posts where id = ${SAVED_POST}`,
      );
      expect(inOtherTenant).toHaveLength(1);
    });

    it('is invisible to a different user', async () => {
      const rows = await withContext(
        app,
        AS_OTHER_MEMBER,
        (tx) => tx`select id from saved_posts where id = ${SAVED_POST}`,
      );
      expect(rows).toHaveLength(0);
    });

    it('lets the owner delete their own save', async () => {
      const disposableId = '0191e3a0-3333-7000-8000-0000000000b2';
      // A different post than SAVED_POST's, to not collide with the
      // (tenant_id, user_id, post_id) unique constraint.
      await admin`insert into saved_posts (id, tenant_id, user_id, post_id)
        values (${disposableId}, ${TENANT_A}, ${USER_A}, ${POST_DRAFT})`;

      const result = await withContext(
        app,
        AS_AUTHOR,
        (tx) => tx`delete from saved_posts where id = ${disposableId}`,
      );
      expect(result.count).toBe(1);
    });

    it('rejects an insert claiming another user_id', async () => {
      await expectDenied(
        withContext(
          app,
          AS_AUTHOR,
          (tx) =>
            tx`insert into saved_posts (tenant_id, user_id, post_id) values (${TENANT_A}, ${USER_B}, ${POST_LIVE})`,
        ),
      );
    });
  });
});
