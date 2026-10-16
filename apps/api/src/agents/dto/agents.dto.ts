import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';
import { businessHoursSchema } from '../../places/dto/places.dto';

// settings-exempt: latitude/longitude ranges, facts of the coordinate system.
const MAX_LAT = 90;
// settings-exempt: see above
const MAX_LNG = 180;
// settings-exempt: an abuse bound on input size (the API caps photos with agent_capture_photos_max).
const MEDIA_IDS_CEILING = 20;
// settings-exempt: free text bounds — abuse limits on input size, not business rules.
const NOTES_MAX = 2000;
// settings-exempt: see above
const TITLE_MAX = 200;
// settings-exempt: a GPS accuracy can't be worse than this many metres and still be a fix.
const ACCURACY_CEILING_M = 100_000;

export const SUBMISSION_KINDS = ['new_shop', 'verify_shop', 'update_info'] as const;
export const TASK_TYPES = ['map_shop', 'verify_shop', 'update_info'] as const;
export const TASK_STATUSES = ['open', 'done', 'cancelled'] as const;
export const AGENT_STATUSES = ['active', 'suspended', 'terminated'] as const;
export const FRAUD_FLAGS = [
  'gps_photo_mismatch',
  'impossible_travel',
  'rapid_fire',
  'duplicate_photo',
  'phone_otp_failed',
] as const;
export type FraudFlag = (typeof FRAUD_FLAGS)[number];
export const REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const;

const uuid = z.string().uuid();
const instant = z.string().datetime({ offset: true });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-10-16');
const point = z.object({ lat: z.number(), lng: z.number() });
const pointInput = z
  .object({
    lat: z.number().min(-MAX_LAT).max(MAX_LAT),
    lng: z.number().min(-MAX_LNG).max(MAX_LNG),
  })
  .strict();
const money = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'an amount like 20 or 20.50');
const targetsSchema = z
  .object({
    daily_shops: z.number().int().min(0).optional(),
    weekly_shops: z.number().int().min(0).optional(),
  })
  .strict();

// ---- the agent's own ---------------------------------------------------------

export const agentMeSchema = z.object({
  agent: z.object({
    id: z.string(),
    code: z.string(),
    status: z.string(),
    targets: z.object({ dailyShops: z.number().nullable(), weeklyShops: z.number().nullable() }),
  }),
  /** What the phone needs offline (rule 9: the numbers are settings). */
  settings: z.object({
    minGpsAccuracyM: z.number(),
    photosMax: z.number(),
    captureMaxAgeDays: z.number(),
  }),
});
export type AgentMe = z.infer<typeof agentMeSchema>;
export class AgentMeDto extends createZodDto(agentMeSchema) {}

/**
 * One capture, as queued on the phone. `id` is the phone's UUID: send the
 * same submission again (a retried sync) and the answer is the first one's.
 */
export const submissionInputSchema = z
  .object({
    id: uuid,
    kind: z.enum(SUBMISSION_KINDS),
    taskId: uuid.optional(),
    /** verify_shop / update_info: the shop on the map. */
    placeId: uuid.optional(),
    capturedAt: instant,
    location: pointInput,
    accuracyM: z.number().min(0).max(ACCURACY_CEILING_M),
    /** The phone's fix and time when the shop-front photo was taken. */
    photo: z
      .object({ location: pointInput.nullable(), takenAt: instant.nullable() })
      .strict()
      .nullable(),
    /** Ready images (POST /media/presign → PUT → confirm), the shop front first. */
    photoIds: z.array(uuid).max(MEDIA_IDS_CEILING).default([]),
    nameBn: z.string().trim().min(1).max(TITLE_MAX).optional(),
    nameEn: z.string().trim().min(1).max(TITLE_MAX).optional(),
    categoryId: uuid.optional(),
    phone: z.string().trim().min(1).optional(),
    businessHours: businessHoursSchema.optional(),
    addressText: z.string().trim().min(1).max(TITLE_MAX).optional(),
    notes: z.string().trim().min(1).max(NOTES_MAX).optional(),
    /**
     * After `needs_decision`: 'new' = a different shop (add it), or 'same' =
     * it is `placeId` (recorded as a verification of that shop).
     */
    duplicateDecision: z
      .discriminatedUnion('decision', [
        z.object({ decision: z.literal('new') }).strict(),
        z.object({ decision: z.literal('same'), placeId: uuid }).strict(),
      ])
      .optional(),
  })
  .strict()
  .refine((s) => s.kind !== 'new_shop' || (s.nameBn !== undefined && s.categoryId !== undefined), {
    message: 'a new shop needs nameBn and categoryId',
  })
  .refine((s) => s.kind === 'new_shop' || s.placeId !== undefined, {
    message: 'verifying or updating needs placeId',
  });
export type SubmissionInput = z.infer<typeof submissionInputSchema>;
export class SubmissionInputDto extends createZodDto(submissionInputSchema) {}

const candidateSchema = z.object({
  placeId: z.string(),
  nameBn: z.string(),
  nameEn: z.string().nullable(),
  location: point,
  distanceM: z.number(),
  score: z.number(),
  phoneMatch: z.boolean(),
});

/**
 * `created`: done (this or an earlier identical upload made it). `needs_decision`:
 * a likely duplicate is already on the map — nothing was made; ask the agent
 * and send the same submission again with `duplicateDecision`.
 */
export const submissionResultSchema = z.object({
  id: z.string(),
  status: z.enum(['created', 'needs_decision']),
  placeId: z.string().nullable(),
  reviewStatus: z.enum(REVIEW_STATUSES).nullable(),
  fraudFlags: z.array(z.string()),
  candidates: z.array(candidateSchema),
});
export type SubmissionResult = z.infer<typeof submissionResultSchema>;
export class SubmissionResultDto extends createZodDto(submissionResultSchema) {}

export const submissionIdParamSchema = z.object({ id: uuid }).strict();
export class SubmissionIdParamDto extends createZodDto(submissionIdParamSchema) {}

export const phoneOtpRequestSchema = z.object({ phone: z.string().trim().min(1) }).strict();
export class PhoneOtpRequestDto extends createZodDto(phoneOtpRequestSchema) {}
export const phoneOtpVerifySchema = z
  .object({ phone: z.string().trim().min(1), code: z.string().regex(/^\d{4,8}$/) })
  .strict();
export class PhoneOtpVerifyDto extends createZodDto(phoneOtpVerifySchema) {}
export const phoneOtpSentSchema = z.object({ resendAfterSeconds: z.number() });
export class PhoneOtpSentDto extends createZodDto(phoneOtpSentSchema) {}
export const phoneCheckSchema = z.object({ status: z.enum(['sent', 'verified', 'failed']) });
export class PhoneCheckDto extends createZodDto(phoneCheckSchema) {}

const taskSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  status: z.string(),
  dueOn: z.string(),
  notes: z.string().nullable(),
  placeId: z.string().nullable(),
  placeName: z.string().nullable(),
  localityName: z.string().nullable(),
  /** Where to go: the point, the place, or the locality's centre. */
  location: point.nullable(),
  doneAt: z.string().nullable(),
});
export type AgentTask = z.infer<typeof taskSchema>;

export const todaySchema = z.object({
  date: z.string(),
  tasks: z.array(taskSchema),
  done: z.number(),
  remaining: z.number(),
});
export type AgentToday = z.infer<typeof todaySchema>;
export class AgentTodayDto extends createZodDto(todaySchema) {}

const outcomeSchema = z.object({
  id: z.string(),
  kind: z.string(),
  capturedAt: z.string(),
  placeId: z.string().nullable(),
  name: z.string().nullable(),
  reviewStatus: z.enum(REVIEW_STATUSES),
  reasonCode: z.string().nullable(),
  reasonText: z.string().nullable(),
  fraudFlags: z.array(z.string()),
  commission: z.string(),
});
export type SubmissionOutcome = z.infer<typeof outcomeSchema>;

const countsSchema = z.object({
  submitted: z.number(),
  approved: z.number(),
  rejected: z.number(),
  pending: z.number(),
  commission: z.string(),
});
export type OutcomeCounts = z.infer<typeof countsSchema>;

export const agentStatsSchema = z.object({
  today: countsSchema,
  week: countsSchema,
  weekStartsOn: z.string(),
  targets: z.object({ dailyShops: z.number().nullable(), weeklyShops: z.number().nullable() }),
  /** The latest decisions this week (rejections show their reason). */
  recent: z.array(outcomeSchema),
});
export type AgentStats = z.infer<typeof agentStatsSchema>;
export class AgentStatsDto extends createZodDto(agentStatsSchema) {}

// ---- the area's staff ----------------------------------------------------------

export const agentListSchema = z.object({
  date: z.string(),
  items: z.array(
    z.object({
      id: z.string(),
      memberId: z.string(),
      code: z.string(),
      name: z.string().nullable(),
      status: z.string(),
      commissionRate: z.string().nullable(),
      targets: z.object({ dailyShops: z.number().nullable(), weeklyShops: z.number().nullable() }),
      today: countsSchema,
      week: countsSchema,
      /** approved ÷ decided this week, 0–1; null before any decision. */
      approvalRate: z.number().nullable(),
      flagged: z.number(),
    }),
  ),
  /** Members with the agent role who are not field agents yet. */
  candidates: z.array(z.object({ memberId: z.string(), name: z.string().nullable() })),
});
export type AgentList = z.infer<typeof agentListSchema>;
export class AgentListDto extends createZodDto(agentListSchema) {}

export const createAgentSchema = z
  .object({
    memberId: uuid,
    agentCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{2,20}$/),
    employmentType: z.enum(['commission_only', 'salaried', 'volunteer']),
    commissionRate: money.nullable().default(null),
    targets: targetsSchema.default({}),
  })
  .strict();
export type CreateAgentInput = z.infer<typeof createAgentSchema>;
export class CreateAgentDto extends createZodDto(createAgentSchema) {}

export const updateAgentSchema = z
  .object({
    status: z.enum(AGENT_STATUSES),
    commissionRate: money.nullable(),
    targets: targetsSchema,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change.');
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;
export class UpdateAgentDto extends createZodDto(updateAgentSchema) {}

export const agentIdParamSchema = z.object({ id: uuid }).strict();
export class AgentIdParamDto extends createZodDto(agentIdParamSchema) {}

export const createTaskSchema = z
  .object({
    type: z.enum(TASK_TYPES),
    title: z.string().trim().min(1).max(TITLE_MAX),
    localityId: uuid.optional(),
    location: pointInput.optional(),
    placeId: uuid.optional(),
    dueOn: isoDate,
    notes: z.string().trim().min(1).max(NOTES_MAX).optional(),
  })
  .strict()
  .refine((t) => t.type === 'map_shop' || t.placeId !== undefined, {
    message: 'verifying or updating needs placeId',
  });
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export class CreateTaskDto extends createZodDto(createTaskSchema) {}

export const updateTaskSchema = z.object({ status: z.enum(['open', 'cancelled']) }).strict();
export class UpdateTaskDto extends createZodDto(updateTaskSchema) {}

export const taskListSchema = z.object({ items: z.array(taskSchema) });
export class TaskListDto extends createZodDto(taskListSchema) {}

export const dayQuerySchema = z
  .object({ date: isoDate.optional(), agentId: uuid.optional() })
  .strict();
export type DayQuery = z.infer<typeof dayQuerySchema>;
export class DayQueryDto extends createZodDto(dayQuerySchema) {}

/** A day's submissions in the area: the admin's map and review list. */
export const submissionDaySchema = z.object({
  date: z.string(),
  items: z.array(
    z.object({
      id: z.string(),
      agentId: z.string(),
      agentCode: z.string(),
      kind: z.string(),
      capturedAt: z.string(),
      location: point,
      accuracyM: z.number(),
      placeId: z.string().nullable(),
      placeEditSuggestionId: z.string().nullable(),
      name: z.string().nullable(),
      reviewStatus: z.enum(REVIEW_STATUSES),
      reasonCode: z.string().nullable(),
      fraudFlags: z.array(z.string()),
      fraudDetail: z.record(z.unknown()),
      phoneCheck: z.string(),
      photos: z.array(z.object({ id: z.string(), url: z.string().nullable() })),
      notes: z.string().nullable(),
    }),
  ),
});
export type SubmissionDay = z.infer<typeof submissionDaySchema>;
export class SubmissionDayDto extends createZodDto(submissionDaySchema) {}

export const periodQuerySchema = z
  .object({ from: isoDate, to: isoDate })
  .strict()
  .refine((q) => q.from <= q.to, 'from is after to');
export type PeriodQuery = z.infer<typeof periodQuerySchema>;
export class PeriodQueryDto extends createZodDto(periodQuerySchema) {}

/** Estimated commission per agent for a period (calculation only; payouts are manual). */
export const commissionReportSchema = z.object({
  from: z.string(),
  to: z.string(),
  items: z.array(
    z.object({
      agentId: z.string(),
      agentCode: z.string(),
      name: z.string().nullable(),
      rate: z.string(),
      newShops: z.number(),
      verifications: z.number(),
      updates: z.number(),
      rejected: z.number(),
      pending: z.number(),
      amount: z.string(),
    }),
  ),
  total: z.string(),
});
export type CommissionReport = z.infer<typeof commissionReportSchema>;
export class CommissionReportDto extends createZodDto(commissionReportSchema) {}

export const createdIdSchema = z.object({ id: z.string() });
export class AgentCreatedDto extends createZodDto(createdIdSchema) {}
