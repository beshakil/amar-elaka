import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { POSTABLE_KINDS } from '../../categories/categories.types';
import type { DatabaseTransaction } from '../../database/database.client';

export const IMPORT_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export const ROW_OUTCOMES = ['created', 'valid', 'skipped', 'failed'] as const;
export type RowOutcome = (typeof ROW_OUTCOMES)[number];

const IMPORT_ROW = z.object({
  id: z.string(),
  tenant_id: z.string(),
  store_id: z.string(),
  category_id: z.string(),
  created_by_member_id: z.string(),
  sheet_media_id: z.string().nullable(),
  images_media_id: z.string().nullable(),
  sheet_format: z.enum(['csv', 'xlsx']),
  dry_run: z.boolean(),
  status_code: z.enum(IMPORT_STATUSES),
  error_code: z.string().nullable(),
  total_rows: z.number().nullable(),
  processed_rows: z.number(),
  created_count: z.number(),
  skipped_count: z.number(),
  failed_count: z.number(),
  started_at: z.coerce.date().nullable(),
  finished_at: z.coerce.date().nullable(),
  created_at: z.coerce.date(),
});
export type ImportRow = z.infer<typeof IMPORT_ROW>;

const IMPORT_COLUMNS = sql`
  i.id, i.tenant_id, i.store_id, i.category_id, i.created_by_member_id, i.sheet_media_id, i.images_media_id,
  i.sheet_format, i.dry_run, i.status_code, i.error_code, i.total_rows, i.processed_rows, i.created_count,
  i.skipped_count, i.failed_count, i.started_at, i.finished_at, i.created_at`;

const RESULT_ROW = z.object({
  row_number: z.number(),
  outcome: z.enum(ROW_OUTCOMES),
  reason_code: z.string().nullable(),
  reason: z.string().nullable(),
  post_id: z.string().nullable(),
});
export type ResultRow = z.infer<typeof RESULT_ROW>;

/** store_imports / store_import_rows (0052) and the bits of other tables an import reads. */
@Injectable()
export class StoreImportRepository {
  /** The category's published form, if it's a postable category enabled in this tenant. */
  async categoryForm(
    tx: DatabaseTransaction,
    categoryId: string,
  ): Promise<{ slug: string; json_schema: unknown; ui_schema: unknown } | undefined> {
    const rows = await tx.execute(sql`
      select c.slug, s.json_schema, s.ui_schema
      from public.categories c
      join public.tenant_categories tc on tc.category_id = c.id and tc.tenant_id = public.current_tenant_id()
      join public.category_field_schemas s on s.category_id = c.id and s.status_code = 'published'
      where c.id = ${categoryId}::uuid and c.is_active and c.deleted_at is null and tc.is_enabled
        and c.kind_code = any(${`{${[...POSTABLE_KINDS].join(',')}}`}::text[])`);
    const row = z
      .array(z.object({ slug: z.string(), json_schema: z.unknown(), ui_schema: z.unknown() }))
      .max(1)
      .parse([...rows])[0];
    return row
      ? { slug: row.slug, json_schema: row.json_schema, ui_schema: row.ui_schema }
      : undefined;
  }

  /** The caller's own confirmed import file (kind import), with what it really is. */
  async importFile(
    tx: DatabaseTransaction,
    mediaId: string,
  ): Promise<{ storage_key: string; mime_type: string; status_code: string } | undefined> {
    const rows = await tx.execute(sql`
      select m.storage_key, m.mime_type, m.status_code
      from public.media_assets m
      where m.id = ${mediaId}::uuid and m.tenant_id = public.current_tenant_id()
        and m.uploaded_by_user_id = public.current_user_id()
        and m.kind_code = 'import' and m.deleted_at is null`);
    return z
      .array(z.object({ storage_key: z.string(), mime_type: z.string(), status_code: z.string() }))
      .max(1)
      .parse([...rows])[0];
  }

  /** The store's pin location and numbers, for the posts an import makes. */
  async store(
    tx: DatabaseTransaction,
    storeId: string,
  ): Promise<
    | {
        slug: string;
        status_code: string;
        lat: number | null;
        lng: number | null;
        phone_e164: string | null;
        whatsapp_e164: string | null;
      }
    | undefined
  > {
    const rows = await tx.execute(sql`
      select s.slug, s.status_code,
             st_y(coalesce(s.location, pl.location)::geometry) as lat,
             st_x(coalesce(s.location, pl.location)::geometry) as lng,
             s.phone_e164, s.whatsapp_e164
      from public.stores s
      left join public.places pl on pl.tenant_id = s.tenant_id and pl.id = s.place_id
      where s.id = ${storeId}::uuid and s.tenant_id = public.current_tenant_id() and s.deleted_at is null`);
    return z
      .array(
        z.object({
          slug: z.string(),
          status_code: z.string(),
          lat: z.number().nullable(),
          lng: z.number().nullable(),
          phone_e164: z.string().nullable(),
          whatsapp_e164: z.string().nullable(),
        }),
      )
      .max(1)
      .parse([...rows])[0];
  }

  /** Titles the store already has (any post the caller can see, not deleted), lower-cased. */
  async storeTitles(tx: DatabaseTransaction, storeId: string): Promise<Set<string>> {
    const rows = await tx.execute(sql`
      select lower(btrim(p.title)) as title from public.posts p
      where p.tenant_id = public.current_tenant_id() and p.store_id = ${storeId}::uuid and p.deleted_at is null`);
    return new Set(
      z
        .array(z.object({ title: z.string() }))
        .parse([...rows])
        .map((r) => r.title),
    );
  }

  async insert(
    tx: DatabaseTransaction,
    values: {
      storeId: string;
      categoryId: string;
      memberId: string;
      sheetMediaId: string;
      imagesMediaId: string | null;
      sheetFormat: 'csv' | 'xlsx';
      dryRun: boolean;
    },
  ): Promise<string> {
    const rows = await tx.execute(sql`
      insert into public.store_imports
        (store_id, category_id, created_by_member_id, sheet_media_id, images_media_id, sheet_format, dry_run)
      values (${values.storeId}::uuid, ${values.categoryId}::uuid, ${values.memberId}::uuid,
              ${values.sheetMediaId}::uuid, ${values.imagesMediaId}::uuid, ${values.sheetFormat}, ${values.dryRun})
      returning id`);
    return z
      .array(z.object({ id: z.string() }))
      .length(1)
      .parse([...rows])[0]!.id;
  }

  async find(tx: DatabaseTransaction, importId: string): Promise<ImportRow | undefined> {
    const rows = await tx.execute(sql`
      select ${IMPORT_COLUMNS} from public.store_imports i
      where i.id = ${importId}::uuid and i.tenant_id = public.current_tenant_id()`);
    return z
      .array(IMPORT_ROW)
      .max(1)
      .parse([...rows])[0];
  }

  async list(tx: DatabaseTransaction, storeId: string, limit: number): Promise<ImportRow[]> {
    const rows = await tx.execute(sql`
      select ${IMPORT_COLUMNS} from public.store_imports i
      where i.tenant_id = public.current_tenant_id() and i.store_id = ${storeId}::uuid
      order by i.id desc limit ${limit}`);
    return z.array(IMPORT_ROW).parse([...rows]);
  }

  async results(tx: DatabaseTransaction, importId: string): Promise<ResultRow[]> {
    const rows = await tx.execute(sql`
      select row_number, outcome, reason_code, reason, post_id from public.store_import_rows
      where tenant_id = public.current_tenant_id() and import_id = ${importId}::uuid
      order by row_number`);
    return z.array(RESULT_ROW).parse([...rows]);
  }

  // ---- the worker (system role) ---------------------------------------------------

  /** The importer, as the import job runs: their user and role in the tenant. */
  /** The store's name, for the "upload finished" notification. */
  async storeName(tx: DatabaseTransaction, storeId: string): Promise<string | null> {
    const rows = await tx.execute(
      sql`select name_bn from public.stores where id = ${storeId}::uuid`,
    );
    return (
      z
        .array(z.object({ name_bn: z.string() }))
        .max(1)
        .parse([...rows])[0]?.name_bn ?? null
    );
  }

  async importer(
    tx: DatabaseTransaction,
    memberId: string,
  ): Promise<{ user_id: string; role_code: string } | undefined> {
    const rows = await tx.execute(sql`
      select tm.user_id, tm.role_code from public.tenant_members tm
      where tm.tenant_id = public.current_tenant_id() and tm.id = ${memberId}::uuid`);
    return z
      .array(z.object({ user_id: z.string(), role_code: z.string() }))
      .max(1)
      .parse([...rows])[0];
  }

  /** queued → running (false when it already finished: a retried job does nothing). */
  async start(tx: DatabaseTransaction, importId: string): Promise<boolean> {
    const rows = await tx.execute(sql`
      update public.store_imports set status_code = 'running', started_at = coalesce(started_at, now())
      where id = ${importId}::uuid and tenant_id = public.current_tenant_id() and status_code in ('queued', 'running')
      returning id`);
    return rows.length === 1;
  }

  async setTotal(tx: DatabaseTransaction, importId: string, total: number): Promise<void> {
    await tx.execute(sql`
      update public.store_imports set total_rows = ${total}
      where id = ${importId}::uuid and tenant_id = public.current_tenant_id()`);
  }

  /** One row's outcome, and the import's counts from its rows (idempotent: a re-run row replaces itself). */
  async record(
    tx: DatabaseTransaction,
    importId: string,
    row: {
      rowNumber: number;
      outcome: RowOutcome;
      reasonCode: string | null;
      reason: string | null;
      postId: string | null;
    },
  ): Promise<void> {
    await tx.execute(sql`
      insert into public.store_import_rows (import_id, row_number, outcome, reason_code, reason, post_id)
      values (${importId}::uuid, ${row.rowNumber}, ${row.outcome}, ${row.reasonCode}, ${row.reason}, ${row.postId}::uuid)
      on conflict (tenant_id, import_id, row_number)
      do update set outcome = excluded.outcome, reason_code = excluded.reason_code,
                    reason = excluded.reason, post_id = excluded.post_id`);
    await tx.execute(sql`
      update public.store_imports i set
        processed_rows = c.processed, created_count = c.created, skipped_count = c.skipped, failed_count = c.failed
      from (
        select count(*)::int as processed,
               count(*) filter (where outcome in ('created', 'valid'))::int as created,
               count(*) filter (where outcome = 'skipped')::int as skipped,
               count(*) filter (where outcome = 'failed')::int as failed
        from public.store_import_rows
        where tenant_id = public.current_tenant_id() and import_id = ${importId}::uuid
      ) c
      where i.id = ${importId}::uuid and i.tenant_id = public.current_tenant_id()`);
  }

  async recordedRows(tx: DatabaseTransaction, importId: string): Promise<Set<number>> {
    const rows = await tx.execute(sql`
      select row_number from public.store_import_rows
      where tenant_id = public.current_tenant_id() and import_id = ${importId}::uuid`);
    return new Set(
      z
        .array(z.object({ row_number: z.number() }))
        .parse([...rows])
        .map((r) => r.row_number),
    );
  }

  async finish(
    tx: DatabaseTransaction,
    importId: string,
    status: 'succeeded' | 'failed',
    errorCode: string | null,
  ): Promise<void> {
    await tx.execute(sql`
      update public.store_imports set status_code = ${status}, error_code = ${errorCode}, finished_at = now()
      where id = ${importId}::uuid and tenant_id = public.current_tenant_id()`);
  }

  // ---- images (the importer's context) ----------------------------------------------

  /** A new image asset owned by the importer; the media pipeline takes it from here. */
  async insertImage(
    tx: DatabaseTransaction,
    values: { storageKey: string; mimeType: string; byteSize: number; checksum: string },
  ): Promise<string> {
    const rows = await tx.execute(sql`
      insert into public.media_assets
        (uploaded_by_user_id, kind_code, visibility_code, storage_key, mime_type, byte_size, checksum_sha256)
      values (public.current_user_id(), 'image', 'public', ${values.storageKey}, ${values.mimeType},
              ${values.byteSize}, ${values.checksum})
      returning id`);
    return z
      .array(z.object({ id: z.string() }))
      .length(1)
      .parse([...rows])[0]!.id;
  }
}
