import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';
import { SCHEDULED_JOB_CODES } from '../scheduled-jobs';
import { JOB_RUN_STATUSES } from '../job-runs.repository';

export const jobCodeParamSchema = z.object({ code: z.enum(SCHEDULED_JOB_CODES) }).strict();
export class JobCodeParamDto extends createZodDto(jobCodeParamSchema) {}

// ---- responses -------------------------------------------------------------

export const jobRunSchema = z.object({
  id: z.string(),
  trigger: z.enum(['schedule', 'manual']),
  triggeredByUserId: z.string().nullable(),
  queueJobId: z.string().nullable(),
  status: z.enum(JOB_RUN_STATUSES),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  rowsAffected: z.number(),
  details: z.record(z.unknown()),
  error: z.string().nullable(),
});
export type JobRun = z.infer<typeof jobRunSchema>;
export class JobRunDto extends createZodDto(jobRunSchema) {}

export const jobHealthSchema = z.object({
  code: z.enum(SCHEDULED_JOB_CODES),
  queue: z.string(),
  /** The repeatable schedule as BullMQ holds it; null if the worker never registered it. */
  schedule: z
    .object({
      pattern: z.string().nullable(),
      tz: z.string().nullable(),
      nextRunAt: z.string().nullable(),
    })
    .nullable(),
  running: z.boolean(),
  lastRun: jobRunSchema.nullable(),
  lastSuccessAt: z.string().nullable(),
  lastFailure: jobRunSchema.nullable(),
});
export type JobHealth = z.infer<typeof jobHealthSchema>;
export class JobHealthDto extends createZodDto(jobHealthSchema) {}

export const jobTriggeredSchema = z.object({
  code: z.enum(SCHEDULED_JOB_CODES),
  queue: z.string(),
  queueJobId: z.string(),
});
export type JobTriggered = z.infer<typeof jobTriggeredSchema>;
export class JobTriggeredDto extends createZodDto(jobTriggeredSchema) {}
