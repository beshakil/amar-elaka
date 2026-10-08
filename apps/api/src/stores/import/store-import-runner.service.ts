import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { parseFieldSchema, parseUiSchema, type UiSchema } from '../../categories/field-schema';
import { DomainException } from '../../common/exceptions/domain-exception';
import { parseCsv } from '../../common/files/csv';
import { readXlsxFirstSheet, XlsxFormatError } from '../../common/files/xlsx';
import { readZip, ZipFormatError, ZipLimitError, type ZipEntry } from '../../common/files/zip';
import type { AppRole } from '../../database/tenant-context';
import { TenantContext } from '../../database/tenant-context';
import { TenantDb } from '../../database/tenant-db';
import { sniffImageType } from '../../media/image-signature';
import { MediaProcessingService } from '../../media/media-processing.service';
import { PostsService } from '../../posts/posts.service';
import { SettingsService } from '../../settings/settings.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/storage.ports';
import {
  CellError,
  importColumns,
  matchHeaders,
  parseRow,
  type ImportColumn,
  type ParsedRow,
} from './import-columns';
import { IMPORT_TEXT } from './import.templates';
import { checkImageUrl, fetchImage, ImageSourceError } from './image-source';
import { StoreImportRepository, type ImportRow, type RowOutcome } from './store-import.repository';

/** A whole-import failure: nothing is attempted (too many rows, unreadable file…). */
class ImportAbort extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

class RowFailure extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
  ) {
    super(message);
  }
}

interface RowResult {
  outcome: RowOutcome;
  reasonCode: string | null;
  reason: string | null;
  postId: string | null;
}

/** Sheet rows → header row and data rows (numbered as the spreadsheet numbers them). */
export function splitSheet(rows: readonly string[][]): {
  header: string[];
  data: { number: number; cells: string[] }[];
} {
  const isBlank = (r: readonly string[]) => r.every((c) => c.trim() === '');
  const headerIndex = rows.findIndex((r) => !isBlank(r));
  if (headerIndex < 0) return { header: [], data: [] };
  let last = rows.length - 1;
  while (last > headerIndex && isBlank(rows[last]!)) last--;
  return {
    header: rows[headerIndex]!,
    // settings-exempt: spreadsheets number rows from 1, and the data starts below the header row
    data: rows
      .slice(headerIndex + 1, last + 1)
      .map((cells, i) => ({ number: headerIndex + 2 + i, cells })),
  };
}

/**
 * The run-store-import job (ADR 056). Reads the sheet (CSV or XLSX, by its
 * bytes) and the optional image ZIP; refuses the whole import only for what
 * makes every row meaningless (unreadable file, too many rows, no title
 * column). Each row then stands alone: parsed through the template columns,
 * validated by the category's own validator, its images run through the
 * normal media pipeline, and the post made by PostsService.create as the
 * importing member — so moderation, trust, limits and posting-as-store all
 * apply exactly as in the app. A row that fails is recorded with its reason
 * and the import goes on. Dry run: the same checks (PostsService
 * .validateCreate), nothing written but the report. A retried job skips the
 * rows it already recorded, and create's idempotency key makes a row that
 * crashed mid-way safe to redo.
 */
@Injectable()
export class StoreImportRunner {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: StoreImportRepository,
    private readonly posts: PostsService,
    private readonly media: MediaProcessingService,
    private readonly settings: SettingsService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(StoreImportRunner.name);
  }

  async run(tenantId: string, importId: string): Promise<void> {
    const system = <T>(work: () => Promise<T>) =>
      this.context.run({ tenantId, role: 'system' }, work);
    const job = await system(() =>
      this.tenantDb.transaction(async (tx) => {
        const row = await this.repo.find(tx, importId);
        if (!row || !(await this.repo.start(tx, importId))) return undefined;
        const importer = await this.repo.importer(tx, row.created_by_member_id);
        return importer ? { row, importer } : undefined;
      }),
    );
    if (!job) return;
    const asImporter = <T>(work: () => Promise<T>) =>
      this.context.run(
        {
          tenantId,
          userId: job.importer.user_id,
          memberId: job.row.created_by_member_id,
          role: job.importer.role_code as AppRole,
        },
        work,
      );

    try {
      await this.process(job.row, system, asImporter);
      await system(() =>
        this.tenantDb.transaction((tx) => this.repo.finish(tx, importId, 'succeeded', null)),
      );
    } catch (error) {
      const code = error instanceof ImportAbort ? error.code : 'internal_error';
      if (!(error instanceof ImportAbort))
        this.logger.error({ err: error, importId }, 'store import failed');
      await system(() =>
        this.tenantDb.transaction((tx) => this.repo.finish(tx, importId, 'failed', code)),
      );
    }
  }

  private async process(
    job: ImportRow,
    system: <T>(work: () => Promise<T>) => Promise<T>,
    asImporter: <T>(work: () => Promise<T>) => Promise<T>,
  ): Promise<void> {
    const [maxRows, maxEntries, maxUnpacked, maxImages] = await Promise.all([
      this.settings.get('store_import_max_rows', job.tenant_id),
      this.settings.get('store_import_zip_max_entries', job.tenant_id),
      this.settings.get('store_import_zip_max_unpacked_bytes', job.tenant_id),
      this.settings.get('post_max_media', job.tenant_id),
    ]);
    const limits = { maxEntries, maxUnpackedBytes: maxUnpacked };

    const files = await asImporter(() =>
      this.tenantDb.transaction(
        async (tx) => ({
          sheet: job.sheet_media_id
            ? await this.repo.importFile(tx, job.sheet_media_id)
            : undefined,
          images: job.images_media_id
            ? await this.repo.importFile(tx, job.images_media_id)
            : undefined,
          form: await this.repo.categoryForm(tx, job.category_id),
          store: await this.repo.store(tx, job.store_id),
          titles: await this.repo.storeTitles(tx, job.store_id),
        }),
        { accessMode: 'read only' },
      ),
    );
    if (!files.sheet) throw new ImportAbort('sheet_missing');
    if (!files.form) throw new ImportAbort('category_unavailable');
    if (!files.store || files.store.lat === null || files.store.lng === null)
      throw new ImportAbort('store_has_no_location');
    if (job.images_media_id && !files.images) throw new ImportAbort('images_missing');

    const sheetBytes = await this.storage.getObject('documents', files.sheet.storage_key);
    let rows: string[][];
    try {
      rows =
        job.sheet_format === 'xlsx'
          ? readXlsxFirstSheet(sheetBytes, limits)
          : parseCsv(new TextDecoder('utf-8', { fatal: true }).decode(sheetBytes));
    } catch (error) {
      if (
        error instanceof XlsxFormatError ||
        error instanceof ZipFormatError ||
        error instanceof TypeError
      ) {
        throw new ImportAbort('sheet_unreadable');
      }
      if (error instanceof ZipLimitError) throw new ImportAbort('sheet_too_large');
      throw error;
    }
    const { header, data } = splitSheet(rows);
    if (data.length > maxRows) throw new ImportAbort('too_many_rows');

    const ui = parseUiSchema(files.form.ui_schema);
    const columns = importColumns(parseFieldSchema(files.form.json_schema), ui, maxImages);
    const matched = matchHeaders(header, columns);
    if (!matched.some((c) => c?.kind === 'title')) throw new ImportAbort('no_title_column');

    let zip: Map<string, ZipEntry> | undefined;
    if (files.images) {
      try {
        const entries = readZip(
          await this.storage.getObject('documents', files.images.storage_key),
          limits,
        );
        zip = new Map(
          entries
            .filter((e) => !e.name.startsWith('__MACOSX/'))
            .map((e) => [basename(e.name).normalize('NFC').toLowerCase(), e]),
        );
      } catch (error) {
        if (error instanceof ZipLimitError) throw new ImportAbort('zip_too_large');
        if (error instanceof ZipFormatError) throw new ImportAbort('zip_unreadable');
        throw error;
      }
    }

    await system(() =>
      this.tenantDb.transaction((tx) => this.repo.setTotal(tx, job.id, data.length)),
    );
    const done = await system(() =>
      this.tenantDb.transaction((tx) => this.repo.recordedRows(tx, job.id), {
        accessMode: 'read only',
      }),
    );
    const seenTitles = new Set(files.titles);
    const store = { ...files.store, lat: files.store.lat, lng: files.store.lng };

    for (const { number, cells } of data) {
      if (done.has(number)) continue;
      const result = await this.row(
        job,
        number,
        cells,
        matched,
        ui,
        { zip, maxImages, seenTitles, store },
        asImporter,
      );
      await system(() =>
        this.tenantDb.transaction((tx) =>
          this.repo.record(tx, job.id, { rowNumber: number, ...result }),
        ),
      );
    }
  }

  private async row(
    job: ImportRow,
    rowNumber: number,
    cells: readonly string[],
    matched: readonly (ImportColumn | undefined)[],
    ui: UiSchema,
    env: {
      zip: Map<string, ZipEntry> | undefined;
      maxImages: number;
      seenTitles: Set<string>;
      store: { lat: number; lng: number; phone_e164: string | null; whatsapp_e164: string | null };
    },
    asImporter: <T>(work: () => Promise<T>) => Promise<T>,
  ): Promise<RowResult> {
    const skip = (reasonCode: string, reason: string): RowResult => ({
      outcome: 'skipped',
      reasonCode,
      reason,
      postId: null,
    });
    const fail = (reasonCode: string, reason: string): RowResult => ({
      outcome: 'failed',
      reasonCode,
      reason,
      postId: null,
    });

    if (cells.every((c) => c.trim() === '')) return skip('blank_row', IMPORT_TEXT.blankRow);
    let parsed: ParsedRow;
    try {
      parsed = parseRow(cells, matched, ui);
    } catch (error) {
      if (error instanceof CellError) return fail(error.reasonCode, error.message);
      throw error;
    }
    const titleKey = parsed.title.trim().toLowerCase();
    if (env.seenTitles.has(titleKey)) return skip('duplicate_title', IMPORT_TEXT.duplicateTitle);
    if (parsed.images.length > env.maxImages)
      return fail('too_many_images', IMPORT_TEXT.tooManyImages(env.maxImages));

    const input = {
      categoryId: job.category_id,
      title: parsed.title,
      ...(parsed.description !== undefined ? { description: parsed.description } : {}),
      fields: parsed.fields,
      location: { lat: env.store.lat, lng: env.store.lng },
      mediaIds: [] as string[],
      storeId: job.store_id,
      ...(env.store.phone_e164 ? { contactPhone: env.store.phone_e164 } : {}),
      showWhatsapp: env.store.whatsapp_e164 !== null,
      submit: true,
    };

    try {
      if (job.dry_run) {
        for (const image of parsed.images) await this.checkImage(image, env.zip);
        await asImporter(() => this.posts.validateCreate(input));
        env.seenTitles.add(titleKey);
        return { outcome: 'valid', reasonCode: null, reason: null, postId: null };
      }
      const mediaIds: string[] = [];
      for (const image of parsed.images) {
        mediaIds.push(await this.storeImage(job.tenant_id, image, env.zip, asImporter));
      }
      const created = await asImporter(() =>
        // One key per import row: a row redone after a crash finds its post instead of making a second.
        this.posts.create({ ...input, mediaIds }, `import-${job.id}-${rowNumber}`),
      );
      env.seenTitles.add(titleKey);
      return { outcome: 'created', reasonCode: null, reason: null, postId: created.post.id };
    } catch (error) {
      if (error instanceof RowFailure) return fail(error.reasonCode, error.message);
      if (error instanceof ImageSourceError) return fail(error.reasonCode, this.imageReason(error));
      if (error instanceof DomainException) return fail(error.code.toLowerCase(), error.message);
      this.logger.error({ err: error, importId: job.id }, 'store import row failed');
      return fail('internal_error', 'internal_error');
    }
  }

  private imageReason(error: ImageSourceError): string {
    switch (error.reasonCode) {
      case 'image_url_invalid':
        return IMPORT_TEXT.imageUrlInvalid(error.message);
      case 'image_url_blocked':
        return IMPORT_TEXT.imageUrlBlocked(error.message);
      case 'image_too_large':
        return IMPORT_TEXT.imageTooLarge(error.message);
      case 'image_fetch_failed':
        return IMPORT_TEXT.imageFetchFailed(error.message);
    }
  }

  private isUrl(reference: string): boolean {
    return /^https?:\/\//i.test(reference.trim());
  }

  private zipEntry(reference: string, zip: Map<string, ZipEntry> | undefined): ZipEntry {
    const name = basename(reference.trim()).normalize('NFC').toLowerCase();
    if (!zip) throw new RowFailure('image_no_zip', IMPORT_TEXT.imageNoZip(reference));
    const entry = zip.get(name);
    if (!entry)
      throw new RowFailure('image_missing_in_zip', IMPORT_TEXT.imageMissingInZip(reference));
    return entry;
  }

  /** A dry run's image check: the ZIP has it and it is an image; a URL is well-formed and public. */
  private async checkImage(
    reference: string,
    zip: Map<string, ZipEntry> | undefined,
  ): Promise<void> {
    if (this.isUrl(reference)) {
      await checkImageUrl(reference);
      return;
    }
    const entry = this.zipEntry(reference, zip);
    if (!sniffImageType(entry.read()))
      throw new RowFailure('image_rejected', IMPORT_TEXT.imageRejected(reference));
  }

  /** The image's bytes as a new media asset of the importer, processed by the media pipeline. */
  private async storeImage(
    tenantId: string,
    reference: string,
    zip: Map<string, ZipEntry> | undefined,
    asImporter: <T>(work: () => Promise<T>) => Promise<T>,
  ): Promise<string> {
    const [maxBytes, timeoutMs, attempts] = await Promise.all([
      this.settings.get('media_max_upload_bytes', tenantId),
      this.settings.get('store_import_image_fetch_timeout_ms'),
      this.settings.get('store_import_image_fetch_attempts'),
    ]);
    const bytes = this.isUrl(reference)
      ? await fetchImage(reference, { timeoutMs, attempts, maxBytes })
      : this.zipEntry(reference, zip).read();
    if (bytes.length > maxBytes)
      throw new RowFailure('image_too_large', IMPORT_TEXT.imageTooLarge(reference));
    const type = sniffImageType(bytes);
    if (!type) throw new RowFailure('image_rejected', IMPORT_TEXT.imageRejected(reference));

    const storageKey = `${tenantId}/image/${randomUUID()}`;
    await this.storage.putObject('media', storageKey, bytes, type);
    const mediaId = await asImporter(() =>
      this.tenantDb.transaction((tx) =>
        this.repo.insertImage(tx, {
          storageKey,
          mimeType: type,
          byteSize: bytes.length,
          checksum: createHash('sha256').update(bytes).digest('hex'),
        }),
      ),
    );
    // The same pipeline as an upload from the app: magic bytes, decode limits,
    // EXIF stripped, WebP variants. Anything it rejects fails the row.
    if ((await this.media.process(tenantId, mediaId)) !== 'ready') {
      throw new RowFailure('image_rejected', IMPORT_TEXT.imageRejected(reference));
    }
    return mediaId;
  }
}
