import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { UnauthenticatedException } from '../../auth/exceptions/auth.exceptions';
import { parseFieldSchema, parseUiSchema } from '../../categories/field-schema';
import { toCsv } from '../../common/files/csv';
import { writeXlsx } from '../../common/files/xlsx';
import type { DatabaseTransaction } from '../../database/database.client';
import { TenantContext } from '../../database/tenant-context';
import { TenantDb } from '../../database/tenant-db';
import { PostOwnershipService } from '../../posts/post-ownership.service';
import { PostsRepository } from '../../posts/posts.repository';
import { JOB_RUN_STORE_IMPORT, QUEUE_IMPORTS, type StoreImportJob } from '../../queue/queue.types';
import { SettingsService } from '../../settings/settings.service';
import {
  StoreMembershipRequiredException,
  StoreNotActiveException,
  StoreNotFoundException,
} from '../stores.exceptions';
import type {
  ImportList,
  ImportTemplateQuery,
  ImportView,
  StartImportInput,
} from './dto/store-import.dto';
import { exampleValue, importColumns } from './import-columns';
import { IMPORT_TEXT } from './import.templates';
import {
  ImportCategoryUnavailableException,
  ImportFileInvalidException,
  ImportNotFoundException,
} from './store-import.exceptions';
import { StoreImportRepository, type ImportRow, type ResultRow } from './store-import.repository';

// settings-exempt: how many recent imports GET /stores/:id/imports lists (a page of history, not a business limit)
const RECENT_IMPORTS = 20;

export interface TemplateFile {
  filename: string;
  contentType: string;
  body: Buffer;
}

/**
 * Bulk upload into a store (ADR 056), the HTTP side: the template, starting
 * an import (queued for the worker's StoreImportRunner), progress and the
 * row-level report. Whoever may post as the store may import into it
 * (member_may_post_as_store, the one rule); its owner and managers also see
 * everyone's imports.
 */
@Injectable()
export class StoreImportService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: StoreImportRepository,
    private readonly posts: PostsRepository,
    private readonly ownership: PostOwnershipService,
    private readonly settings: SettingsService,
    @InjectQueue(QUEUE_IMPORTS) private readonly queue: Queue<StoreImportJob>,
  ) {}

  /** The category's template: Bengali headers, an example row, one column per photo. */
  async template(storeId: string, query: ImportTemplateQuery): Promise<TemplateFile> {
    const { tenantId } = await this.asPoster(storeId);
    const maxImages = await this.settings.get('post_max_media', tenantId);
    const form = await this.inStore(tenantId, (tx) => this.repo.categoryForm(tx, query.categoryId));
    if (!form) throw new ImportCategoryUnavailableException();
    const ui = parseUiSchema(form.ui_schema);
    const columns = importColumns(parseFieldSchema(form.json_schema), ui, maxImages);
    const example = columns.map((column) => {
      switch (column.kind) {
        case 'title':
          return IMPORT_TEXT.exampleTitle;
        case 'description':
          return IMPORT_TEXT.exampleDescription;
        case 'field':
          return exampleValue(column, ui);
        case 'image':
          return column.index === 0 ? IMPORT_TEXT.exampleImageUrl : '';
      }
    });
    const rows = [columns.map((c) => c.header), example];
    const filename = `import-${form.slug}.${query.format}`;
    return query.format === 'csv'
      ? { filename, contentType: 'text/csv; charset=utf-8', body: Buffer.from(toCsv(rows), 'utf8') }
      : {
          filename,
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          body: writeXlsx(IMPORT_TEXT.sheetName, rows),
        };
  }

  async start(storeId: string, input: StartImportInput): Promise<ImportView> {
    const { tenantId } = await this.asPoster(storeId);
    const importId = await this.ownership.inTenant(tenantId, 'lookup', ({ memberId }) =>
      this.tenantDb.transaction(async (tx) => {
        if (!(await this.repo.categoryForm(tx, input.categoryId)))
          throw new ImportCategoryUnavailableException();
        const sheet = await this.repo.importFile(tx, input.sheetMediaId);
        if (!sheet) throw new ImportFileInvalidException('sheet', 'not_found');
        if (sheet.status_code !== 'ready')
          throw new ImportFileInvalidException('sheet', 'not_ready');
        // What the bytes are, not what the client said (the pipeline sniffed them):
        // an XLSX workbook is a ZIP container, a CSV is text.
        const sheetFormat =
          sheet.mime_type === 'application/zip'
            ? 'xlsx'
            : sheet.mime_type === 'text/csv'
              ? 'csv'
              : undefined;
        if (!sheetFormat) throw new ImportFileInvalidException('sheet', 'wrong_type');
        if (input.imagesMediaId) {
          const zip = await this.repo.importFile(tx, input.imagesMediaId);
          if (!zip) throw new ImportFileInvalidException('images', 'not_found');
          if (zip.status_code !== 'ready')
            throw new ImportFileInvalidException('images', 'not_ready');
          if (zip.mime_type !== 'application/zip')
            throw new ImportFileInvalidException('images', 'wrong_type');
        }
        return this.repo.insert(tx, {
          storeId,
          categoryId: input.categoryId,
          memberId: memberId!,
          sheetMediaId: input.sheetMediaId,
          imagesMediaId: input.imagesMediaId ?? null,
          sheetFormat,
          dryRun: input.dryRun,
        });
      }),
    );
    await this.queue.add(
      JOB_RUN_STORE_IMPORT,
      { tenantId, importId },
      // One job per import, however often it is asked for.
      { jobId: `${JOB_RUN_STORE_IMPORT}-${importId}` },
    );
    return this.get(storeId, importId, false);
  }

  async get(storeId: string, importId: string, withRows = true): Promise<ImportView> {
    const tenantId = await this.storeTenant(storeId);
    const found = await this.inStore(tenantId, async (tx) => {
      const row = await this.repo.find(tx, importId);
      if (!row || row.store_id !== storeId) return undefined;
      return { row, results: withRows ? await this.repo.results(tx, importId) : undefined };
    });
    if (!found) throw new ImportNotFoundException();
    return this.toView(found.row, found.results);
  }

  async list(storeId: string): Promise<ImportList> {
    const tenantId = await this.storeTenant(storeId);
    const rows = await this.inStore(tenantId, (tx) => this.repo.list(tx, storeId, RECENT_IMPORTS));
    return { items: rows.map((row) => this.toView(row, undefined)) };
  }

  /** The row-level report: one line per sheet row, Bengali outcome and reason, CSV-injection safe. */
  async report(storeId: string, importId: string): Promise<{ filename: string; body: Buffer }> {
    const view = await this.get(storeId, importId);
    const rows = [
      [...IMPORT_TEXT.reportHeader],
      ...(view.rows ?? []).map((r) => [
        r.row,
        IMPORT_TEXT.outcome[r.outcome],
        r.reasonCode,
        r.reason,
        r.postId,
      ]),
    ];
    return { filename: `import-report-${importId}.csv`, body: Buffer.from(toCsv(rows), 'utf8') };
  }

  private toView(row: ImportRow, results: ResultRow[] | undefined): ImportView {
    return {
      id: row.id,
      storeId: row.store_id,
      categoryId: row.category_id,
      sheetFormat: row.sheet_format,
      dryRun: row.dry_run,
      status: row.status_code,
      errorCode: row.error_code,
      progress: {
        totalRows: row.total_rows,
        processedRows: row.processed_rows,
        created: row.created_count,
        skipped: row.skipped_count,
        failed: row.failed_count,
      },
      createdAt: row.created_at.toISOString(),
      startedAt: row.started_at?.toISOString() ?? null,
      finishedAt: row.finished_at?.toISOString() ?? null,
      reportUrl: `/api/v1/stores/${row.store_id}/imports/${row.id}/report.csv`,
      ...(results
        ? {
            rows: results.map((r) => ({
              row: r.row_number,
              outcome: r.outcome,
              reasonCode: r.reason_code,
              reason: r.reason,
              postId: r.post_id,
            })),
          }
        : {}),
    };
  }

  /** The caller may post as this active store (member_may_post_as_store): its tenant. */
  private async asPoster(storeId: string): Promise<{ tenantId: string }> {
    const tenantId = await this.storeTenant(storeId);
    const facts = await this.inStore(tenantId, (tx) => this.posts.storePostingFacts(tx, storeId));
    if (!facts) throw new StoreNotFoundException();
    if (!facts.mayPost) throw new StoreMembershipRequiredException();
    if (facts.status !== 'active') throw new StoreNotActiveException(facts.status);
    return { tenantId };
  }

  private async storeTenant(storeId: string): Promise<string> {
    if (!this.context.require().userId) throw new UnauthenticatedException();
    const tenantId = await this.tenantDb.transaction(
      async (tx) => {
        const rows = await tx.execute(
          sql`select public.item_tenant_of('store', ${storeId}::uuid) as tenant_id`,
        );
        return (
          z.array(z.object({ tenant_id: z.string().nullable() })).parse([...rows])[0]?.tenant_id ??
          null
        );
      },
      { accessMode: 'read only' },
    );
    if (!tenantId) throw new StoreNotFoundException();
    return tenantId;
  }

  private inStore<T>(tenantId: string, work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.ownership.inTenant(tenantId, 'lookup', () =>
      this.tenantDb.transaction(work, { accessMode: 'read only' }),
    );
  }
}
