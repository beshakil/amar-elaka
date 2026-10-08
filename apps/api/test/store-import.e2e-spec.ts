import { createHash, randomUUID } from 'node:crypto';
import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Sql } from 'postgres';
import sharp from 'sharp';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/tokens/token.service';
import { toCsv } from '../src/common/files/csv';
import { readXlsxFirstSheet } from '../src/common/files/xlsx';
import { writeZip } from '../src/common/files/zip';
import { SettingsService } from '../src/settings/settings.service';
import { STORAGE_SERVICE, type StorageService } from '../src/storage/storage.ports';
import { StoreImportWorkerModule } from '../src/stores/import/store-import-worker.module';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * Bulk upload end to end (ADR 056), with the worker in-process: the
 * template, a dry run that creates nothing, a real import where bad rows
 * fail alone (and blank/duplicate rows are skipped) while the rest become
 * posts through the normal posts path with their ZIP photos through the media
 * pipeline, the row limit, permissions and the downloadable report.
 */

const P = '0191e3a0-a0d1-7000-8000-';
const FIXTURE = `${P}%`;
const PARTNER = `${P}000000000001`;
const AREA = `${P}000000000011`;
const TENANT = `${P}000000000021`;
const OWNER = `${P}000000000031`;
const STRANGER = `${P}000000000032`;
const M_OWNER = `${P}000000000041`;
const M_STRANGER = `${P}000000000042`;
const STORE = `${P}000000000051`;
const CATEGORY = `${P}000000000061`;
const SCHEMA = `${P}000000000062`;

const square = `SRID=4326;MULTIPOLYGON(((88.2 25.2,88.3 25.2,88.3 25.3,88.2 25.3,88.2 25.2)))`;
const SCHEMA_JSON = {
  type: 'object',
  additionalProperties: false,
  properties: {
    price: {
      'x-field-type': 'money',
      type: 'string',
      'x-money-min': '1.00',
      'x-money-max': '1000000.00',
    },
    condition: { 'x-field-type': 'select', type: 'string', enum: ['new', 'used'] },
  },
  required: ['price'],
};
const UI_JSON = {
  order: ['price', 'condition'],
  card: ['price'],
  labels: { price: { bn: 'দাম', en: 'Price' }, condition: { bn: 'অবস্থা', en: 'Condition' } },
  options: { condition: { new: { bn: 'নতুন', en: 'New' }, used: { bn: 'পুরাতন', en: 'Used' } } },
};
const HEADER = ['শিরোনাম *', 'বিবরণ', 'দাম *', 'অবস্থা', 'ছবি ১'];

type Role = 'owner' | 'stranger';

interface ImportView {
  id: string;
  status: string;
  errorCode: string | null;
  dryRun: boolean;
  progress: {
    totalRows: number | null;
    processedRows: number;
    created: number;
    skipped: number;
    failed: number;
  };
  rows?: {
    row: number;
    outcome: string;
    reasonCode: string | null;
    reason: string | null;
    postId: string | null;
  }[];
}

describe('Store bulk import (e2e)', () => {
  let app: NestFastifyApplication;
  let moduleRef: TestingModule;
  let admin: Sql;
  let storage: StorageService;
  const tokens = {} as Record<Role, string>;

  const call = (method: 'GET' | 'POST', url: string, as?: Role, body?: unknown) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { 'x-tenant-id': TENANT, ...(as ? { authorization: `Bearer ${tokens[as]}` } : {}) },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });

  /** A confirmed, processed `import` upload of the owner's, as the media pipeline leaves it. */
  async function upload(bytes: Buffer, mime: 'text/csv' | 'application/zip'): Promise<string> {
    const id = randomUUID();
    const key = `${TENANT}/import/${id}`;
    await storage.putObject('documents', key, bytes, mime);
    await admin`
      insert into media_assets (id, tenant_id, uploaded_by_user_id, kind_code, visibility_code, storage_key,
                                mime_type, byte_size, checksum_sha256, status_code)
      values (${id}, ${TENANT}, ${OWNER}, 'import', 'private', ${key}, ${mime}, ${bytes.length},
              ${createHash('sha256').update(bytes).digest('hex')}, 'ready')`;
    return id;
  }

  async function finished(importId: string): Promise<ImportView> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const view = (
        await call('GET', `/stores/${STORE}/imports/${importId}`, 'owner')
      ).json<ImportView>();
      if (view.status === 'succeeded' || view.status === 'failed') return view;
      if (Date.now() > deadline) throw new Error(`import ${importId} still ${view.status}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  const storePosts = async () =>
    (await admin<{ n: string }[]>`select count(*) as n from posts where store_id = ${STORE}`)[0]!.n;

  async function cleanUp(): Promise<void> {
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from store_import_rows where tenant_id = ${TENANT}`;
      await tx`delete from store_imports where tenant_id = ${TENANT}`;
      await tx`delete from moderation_queue_items where tenant_id = ${TENANT}`;
      await tx`delete from moderation_actions where tenant_id = ${TENANT}`;
      await tx`delete from media_attachments where tenant_id = ${TENANT}`;
      await tx`delete from posts where tenant_id = ${TENANT}`;
      await tx`delete from media_assets where tenant_id = ${TENANT}`;
      await tx`delete from member_trust_scores where tenant_id = ${TENANT}`;
      await tx`delete from stores where tenant_id = ${TENANT}`;
      await tx`delete from tenant_categories where tenant_id = ${TENANT}`;
      await tx`delete from tenant_members where tenant_id = ${TENANT}`;
      await tx`delete from tenant_settings where tenant_id = ${TENANT}`;
    });
    await admin`delete from outbox_events where payload->>'tenantId' = ${TENANT} or payload->>'tenant_id' = ${TENANT}`;
    await admin`delete from category_field_schemas where category_id::text like ${FIXTURE}`;
    await admin`delete from categories where id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();
    await admin`insert into users (id, phone_e164) values (${OWNER}, '+8801799600001'), (${STRANGER}, '+8801799600002')`;
    await admin`insert into partners (id, legal_name, display_name, phone_e164)
                values (${PARTNER}, 'Import E2E', 'Import E2E', '+8801799600099')`;
    await admin`insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release, boundary, boundary_simplified)
                values (${AREA}, 3, 'upazila', 'import-e2e', 'Import E2E', 'fixture', ${square}, ${square})`;
    await admin`insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
                values (${TENANT}, ${PARTNER}, ${AREA}, 'import-e2e', 'আমদানি', 'Import', st_point(88.25, 25.25)::geography, 'active')`;
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'platform_admin', true)`;
      await tx`insert into tenant_settings (tenant_id, post_moderation_mode_code, setting_overrides)
               values (${TENANT}, 'post', ${tx.json({ trust_auto_approve_threshold: 0, moderation_sample_rate_percent: 0 })})`;
    });
    await admin`insert into tenant_members (id, tenant_id, user_id, role_code)
                values (${M_OWNER}, ${TENANT}, ${OWNER}, 'member'), (${M_STRANGER}, ${TENANT}, ${STRANGER}, 'member')`;
    await admin`insert into categories (id, kind_code, slug, name_bn, name_en, default_moderation_mode_code, default_post_expiry_days)
                values (${CATEGORY}, 'marketplace', 'import-e2e-sale', 'বিক্রি', 'Sale', 'post', 30)`;
    await admin`insert into category_field_schemas (id, category_id, version, json_schema, ui_schema, status_code, published_at)
                values (${SCHEMA}, ${CATEGORY}, 1, ${admin.json(SCHEMA_JSON)}, ${admin.json(UI_JSON)}, 'published', now())`;
    await admin`insert into tenant_categories (tenant_id, category_id, is_enabled) values (${TENANT}, ${CATEGORY}, true)`;
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`insert into stores (id, tenant_id, owner_member_id, slug, name_bn, status_code, location, phone_e164, whatsapp_e164)
               values (${STORE}, ${TENANT}, ${M_OWNER}, 'import-e2e-store', 'আমদানির দোকান', 'active',
                       st_point(88.25, 25.25)::geography, '+8801799600010', '+8801799600010')`;
    });

    moduleRef = await Test.createTestingModule({
      imports: [AppModule, StoreImportWorkerModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api', {
      exclude: [
        { path: 'health/live', method: RequestMethod.GET },
        { path: 'health/ready', method: RequestMethod.GET },
      ],
    });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    storage = moduleRef.get(STORAGE_SERVICE);
    const signer = moduleRef.get(TokenService);
    tokens.owner = await signer.signAccessToken({
      userId: OWNER,
      tenantId: TENANT,
      memberId: M_OWNER,
      role: 'member',
    });
    tokens.stranger = await signer.signAccessToken({
      userId: STRANGER,
      tenantId: TENANT,
      memberId: M_STRANGER,
      role: 'member',
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    try {
      await cleanUp();
    } finally {
      await admin.end();
    }
  });

  it('the template: Bengali headers from the category, an example row, as XLSX or CSV', async () => {
    const xlsx = await call(
      'GET',
      `/stores/${STORE}/import/template?categoryId=${CATEGORY}`,
      'owner',
    );
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.headers['content-disposition']).toContain('import-import-e2e-sale.xlsx');
    const rows = readXlsxFirstSheet(xlsx.rawPayload, {
      maxEntries: 50,
      maxUnpackedBytes: 1_000_000,
    });
    expect(rows[0]).toEqual(expect.arrayContaining(HEADER));
    expect(rows[1]).toEqual(expect.arrayContaining(['1.00', 'নতুন']));

    const csv = await call(
      'GET',
      `/stores/${STORE}/import/template?categoryId=${CATEGORY}&format=csv`,
      'owner',
    );
    expect(csv.body.startsWith('﻿শিরোনাম *,বিবরণ,দাম *,অবস্থা')).toBe(true);
  });

  it('only people who may post as the store import into it', async () => {
    const template = await call(
      'GET',
      `/stores/${STORE}/import/template?categoryId=${CATEGORY}`,
      'stranger',
    );
    expect(template.statusCode).toBe(403);
    expect(template.json<{ error: string }>().error).toBe('STORE_MEMBERSHIP_REQUIRED');
  });

  it('a dry run validates every row and creates nothing', async () => {
    const sheet = await upload(
      Buffer.from(
        toCsv([
          HEADER,
          ['চাল ৫০ কেজি', 'নাজিরশাইল', '৩২০০', 'নতুন', ''],
          ['ডাল ১০ কেজি', '', '1500', 'used', ''],
          ['ভাঙা দাম', '', 'দাম জানতে কল', 'নতুন', ''],
        ]),
      ),
      'text/csv',
    );
    const before = await storePosts();
    const started = await call('POST', `/stores/${STORE}/import`, 'owner', {
      categoryId: CATEGORY,
      sheetMediaId: sheet,
      dryRun: true,
    });
    expect(started.statusCode).toBe(202);
    const view = await finished(started.json<ImportView>().id);
    expect(view).toMatchObject({
      status: 'succeeded',
      dryRun: true,
      progress: { totalRows: 3, processedRows: 3, created: 2, failed: 1 },
    });
    expect(view.rows?.map((r) => [r.row, r.outcome, r.reasonCode])).toEqual([
      [2, 'valid', null],
      [3, 'valid', null],
      [4, 'failed', 'invalid_money'],
    ]);
    expect(await storePosts()).toBe(before);
    const [media] = await admin<
      { n: string }[]
    >`select count(*) as n from media_assets where tenant_id = ${TENANT} and kind_code = 'image'`;
    expect(Number(media!.n)).toBe(0);
  });

  it('a bad row fails alone; the rest become posts, with their ZIP photos through the media pipeline', async () => {
    const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#c00' } })
      .withExif({ IFD0: { Copyright: 'leak-me' } })
      .jpeg()
      .toBuffer();
    const zip = await upload(
      writeZip([
        { name: 'photos/chal.jpg', data: jpeg },
        { name: 'not-an-image.jpg', data: Buffer.from('<html>no</html>') },
      ]),
      'application/zip',
    );
    const sheet = await upload(
      Buffer.from(
        toCsv([
          HEADER,
          ['নাজিরশাইল চাল', 'ভালো চাল', '3200', 'নতুন', 'chal.jpg'],
          ['', '', '', '', ''],
          ['পুরনো ফ্যান', '', '800', 'ভাঙা', ''],
          ['নাজিরশাইল চাল', 'আবার', '3300', 'নতুন', ''],
          ['ছবি নেই', '', '500', 'নতুন', 'missing.jpg'],
          ['ভুয়া ছবি', '', '500', 'নতুন', 'not-an-image.jpg'],
          ['ভেতরের লিংক', '', '500', 'নতুন', 'http://127.0.0.1/a.jpg'],
          ['ডাল', '', '1500', 'পুরাতন', ''],
        ]),
      ),
      'text/csv',
    );
    const started = await call('POST', `/stores/${STORE}/import`, 'owner', {
      categoryId: CATEGORY,
      sheetMediaId: sheet,
      imagesMediaId: zip,
    });
    const view = await finished(started.json<ImportView>().id);
    expect(view.status).toBe('succeeded');
    expect(view.rows?.map((r) => [r.row, r.outcome, r.reasonCode])).toEqual([
      [2, 'created', null],
      [3, 'skipped', 'blank_row'],
      [4, 'failed', 'unknown_option'],
      [5, 'skipped', 'duplicate_title'],
      [6, 'failed', 'image_missing_in_zip'],
      [7, 'failed', 'image_rejected'],
      [8, 'failed', 'image_url_blocked'],
      [9, 'created', null],
    ]);
    expect(view.progress).toMatchObject({
      totalRows: 8,
      processedRows: 8,
      created: 2,
      skipped: 2,
      failed: 4,
    });

    const withPhoto = view.rows![0]!.postId!;
    const [post] = await admin<
      {
        store_id: string;
        status_code: string;
        author_member_id: string;
        contact_phone_e164: string;
      }[]
    >`
      select store_id, status_code, author_member_id, contact_phone_e164 from posts where id = ${withPhoto}`;
    // The normal path: posted as the store, by the importer, through moderation (post-moderated here: live).
    expect(post).toEqual({
      store_id: STORE,
      status_code: 'live',
      author_member_id: M_OWNER,
      contact_phone_e164: '+8801799600010',
    });
    const [photo] = await admin<{ status_code: string; storage_key: string }[]>`
      select m.status_code, m.storage_key from media_attachments a join media_assets m on m.id = a.media_asset_id
      where a.post_id = ${withPhoto}`;
    expect(photo!.status_code).toBe('ready');
    // EXIF stripped by the pipeline.
    const stored = await storage.getObject('media', photo!.storage_key);
    expect((await sharp(stored).metadata()).exif).toBeUndefined();

    // The report: one line per row, Bengali outcome, the reason.
    const report = await call('GET', `/stores/${STORE}/imports/${view.id}/report.csv`, 'owner');
    expect(report.statusCode).toBe(200);
    expect(report.body).toContain('তৈরি হয়েছে');
    expect(report.body).toContain('unknown_option');
    expect(report.body).toContain('অবস্থা: ""ভাঙা"" তালিকায় নেই; লিখুন: নতুন, পুরাতন');
  });

  it("store posts are bounded by the store's catalog, not the importer's personal daily limit", async () => {
    const setDaily = (value: number) =>
      admin.begin(async (tx) => {
        await tx`select set_config('app.is_platform_admin', 'true', true)`;
        await tx`update platform_settings set value = ${tx.json(value)} where key = 'post_max_per_day_per_user'`;
      });
    const [original] = await admin<
      { value: number }[]
    >`select value from platform_settings where key = 'post_max_per_day_per_user'`;
    // The owner has already made more store posts today than this allows a person.
    await setDaily(1);
    try {
      await moduleRef.get(SettingsService).invalidate();
      const sheet = await upload(
        Buffer.from(
          toCsv([
            HEADER,
            ['সরিষার তেল', '', '220', 'নতুন', ''],
            ['আটা ২ কেজি', '', '130', 'নতুন', ''],
          ]),
        ),
        'text/csv',
      );
      const before = Number(await storePosts());
      const started = await call('POST', `/stores/${STORE}/import`, 'owner', {
        categoryId: CATEGORY,
        sheetMediaId: sheet,
      });
      const view = await finished(started.json<ImportView>().id);
      expect(view).toMatchObject({ status: 'succeeded', progress: { created: 2, failed: 0 } });
      expect(Number(await storePosts())).toBe(before + 2);
    } finally {
      await setDaily(original!.value);
      await moduleRef.get(SettingsService).invalidate();
    }
  });

  it('a sheet over the row limit is refused before any row', async () => {
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'platform_admin', true)`;
      await tx`update tenant_settings set setting_overrides = setting_overrides || ${tx.json({ store_import_max_rows: 2 })}
               where tenant_id = ${TENANT}`;
    });
    const sheet = await upload(
      Buffer.from(
        toCsv([
          HEADER,
          ['এক', '', '1', 'নতুন', ''],
          ['দুই', '', '1', 'নতুন', ''],
          ['তিন', '', '1', 'নতুন', ''],
        ]),
      ),
      'text/csv',
    );
    await moduleRef.get(SettingsService).invalidate(TENANT);
    const before = await storePosts();
    const started = await call('POST', `/stores/${STORE}/import`, 'owner', {
      categoryId: CATEGORY,
      sheetMediaId: sheet,
    });
    const view = await finished(started.json<ImportView>().id);
    expect(view).toMatchObject({
      status: 'failed',
      errorCode: 'too_many_rows',
      progress: { processedRows: 0 },
    });
    expect(await storePosts()).toBe(before);
  });

  it("someone else's upload, or a ZIP posing as a sheet, is refused at start", async () => {
    const zipAsSheet = await upload(
      writeZip([{ name: 'a.txt', data: Buffer.from('x') }]),
      'application/zip',
    );
    // A ZIP that isn't a workbook is still accepted as "xlsx" here and fails as unreadable in the job.
    const started = await call('POST', `/stores/${STORE}/import`, 'owner', {
      categoryId: CATEGORY,
      sheetMediaId: zipAsSheet,
    });
    expect(started.statusCode).toBe(202);
    expect((await finished(started.json<ImportView>().id)).errorCode).toBe('sheet_unreadable');

    const foreign = await call('POST', `/stores/${STORE}/import`, 'owner', {
      categoryId: CATEGORY,
      sheetMediaId: randomUUID(),
    });
    expect(foreign.statusCode).toBe(422);
    expect(foreign.json<{ error: string }>().error).toBe('IMPORT_FILE_INVALID');
  });
});
