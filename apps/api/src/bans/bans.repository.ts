import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import {
  APPEAL_STATUSES,
  BAN_REASONS,
  BAN_SEVERITIES,
  BAN_STATUSES,
  BLACKLIST_REASONS,
  BLACKLIST_SEVERITIES,
  BLACKLIST_STATUSES,
  COMPLAINT_CATEGORIES,
  COMPLAINT_PRIORITIES,
  COMPLAINT_STATUSES,
} from './dto/bans.dto';

const timestamp = z.union([z.date(), z.string()]).transform((v) => new Date(v).toISOString());
const count = z.union([z.number(), z.string(), z.bigint()]).transform((v) => Number(v));
const evidence = z.array(z.object({ type: z.string(), id: z.string() }));
const appealStatus = z.enum(APPEAL_STATUSES);

async function rows<T extends z.ZodTypeAny>(
  tx: DatabaseTransaction,
  schema: T,
  query: ReturnType<typeof sql>,
): Promise<z.infer<T>[]> {
  return z.array(schema).parse([...(await tx.execute(query))]);
}

async function one<T extends z.ZodTypeAny>(
  tx: DatabaseTransaction,
  schema: T,
  query: ReturnType<typeof sql>,
): Promise<z.infer<T>> {
  const [row] = await rows(tx, schema, query);
  if (row === undefined) throw new Error('bans: the function returned no row');
  return row;
}

const NOTICE_ROW = z.object({
  kind: z.enum(['area', 'platform']),
  id: z.string(),
  reference_code: z.string(),
  severity_code: z.enum(['restricted', 'banned', 'terminated']),
  reason_code: z.string(),
  area_name_bn: z.string().nullable(),
  area_name_en: z.string().nullable(),
  starts_at: timestamp,
  expires_at: timestamp.nullable(),
  is_permanent: z.boolean(),
  appeal_id: z.string().nullable(),
  appeal_reference: z.string().nullable(),
  appeal_status: appealStatus.nullable(),
  can_appeal: z.boolean(),
});
export type NoticeRow = z.infer<typeof NOTICE_ROW>;
const PUBLIC_NOTICE_ROW = NOTICE_ROW.extend({ appeals_left_today: count });

const APPEAL_CREATED_ROW = z.object({
  id: z.string(),
  public_reference: z.string(),
  queue_code: z.enum(['tenant_admin', 'platform']),
  status_code: appealStatus,
  tenant_id: z.string().nullable(),
});
export type AppealCreatedRow = z.infer<typeof APPEAL_CREATED_ROW>;

const MY_APPEAL_ROW = z.object({
  id: z.string(),
  public_reference: z.string(),
  status_code: appealStatus,
  target_reference: z.string().nullable(),
  submitted_at: timestamp,
  decided_at: timestamp.nullable(),
});
export type MyAppealRow = z.infer<typeof MY_APPEAL_ROW>;

const ISSUED_ROW = z.object({
  id: z.string(),
  reference_code: z.string(),
  starts_at: timestamp,
  expires_at: timestamp.nullable(),
  is_permanent: z.boolean(),
  escalation_step: count,
  area_name_bn: z.string(),
});
export type IssuedRow = z.infer<typeof ISSUED_ROW>;

const BAN_ROW = z.object({
  id: z.string(),
  reference_code: z.string(),
  user_id: z.string(),
  display_name: z.string().nullable(),
  severity_code: z.enum(BAN_SEVERITIES),
  reason_code: z.enum(BAN_REASONS),
  reason_text: z.string(),
  evidence_refs: evidence,
  is_permanent: z.boolean(),
  starts_at: timestamp,
  expires_at: timestamp.nullable(),
  escalation_step: count,
  status_code: z.enum(BAN_STATUSES),
  banned_by_name: z.string().nullable(),
  revoke_reason: z.string().nullable(),
  open_appeal: z.boolean(),
});
export type BanRow = z.infer<typeof BAN_ROW>;

const MEMBER_ROW = z.object({
  user_id: z.string(),
  display_name: z.string().nullable(),
  role_code: z.string(),
  ban_severity_code: z.string().nullable(),
  prior_bans: count,
});
export type MemberRow = z.infer<typeof MEMBER_ROW>;

const QUEUE_ROW = z.object({
  id: z.string(),
  public_reference: z.string(),
  status_code: appealStatus,
  queue_code: z.enum(['tenant_admin', 'platform']),
  channel_code: z.enum(['in_app', 'public_otp']),
  statement: z.string(),
  submitted_at: timestamp,
  escalate_at: timestamp.nullable(),
  escalated_at: timestamp.nullable(),
  escalation_reason: z.enum(['timeout', 'tenant_upheld']).nullable(),
  tenant_recommendation: z.literal('uphold').nullable(),
  tenant_note: z.string().nullable(),
  kind: z.enum(['area', 'platform']),
  target_id: z.string(),
  target_reference: z.string(),
  severity_code: z.string(),
  reason_code: z.string(),
  reason_text: z.string(),
  evidence_refs: evidence,
  is_permanent: z.boolean(),
  expires_at: timestamp.nullable(),
  area_name_bn: z.string().nullable(),
  appellant_user_id: z.string(),
  appellant_name: z.string().nullable(),
});
export type QueueRow = z.infer<typeof QUEUE_ROW>;

const DECIDED_APPEAL_ROW = z.object({
  status_code: appealStatus,
  user_id: z.string(),
  public_reference: z.string(),
  tenant_id: z.string().nullable(),
  kind: z.enum(['area', 'platform']),
  replacement_reference: z.string().nullable(),
  replacement_until: timestamp.nullable(),
});
export type DecidedAppealRow = z.infer<typeof DECIDED_APPEAL_ROW>;

const BLACKLIST_ROW = z.object({
  id: z.string(),
  reference_code: z.string(),
  user_id: z.string().nullable(),
  display_name: z.string().nullable(),
  reason_code: z.enum(BLACKLIST_REASONS),
  severity_code: z.enum(BLACKLIST_SEVERITIES),
  status_code: z.enum(BLACKLIST_STATUSES),
  summary: z.string(),
  evidence_refs: evidence,
  expires_at: timestamp.nullable(),
  source_area_name_bn: z.string().nullable(),
  recommended_by_name: z.string().nullable(),
  created_at: timestamp,
  reviewed_at: timestamp.nullable(),
  review_note: z.string().nullable(),
});
export type BlacklistRow = z.infer<typeof BLACKLIST_ROW>;

const DECIDED_BLACKLIST_ROW = z.object({
  status_code: z.enum(BLACKLIST_STATUSES),
  user_id: z.string().nullable(),
  severity_code: z.enum(BLACKLIST_SEVERITIES),
  reference_code: z.string(),
  source_tenant_id: z.string().nullable(),
  expires_at: timestamp.nullable(),
});
export type DecidedBlacklistRow = z.infer<typeof DECIDED_BLACKLIST_ROW>;

const COMPLAINT_CREATED_ROW = z.object({
  id: z.string(),
  reference_code: z.string(),
  status_code: z.enum(COMPLAINT_STATUSES),
  priority_code: z.enum(COMPLAINT_PRIORITIES),
  due_at: timestamp,
});
const MY_COMPLAINT_ROW = z.object({
  id: z.string(),
  reference_code: z.string(),
  subject_type: z.enum(['user', 'store']),
  subject_name: z.string().nullable(),
  category_code: z.enum(COMPLAINT_CATEGORIES),
  status_code: z.enum(COMPLAINT_STATUSES),
  created_at: timestamp,
  resolved_at: timestamp.nullable(),
});
export type MyComplaintRow = z.infer<typeof MY_COMPLAINT_ROW>;
const COMPLAINT_QUEUE_ROW = z.object({
  id: z.string(),
  reference_code: z.string(),
  subject_type: z.enum(['user', 'store']),
  subject_id: z.string(),
  subject_user_id: z.string(),
  subject_name: z.string().nullable(),
  reporter_name: z.string().nullable(),
  category_code: z.enum(COMPLAINT_CATEGORIES),
  priority_code: z.enum(COMPLAINT_PRIORITIES),
  status_code: z.enum(COMPLAINT_STATUSES),
  description: z.string(),
  evidence_refs: evidence,
  assigned_to_user_id: z.string().nullable(),
  assigned_to_name: z.string().nullable(),
  due_at: timestamp,
  overdue: z.boolean(),
  created_at: timestamp,
  resolution: z.string().nullable(),
  resolved_at: timestamp.nullable(),
  ban_id: z.string().nullable(),
  subject_ban_severity: z.string().nullable(),
});
export type ComplaintQueueRow = z.infer<typeof COMPLAINT_QUEUE_ROW>;
const ASSIGNEE_ROW = z.object({
  user_id: z.string(),
  display_name: z.string().nullable(),
  role_code: z.string(),
  open_count: count,
});
const COMPLAINT_UPDATED_ROW = z.object({
  reference_code: z.string(),
  status_code: z.enum(COMPLAINT_STATUSES),
  priority_code: z.enum(COMPLAINT_PRIORITIES),
  assigned_to_user_id: z.string().nullable(),
  newly_assigned: z.boolean(),
  due_at: timestamp,
});
export type ComplaintUpdatedRow = z.infer<typeof COMPLAINT_UPDATED_ROW>;

const json = (value: unknown) => sql`${JSON.stringify(value)}::text::jsonb`;

/** Thin typed wrappers over the 0059 functions; every rule lives in SQL. */
@Injectable()
export class BansRepository {
  // ---- bans ----

  issue(
    tx: DatabaseTransaction,
    input: {
      userId: string;
      severity: string;
      reasonCode: string;
      reasonText: string;
      evidence: unknown[];
      durationDays: number | null;
      permanent: boolean;
      overrideReason: string | null;
    },
  ): Promise<IssuedRow> {
    return one(
      tx,
      ISSUED_ROW,
      sql`select id, reference_code, starts_at, expires_at, is_permanent, escalation_step, area_name_bn
          from public.issue_ban(${input.userId}::uuid, ${input.severity}, ${input.reasonCode}, ${input.reasonText},
                                ${json(input.evidence)}, ${input.durationDays}::integer, ${input.permanent},
                                ${input.overrideReason})`,
    );
  }

  lift(
    tx: DatabaseTransaction,
    banId: string,
    reason: string,
  ): Promise<{ user_id: string; reference_code: string }> {
    return one(
      tx,
      z.object({ user_id: z.string(), reference_code: z.string() }),
      sql`select user_id, reference_code from public.lift_ban(${banId}::uuid, ${reason})`,
    );
  }

  list(
    tx: DatabaseTransaction,
    activeOnly: boolean,
    after: string | null,
    limit: number,
  ): Promise<BanRow[]> {
    return rows(
      tx,
      BAN_ROW,
      sql`select * from public.ban_list_page(${activeOnly}, ${after}::uuid, ${limit}::integer)`,
    );
  }

  findMember(tx: DatabaseTransaction, phone: string): Promise<MemberRow[]> {
    return rows(tx, MEMBER_ROW, sql`select * from public.ban_find_member(${phone})`);
  }

  expire(tx: DatabaseTransaction, limit: number) {
    return rows(
      tx,
      z.object({
        kind: z.enum(['area', 'platform']),
        id: z.string(),
        user_id: z.string().nullable(),
        tenant_id: z.string().nullable(),
        reference_code: z.string(),
      }),
      sql`select * from public.expire_bans(${limit}::integer)`,
    );
  }

  recipients(
    tx: DatabaseTransaction,
    kind: 'area_admins' | 'platform_admins',
    tenantId: string | null,
  ): Promise<string[]> {
    return rows(
      tx,
      z.object({ user_id: z.string() }),
      sql`select user_id from public.ban_staff_recipients(${kind}, ${tenantId}::uuid)`,
    ).then((r) => r.map((x) => x.user_id));
  }

  // ---- notices and appeals ----

  myNotices(tx: DatabaseTransaction): Promise<NoticeRow[]> {
    return rows(tx, NOTICE_ROW, sql`select * from public.my_ban_notices()`);
  }

  myAppeals(tx: DatabaseTransaction): Promise<MyAppealRow[]> {
    return rows(tx, MY_APPEAL_ROW, sql`select * from public.my_appeals()`);
  }

  submitInApp(
    tx: DatabaseTransaction,
    targetId: string,
    statement: string,
  ): Promise<AppealCreatedRow> {
    return one(
      tx,
      APPEAL_CREATED_ROW,
      sql`select * from public.appeal_submit_in_app(${targetId}::uuid, ${statement})`,
    );
  }

  publicStatus(tx: DatabaseTransaction, phone: string) {
    return rows(tx, PUBLIC_NOTICE_ROW, sql`select * from public.public_appeal_status(${phone})`);
  }

  publicSubmit(
    tx: DatabaseTransaction,
    input: {
      phone: string;
      reference: string;
      statement: string;
      ip: string | null;
      userAgent: string | null;
    },
  ): Promise<AppealCreatedRow> {
    return one(
      tx,
      APPEAL_CREATED_ROW,
      sql`select * from public.public_appeal_submit(${input.phone}, ${input.reference}, ${input.statement},
                                                    ${input.ip}::inet, ${input.userAgent})`,
    );
  }

  queue(
    tx: DatabaseTransaction,
    scope: 'area' | 'platform',
    after: string | null,
    limit: number,
  ): Promise<QueueRow[]> {
    return rows(
      tx,
      QUEUE_ROW,
      sql`select * from public.appeal_queue_page(${scope}, ${after}::uuid, ${limit}::integer)`,
    );
  }

  decideAppeal(
    tx: DatabaseTransaction,
    id: string,
    decision: string,
    note: string | null,
    reducedUntil: string | null,
  ): Promise<DecidedAppealRow> {
    return one(
      tx,
      DECIDED_APPEAL_ROW,
      sql`select * from public.decide_appeal(${id}::uuid, ${decision}, ${note}, ${reducedUntil}::timestamptz)`,
    );
  }

  escalateDue(tx: DatabaseTransaction, limit: number) {
    return rows(
      tx,
      z.object({ id: z.string(), public_reference: z.string(), tenant_id: z.string().nullable() }),
      sql`select * from public.escalate_due_appeals(${limit}::integer)`,
    );
  }

  // ---- blacklist ----

  recommend(
    tx: DatabaseTransaction,
    input: {
      userId: string;
      reasonCode: string;
      severity: string;
      summary: string;
      evidence: unknown[];
      expiresAt: string | null;
    },
  ): Promise<{ id: string; reference_code: string }> {
    return one(
      tx,
      z.object({ id: z.string(), reference_code: z.string() }),
      sql`select id, reference_code from public.recommend_blacklist(${input.userId}::uuid, ${input.reasonCode},
            ${input.severity}, ${input.summary}, ${json(input.evidence)}, ${input.expiresAt}::timestamptz)`,
    );
  }

  blacklistPage(
    tx: DatabaseTransaction,
    scope: 'area' | 'platform',
    status: string | null,
    after: string | null,
    limit: number,
  ): Promise<BlacklistRow[]> {
    return rows(
      tx,
      BLACKLIST_ROW,
      sql`select * from public.blacklist_page(${scope}, ${status}, ${after}::uuid, ${limit}::integer)`,
    );
  }

  subjectPhone(tx: DatabaseTransaction, entryId: string): Promise<string | null> {
    return one(
      tx,
      z.object({ phone: z.string().nullable() }),
      sql`select public.blacklist_subject_phone(${entryId}::uuid) as phone`,
    ).then((r) => r.phone);
  }

  decideBlacklist(
    tx: DatabaseTransaction,
    id: string,
    decision: string,
    note: string | null,
    phoneHash: string | null,
  ): Promise<DecidedBlacklistRow> {
    return one(
      tx,
      DECIDED_BLACKLIST_ROW,
      sql`select * from public.decide_blacklist(${id}::uuid, ${decision}, ${note}, ${phoneHash})`,
    );
  }

  revokeBlacklist(tx: DatabaseTransaction, id: string, reason: string) {
    return one(
      tx,
      z.object({
        user_id: z.string().nullable(),
        reference_code: z.string(),
        source_tenant_id: z.string().nullable(),
      }),
      sql`select * from public.revoke_blacklist(${id}::uuid, ${reason})`,
    );
  }

  // ---- complaints ----

  submitComplaint(
    tx: DatabaseTransaction,
    input: {
      subjectType: string;
      subjectId: string;
      category: string;
      description: string;
      evidence: unknown[];
    },
  ) {
    return one(
      tx,
      COMPLAINT_CREATED_ROW,
      sql`select * from public.submit_complaint(${input.subjectType}, ${input.subjectId}::uuid, ${input.category},
                                                ${input.description}, ${json(input.evidence)})`,
    );
  }

  myComplaints(tx: DatabaseTransaction): Promise<MyComplaintRow[]> {
    return rows(tx, MY_COMPLAINT_ROW, sql`select * from public.my_complaints()`);
  }

  complaintQueue(
    tx: DatabaseTransaction,
    status: string | null,
    mine: boolean,
    after: string | null,
    limit: number,
  ): Promise<ComplaintQueueRow[]> {
    return rows(
      tx,
      COMPLAINT_QUEUE_ROW,
      sql`select * from public.complaint_queue_page(${status}, ${mine}, ${after}::uuid, ${limit}::integer)`,
    );
  }

  assignees(tx: DatabaseTransaction) {
    return rows(tx, ASSIGNEE_ROW, sql`select * from public.complaint_assignees()`);
  }

  updateComplaint(
    tx: DatabaseTransaction,
    id: string,
    input: {
      setAssignee: boolean;
      assignee: string | null;
      priority: string | null;
      status: string | null;
    },
  ): Promise<ComplaintUpdatedRow> {
    return one(
      tx,
      COMPLAINT_UPDATED_ROW,
      sql`select * from public.update_complaint(${id}::uuid, ${input.setAssignee}, ${input.assignee}::uuid,
                                                ${input.priority}, ${input.status})`,
    );
  }

  resolveComplaint(tx: DatabaseTransaction, id: string, resolution: string, banId: string | null) {
    return one(
      tx,
      z.object({ reporter_user_id: z.string(), reference_code: z.string() }),
      sql`select * from public.resolve_complaint(${id}::uuid, ${resolution}, ${banId}::uuid)`,
    );
  }

  slaBreaches(tx: DatabaseTransaction, limit: number) {
    return rows(
      tx,
      z.object({
        id: z.string(),
        reference_code: z.string(),
        tenant_id: z.string(),
        assigned_to_user_id: z.string().nullable(),
      }),
      sql`select * from public.due_complaint_sla_breaches(${limit}::integer)`,
    );
  }

  /** The author of a visible post (complaint_post_author, 0059); null otherwise. */
  postAuthor(tx: DatabaseTransaction, postId: string): Promise<string | null> {
    return one(
      tx,
      z.object({ user_id: z.string().nullable() }),
      sql`select public.complaint_post_author(${postId}::uuid) as user_id`,
    ).then((r) => r.user_id);
  }

  /** The current area's Bengali name (a notice names the area, never a person). */
  areaName(tx: DatabaseTransaction): Promise<string | null> {
    return rows(
      tx,
      z.object({ name_bn: z.string() }),
      sql`select name_bn from public.tenants where id = public.current_tenant_id()`,
    ).then((r) => r[0]?.name_bn ?? null);
  }

  /** The area a store belongs to (item_tenant_of, 0032). */
  storeTenant(tx: DatabaseTransaction, storeId: string): Promise<string | null> {
    return one(
      tx,
      z.object({ tenant_id: z.string().nullable() }),
      sql`select public.item_tenant_of('store', ${storeId}::uuid) as tenant_id`,
    ).then((r) => r.tenant_id);
  }
}
