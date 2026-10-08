import { z } from 'zod';
import { createZodDto } from '../../../common/pipes/zod-dto';
import { IMPORT_STATUSES, ROW_OUTCOMES } from '../store-import.repository';

export const importTemplateQuerySchema = z
  .object({
    categoryId: z.string().uuid(),
    format: z.enum(['csv', 'xlsx']).default('xlsx'),
  })
  .strict();
export type ImportTemplateQuery = z.infer<typeof importTemplateQuerySchema>;
export class ImportTemplateQueryDto extends createZodDto(importTemplateQuerySchema) {}

export const startImportSchema = z
  .object({
    categoryId: z.string().uuid(),
    /** A confirmed upload of kind `import` (POST /media/presign + confirm): the CSV or XLSX sheet. */
    sheetMediaId: z.string().uuid(),
    /** Optional: a confirmed `import` ZIP whose file names the sheet's photo cells name. */
    imagesMediaId: z.string().uuid().optional(),
    /** Validate every row as a real import would, create nothing. */
    dryRun: z.boolean().default(false),
  })
  .strict();
export type StartImportInput = z.infer<typeof startImportSchema>;
export class StartImportDto extends createZodDto(startImportSchema) {}

export const importParamSchema = z
  .object({ id: z.string().uuid(), importId: z.string().uuid() })
  .strict();
export class ImportParamDto extends createZodDto(importParamSchema) {}

export const importViewSchema = z.object({
  id: z.string(),
  storeId: z.string(),
  categoryId: z.string(),
  sheetFormat: z.enum(['csv', 'xlsx']),
  dryRun: z.boolean(),
  status: z.enum(IMPORT_STATUSES),
  /** Why the whole import stopped (too_many_rows, sheet_unreadable, no_title_column…); null otherwise. */
  errorCode: z.string().nullable(),
  progress: z.object({
    totalRows: z.number().nullable(),
    processedRows: z.number(),
    /** created (or, in a dry run, valid) / skipped / failed. */
    created: z.number(),
    skipped: z.number(),
    failed: z.number(),
  }),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** The row-level report as CSV. */
  reportUrl: z.string(),
  rows: z
    .array(
      z.object({
        row: z.number(),
        outcome: z.enum(ROW_OUTCOMES),
        reasonCode: z.string().nullable(),
        reason: z.string().nullable(),
        postId: z.string().nullable(),
      }),
    )
    .optional(),
});
export type ImportView = z.infer<typeof importViewSchema>;
export class ImportViewDto extends createZodDto(importViewSchema) {}

export const importListSchema = z.object({ items: z.array(importViewSchema) });
export type ImportList = z.infer<typeof importListSchema>;
export class ImportListDto extends createZodDto(importListSchema) {}
