import { Inject, Injectable } from '@nestjs/common';
import { sqlStateOf } from '../common/utils/sql-state';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { TenantRequiredException } from '../database/tenant.exceptions';
import { parseVariants } from '../media/media.types';
import { NotificationService } from '../notifications/notification.service';
import { SettingsService } from '../settings/settings.service';
import { STORAGE_SERVICE, type StorageService } from '../storage/storage.ports';
import type {
  DecisionInput,
  DecisionResult,
  QueueQuery,
  VerificationDetail,
  VerificationQueue,
} from './dto/verification.dto';
import {
  sqlDetailOf,
  verificationError,
  VerificationDecisionInvalidException,
  VerificationNotFoundException,
} from './verification.exceptions';
import { VerificationRepository, type DetailRow } from './verification.repository';

/**
 * The area's moderators and verification (ADR 062): the queue, one request
 * with its evidence — every file through a signed URL that lives
 * verification_doc_url_ttl_seconds, never a public link — and the decision,
 * which writes moderation_actions and moves the badge at once
 * (decide_verification). The submitter is told.
 */
@Injectable()
export class VerificationModerationService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: VerificationRepository,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  async queue(query: QueueQuery): Promise<VerificationQueue> {
    const tenantId = this.tenantId();
    const max = await this.settings.get('verification_queue_page_size_max', tenantId);
    const limit = Math.min(query.limit ?? max, max);
    const rows = await this.read((tx) => this.repo.queue(tx, query.after, limit + 1));
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: r.verification_id,
        subjectType: r.subject_type,
        subjectId: r.subject_id,
        subjectName: r.subject_name,
        level: r.level_code,
        status: r.status_code,
        nidLast3: r.nid_last3,
        nidDuplicate: r.nid_duplicate,
        visitStatus: r.visit_status,
        evidenceCount: r.evidence_count,
        createdAt: r.created_at,
      })),
      nextAfter: rows.length > limit ? (page[page.length - 1]?.verification_id ?? null) : null,
    };
  }

  async detail(id: string): Promise<VerificationDetail> {
    const tenantId = this.tenantId();
    const row = await this.read((tx) => this.repo.detail(tx, id));
    if (!row) throw new VerificationNotFoundException();
    const ttl = await this.settings.get('verification_doc_url_ttl_seconds', tenantId);
    return {
      id: row.verification_id,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      subjectName: row.subject_name,
      level: row.level_code,
      status: row.status_code,
      nidLast3: row.nid_last3,
      nidDuplicate: row.nid_duplicate,
      visitStatus: row.visit_status,
      evidenceCount: row.evidence.length,
      createdAt: row.created_at,
      note: row.decision_note,
      rejectionReason: row.rejection_reason_code,
      expiresAt: row.expires_at,
      documentsPurged: row.documents_purged_at !== null,
      ownerLevel: row.owner_identity,
      urlExpiresInSeconds: ttl,
      evidence: await Promise.all(row.evidence.map((e) => this.signed(e, ttl))),
      history: row.history,
    };
  }

  async decide(id: string, input: DecisionInput): Promise<DecisionResult> {
    const tenantId = this.tenantId();
    if (input.decision === 'reject' && !input.rejectionReason)
      throw new VerificationDecisionInvalidException();
    let decided;
    try {
      decided = await this.tenantDb.transaction((tx) =>
        this.repo.decide(tx, {
          id,
          decision: input.decision,
          rejectionReason: input.decision === 'reject' ? (input.rejectionReason ?? null) : null,
          note: input.note ?? null,
          expiresAt: input.decision === 'approve' ? (input.expiresAt ?? null) : null,
        }),
      );
    } catch (error) {
      throw verificationError(sqlStateOf(error), sqlDetailOf(error)) ?? error;
    }
    if (decided.status_code === 'approved' || decided.status_code === 'rejected') {
      const storeName =
        decided.subject_type === 'store'
          ? await this.read((tx) => this.repo.storeName(tx, decided.subject_id))
          : null;
      await this.notifications.send({
        userId: decided.submitted_by_user_id,
        type:
          decided.status_code === 'approved' ? 'verification_approved' : 'verification_rejected',
        tenantId,
        params: { storeName, reasonCode: input.rejectionReason ?? null },
        deepLink: deepLinkFor(decided.subject_type, decided.subject_id),
        entityId: id,
        dedupeKey: `verification_${decided.status_code}:${id}`,
      });
    }
    return { status: decided.status_code, expiresAt: decided.expires_at };
  }

  private async signed(
    e: DetailRow['evidence'][number],
    ttl: number,
  ): Promise<VerificationDetail['evidence'][number]> {
    if (e.purged)
      return { kind: e.kind, mimeType: e.mimeType, url: null, previewUrl: null, purged: true };
    const variants = parseVariants(e.variants);
    return {
      kind: e.kind,
      mimeType: e.mimeType,
      url: await this.storage.presignDownload('documents', e.storageKey, ttl),
      previewUrl: variants
        ? await this.storage.presignDownload('documents', variants.card.key, ttl)
        : null,
      purged: false,
    };
  }

  private read<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.tenantDb.transaction(work, { accessMode: 'read only' });
  }

  private tenantId(): string {
    const tenantId = this.context.require().tenantId;
    if (!tenantId) throw new TenantRequiredException();
    return tenantId;
  }
}

/** Where a verification notification opens: the member's own page, or the store's. */
export function deepLinkFor(subjectType: 'member' | 'store', subjectId: string): string {
  return subjectType === 'store' ? `/stores/${subjectId}/verification` : '/verification';
}
