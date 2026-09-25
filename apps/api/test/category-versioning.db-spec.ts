import type { Sql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * Migration 0018: monetization_mode_code, one draft per category, and the
 * versioning rules that keep old posts renderable: a published version may
 * only move to retired, a retired one never changes, and the app can only
 * ever delete drafts. Triggers and constraints are checked as the superuser
 * (they bind everyone); the draft-only delete policy as ae_app.
 */

const CATEGORY = '0191e3a0-7777-7000-8000-000000000051';
const V1 = '0191e3a0-7777-7000-8000-000000000061';
const V2 = '0191e3a0-7777-7000-8000-000000000062';
const V3 = '0191e3a0-7777-7000-8000-000000000063';
const FIXTURE_PREFIX = '0191e3a0-7777-7000-8000-%';

async function sqlStateOf(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught as { code?: string },
  );
  if (!error) throw new Error('expected the statement to be rejected, but it succeeded');
  return error.code;
}

describe('Category field-schema versioning (0018)', () => {
  let admin: Sql;
  let app: Sql;

  async function cleanUp(): Promise<void> {
    await admin`delete from category_field_schemas where category_id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from categories where id::text like ${FIXTURE_PREFIX}`;
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    app = testSqlClient(1, resolveTestAppDatabaseUrl());
    await cleanUp();
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en, monetization_mode_code)
      values (${CATEGORY}, 'rental', 'category-versioning', 'ভাড়া', 'Rent', 'per_listing')`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, status_code, published_at)
      values (${V1}, ${CATEGORY}, 1, '{"v":1}', 'published', now())`;
  });

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await Promise.all([admin.end(), app.end()]);
    }
  });

  it('stores the monetization mode and rejects an unknown one', async () => {
    const [row] = await admin<{ mode: string }[]>`
      select monetization_mode_code as mode from categories where id = ${CATEGORY}`;
    expect(row?.mode).toBe('per_listing');
    expect(
      await sqlStateOf(
        admin`update categories set monetization_mode_code = 'bribe' where id = ${CATEGORY}`,
      ),
    ).toBe('23503');
  });

  it('allows one draft per category', async () => {
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema)
      values (${V2}, ${CATEGORY}, 2, '{"v":2}')`;
    expect(
      await sqlStateOf(
        admin`insert into category_field_schemas (id, category_id, version, json_schema)
              values (${V3}, ${CATEGORY}, 3, '{"v":3}')`,
      ),
    ).toBe('23505');
  });

  it('never lets a published version change content', async () => {
    expect(
      await sqlStateOf(
        admin`update category_field_schemas set json_schema = '{"v":"edited"}' where id = ${V1}`,
      ),
    ).toBe('42501');
    expect(
      await sqlStateOf(
        admin`update category_field_schemas set status_code = 'draft', published_at = null where id = ${V1}`,
      ),
    ).toBe('42501');
  });

  it('keeps at most one published version, so the old one must be retired first', async () => {
    expect(
      await sqlStateOf(
        admin`update category_field_schemas set status_code = 'published', published_at = now()
              where id = ${V2}`,
      ),
    ).toBe('23505');
  });

  it('publishes v2 by retiring v1 (published_at kept) and publishing the draft', async () => {
    await admin.begin(async (tx) => {
      await tx`update category_field_schemas set status_code = 'retired' where id = ${V1}`;
      await tx`update category_field_schemas set status_code = 'published', published_at = now()
               where id = ${V2}`;
    });
    const rows = await admin<{ version: number; status: string; published: boolean }[]>`
      select version, status_code as status, published_at is not null as published
      from category_field_schemas where category_id = ${CATEGORY} order by version`;
    expect(rows).toEqual([
      { version: 1, status: 'retired', published: true },
      { version: 2, status: 'published', published: true },
    ]);
  });

  it('never changes a retired version, nor brings it back', async () => {
    expect(
      await sqlStateOf(
        admin`update category_field_schemas set json_schema = '{"v":"edited"}' where id = ${V1}`,
      ),
    ).toBe('42501');
    expect(
      await sqlStateOf(
        admin`update category_field_schemas set status_code = 'published' where id = ${V1}`,
      ),
    ).toBe('42501');
  });

  it('still lets ON DELETE SET NULL clear the publisher', async () => {
    await admin`update category_field_schemas set published_by_user_id = null where id = ${V1}`;
  });

  it('lets the app delete a draft, and nothing else, even as platform admin', async () => {
    const asPlatformAdmin = async (work: (tx: Sql) => Promise<unknown>) =>
      app.begin(async (tx) => {
        await tx`select set_config('app.role', 'platform_admin', true)`;
        await tx`select set_config('app.is_platform_admin', 'true', true)`;
        return work(tx as unknown as Sql);
      });

    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema)
      values (${V3}, ${CATEGORY}, 3, '{"v":3}')`;
    await asPlatformAdmin(
      (tx) => tx`delete from category_field_schemas where category_id = ${CATEGORY}`,
    );

    const rows = await admin<{ id: string }[]>`
      select id from category_field_schemas where category_id = ${CATEGORY} order by version`;
    expect(rows.map((r) => r.id)).toEqual([V1, V2]);
  });
});
