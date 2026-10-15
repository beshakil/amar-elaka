import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import {
  REJECTION_REASONS,
  REQUEST_STATES,
  VERIFICATION_LEVELS,
  VERIFICATION_STATUSES,
} from './dto/verification.dto';

const timestamp = z.union([z.date(), z.string()]).transform((v) => new Date(v).toISOString());
const count = z.union([z.number(), z.string(), z.bigint()]).transform((v) => Number(v));
const level = z.enum(VERIFICATION_LEVELS);
const status = z.enum(VERIFICATION_STATUSES);
const subjectType = z.enum(['member', 'store']);
const requestLevel = z.enum(['identity_checked', 'business_verified']);

const MINE_ROW = z.object({
  verification_id: z.string(),
  subject_type: subjectType,
  subject_id: z.string(),
  level_code: requestLevel,
  status_code: status,
  rejection_reason_code: z.enum(REJECTION_REASONS).nullable(),
  decision_note: z.string().nullable(),
  expires_at: timestamp.nullable(),
  created_at: timestamp,
  can_request: z.enum(REQUEST_STATES),
});
export type MineRow = z.infer<typeof MINE_ROW>;

const QUEUE_ROW = z.object({
  verification_id: z.string(),
  subject_type: subjectType,
  subject_id: z.string(),
  subject_name: z.string().nullable(),
  level_code: requestLevel,
  status_code: status,
  nid_last3: z.string().nullable(),
  nid_duplicate: z.boolean(),
  visit_status: z.enum(['not_needed', 'requested', 'done']),
  evidence_count: count,
  created_at: timestamp,
});
export type QueueRow = z.infer<typeof QUEUE_ROW>;

export const EVIDENCE_ROW = z.object({
  kind: z.enum(['selfie', 'trade_licence', 'shop_front', 'visit_photo']),
  mediaId: z.string(),
  mediaKind: z.string(),
  mimeType: z.string().nullable(),
  storageKey: z.string(),
  variants: z.unknown(),
  purged: z.boolean(),
});
const DETAIL_ROW = QUEUE_ROW.omit({ evidence_count: true }).extend({
  decision_note: z.string().nullable(),
  rejection_reason_code: z.enum(REJECTION_REASONS).nullable(),
  expires_at: timestamp.nullable(),
  documents_purged_at: timestamp.nullable(),
  owner_identity: level.nullable(),
  evidence: z.array(EVIDENCE_ROW),
  history: z.array(
    z.object({
      id: z.string(),
      status: status,
      createdAt: timestamp,
      reviewedAt: timestamp.nullable(),
      rejectionReason: z.string().nullable(),
    }),
  ),
});
export type DetailRow = z.infer<typeof DETAIL_ROW>;

const DECIDED_ROW = z.object({
  status_code: status,
  subject_type: subjectType,
  subject_id: z.string(),
  submitted_by_user_id: z.string(),
  expires_at: timestamp.nullable(),
});
export type DecidedRow = z.infer<typeof DECIDED_ROW>;

const EXPIRED_ROW = z.object({
  verification_id: z.string(),
  tenant_id: z.string(),
  subject_type: subjectType,
  subject_id: z.string(),
  user_id: z.string(),
  store_name: z.string().nullable(),
});
export type ExpiredRow = z.infer<typeof EXPIRED_ROW>;
const REMINDER_ROW = z.object({
  verification_id: z.string(),
  tenant_id: z.string(),
  subject_type: subjectType,
  user_id: z.string(),
  store_name: z.string().nullable(),
  expires_at: timestamp,
});
export type ReminderRow = z.infer<typeof REMINDER_ROW>;

/**
 * Verification's SQL (ADR 062). Every rule lives in the 0058 functions — the
 * level, who may submit, one open request, the decision with its audit, the
 * expiry and the retention — so this only calls them and parses the answers.
 */
@Injectable()
export class VerificationRepository {
  async userLevel(tx: DatabaseTransaction, userId: string): Promise<z.infer<typeof level>> {
    const rows = await tx.execute(
      sql`select public.verification_level_of_user(${userId}::uuid) as level`,
    );
    return z
      .array(z.object({ level }))
      .length(1)
      .parse([...rows])[0]!.level;
  }

  async storeLevel(tx: DatabaseTransaction, storeId: string): Promise<z.infer<typeof level>> {
    const rows = await tx.execute(
      sql`select public.verification_level_of_store(${storeId}::uuid) as level`,
    );
    return z
      .array(z.object({ level }))
      .length(1)
      .parse([...rows])[0]!.level;
  }

  async mine(tx: DatabaseTransaction): Promise<MineRow[]> {
    const rows = await tx.execute(sql`
      select verification_id, subject_type, subject_id, level_code, status_code, rejection_reason_code,
             decision_note, expires_at, created_at, can_request
      from public.my_verifications()`);
    return z.array(MINE_ROW).parse([...rows]);
  }

  async canRequest(
    tx: DatabaseTransaction,
    subject: 'member' | 'store',
    subjectId: string,
  ): Promise<z.infer<typeof MINE_ROW>['can_request']> {
    const rows = await tx.execute(sql`
      select public.verification_can_request(${subject}, ${subjectId}::uuid, public.current_tenant_id()) as state`);
    return z
      .array(z.object({ state: z.enum(REQUEST_STATES) }))
      .length(1)
      .parse([...rows])[0]!.state;
  }

  async submitIdentity(
    tx: DatabaseTransaction,
    input: { nidHash: string; nidLast3: string; selfieMediaId: string },
  ): Promise<{ id: string; nidDuplicate: boolean }> {
    const rows = await tx.execute(sql`
      select verification_id, nid_duplicate
      from public.submit_identity_verification(${input.nidHash}, ${input.nidLast3}, ${input.selfieMediaId}::uuid)`);
    const row = z
      .array(z.object({ verification_id: z.string(), nid_duplicate: z.boolean() }))
      .length(1)
      .parse([...rows])[0]!;
    return { id: row.verification_id, nidDuplicate: row.nid_duplicate };
  }

  async submitBusiness(
    tx: DatabaseTransaction,
    input: { storeId: string; licenceMediaId: string; shopFrontMediaId: string },
  ): Promise<string> {
    const rows = await tx.execute(sql`
      select verification_id from public.submit_business_verification(
        ${input.storeId}::uuid, ${input.licenceMediaId}::uuid, ${input.shopFrontMediaId}::uuid)`);
    return z
      .array(z.object({ verification_id: z.string() }))
      .length(1)
      .parse([...rows])[0]!.verification_id;
  }

  async queue(
    tx: DatabaseTransaction,
    after: string | undefined,
    limit: number,
  ): Promise<QueueRow[]> {
    const rows = await tx.execute(sql`
      select verification_id, subject_type, subject_id, subject_name, level_code, status_code, nid_last3,
             nid_duplicate, visit_status, evidence_count, created_at
      from public.verification_queue_page(${after ?? null}::uuid, ${limit}::integer)`);
    return z.array(QUEUE_ROW).parse([...rows]);
  }

  async detail(tx: DatabaseTransaction, id: string): Promise<DetailRow | undefined> {
    const rows = await tx.execute(sql`
      select verification_id, subject_type, subject_id, subject_name, level_code, status_code, nid_last3,
             nid_duplicate, visit_status, decision_note, rejection_reason_code, expires_at, documents_purged_at,
             created_at, owner_identity, evidence, history
      from public.verification_detail(${id}::uuid)`);
    return z
      .array(DETAIL_ROW)
      .max(1)
      .parse([...rows])[0];
  }

  async decide(
    tx: DatabaseTransaction,
    input: {
      id: string;
      decision: string;
      rejectionReason: string | null;
      note: string | null;
      expiresAt: string | null;
    },
  ): Promise<DecidedRow> {
    const rows = await tx.execute(sql`
      select status_code, subject_type, subject_id, submitted_by_user_id, expires_at
      from public.decide_verification(${input.id}::uuid, ${input.decision}, ${input.rejectionReason},
                                      ${input.note}, ${input.expiresAt}::timestamptz)`);
    return z
      .array(DECIDED_ROW)
      .length(1)
      .parse([...rows])[0]!;
  }

  async storeName(tx: DatabaseTransaction, storeId: string): Promise<string | null> {
    const rows = await tx.execute(
      sql`select name_bn from public.stores where id = ${storeId}::uuid`,
    );
    return z.array(z.object({ name_bn: z.string() })).parse([...rows])[0]?.name_bn ?? null;
  }

  /** The caller's own verification upload in this area: its status. */
  async ownEvidenceStatus(tx: DatabaseTransaction, mediaId: string): Promise<string | null> {
    const rows = await tx.execute(sql`
      select status_code from public.media_assets
      where id = ${mediaId}::uuid and uploaded_by_user_id = public.current_user_id()
        and kind_code in ('verification_image', 'document') and deleted_at is null`);
    return z.array(z.object({ status_code: z.string() })).parse([...rows])[0]?.status_code ?? null;
  }

  async expire(tx: DatabaseTransaction, limit: number): Promise<ExpiredRow[]> {
    const rows = await tx.execute(sql`
      select verification_id, tenant_id, subject_type, subject_id, user_id, store_name
      from public.expire_verifications(${limit}::integer)`);
    return z.array(EXPIRED_ROW).parse([...rows]);
  }

  async dueReminders(tx: DatabaseTransaction, limit: number): Promise<ReminderRow[]> {
    const rows = await tx.execute(sql`
      select verification_id, tenant_id, subject_type, user_id, store_name, expires_at
      from public.due_verification_reminders(${limit}::integer)`);
    return z.array(REMINDER_ROW).parse([...rows]);
  }

  async purgeDocuments(tx: DatabaseTransaction, limit: number): Promise<number> {
    const rows = await tx.execute(
      sql`select public.purge_verification_documents(${limit}::integer) as n`,
    );
    return z
      .array(z.object({ n: z.number() }))
      .length(1)
      .parse([...rows])[0]!.n;
  }
}
