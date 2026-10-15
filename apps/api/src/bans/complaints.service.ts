import { Injectable } from '@nestjs/common';
import { UnauthenticatedException } from '../auth/exceptions/auth.exceptions';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { TenantRequiredException } from '../database/tenant.exceptions';
import { PostOwnershipService } from '../posts/post-ownership.service';
import { SettingsService } from '../settings/settings.service';
import { BAN_DEEP_LINKS, BanNotifier } from './ban-notifier';
import { mapBanErrors, pageSize } from './bans-errors';
import { ComplaintNotAllowedException } from './bans.exceptions';
import { BansRepository, type ComplaintQueueRow } from './bans.repository';
import type {
  ComplaintAssignees,
  ComplaintQueue,
  ComplaintQueueQuery,
  ComplaintSubmitted,
  ComplaintUpdated,
  MyComplaints,
  ResolveComplaintInput,
  SubmitComplaintInput,
  UpdateComplaintInput,
} from './dto/bans.dto';

/**
 * Complaints (ADR 063): a member's complaint about a person or a store —
 * distinct from content reports. It belongs to the subject's area (a
 * store's, or the post's the person was seen on), which works it: priority
 * from the category, an SLA from complaint_sla_hours_*, assignment to a
 * moderator or executive, a written resolution.
 */
@Injectable()
export class ComplaintsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly ownership: PostOwnershipService,
    private readonly repo: BansRepository,
    private readonly notifier: BanNotifier,
    private readonly settings: SettingsService,
  ) {}

  async submit(input: SubmitComplaintInput): Promise<ComplaintSubmitted> {
    if (!this.context.require().userId) throw new UnauthenticatedException();
    const tenantId = await this.areaOf(input);
    const subjectId =
      input.subjectId ??
      (input.subjectType === 'user' && input.postId
        ? await this.read((tx) => this.repo.postAuthor(tx, input.postId!))
        : null);
    if (!subjectId) throw new ComplaintNotAllowedException('subject_not_found');
    const row = await this.ownership.inTenant(tenantId, 'lookup', () =>
      mapBanErrors(() =>
        this.tenantDb.transaction((tx) =>
          this.repo.submitComplaint(tx, {
            subjectType: input.subjectType,
            subjectId,
            category: input.category,
            description: input.description,
            evidence: input.evidence,
          }),
        ),
      ),
    );
    return {
      id: row.id,
      reference: row.reference_code,
      status: row.status_code,
      priority: row.priority_code,
      dueAt: row.due_at,
    };
  }

  async mine(): Promise<MyComplaints> {
    if (!this.context.require().userId) throw new UnauthenticatedException();
    const rows = await this.read((tx) => this.repo.myComplaints(tx));
    return {
      items: rows.map((r) => ({
        id: r.id,
        reference: r.reference_code,
        subjectType: r.subject_type,
        subjectName: r.subject_name,
        category: r.category_code,
        status: r.status_code,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at,
      })),
    };
  }

  async queue(query: ComplaintQueueQuery): Promise<ComplaintQueue> {
    const tenantId = this.tenantId();
    const limit = pageSize(
      query.limit,
      await this.settings.get('complaint_queue_page_size_max', tenantId),
    );
    const rows = await this.read((tx) =>
      this.repo.complaintQueue(
        tx,
        query.status ?? null,
        query.mine === 'true',
        query.after ?? null,
        limit,
      ),
    );
    return {
      items: rows.map(view),
      nextAfter: rows.length === limit ? rows[rows.length - 1]!.id : null,
    };
  }

  async assignees(): Promise<ComplaintAssignees> {
    this.tenantId();
    const rows = await this.read((tx) => this.repo.assignees(tx));
    return {
      items: rows.map((r) => ({
        userId: r.user_id,
        displayName: r.display_name,
        role: r.role_code,
        openCount: r.open_count,
      })),
    };
  }

  async update(id: string, input: UpdateComplaintInput): Promise<ComplaintUpdated> {
    const tenantId = this.tenantId();
    const row = await mapBanErrors(() =>
      this.tenantDb.transaction((tx) =>
        this.repo.updateComplaint(tx, id, {
          setAssignee: input.assigneeUserId !== undefined,
          assignee: input.assigneeUserId ?? null,
          priority: input.priority ?? null,
          status: input.status ?? null,
        }),
      ),
    );
    if (row.newly_assigned) {
      await this.notifier.toUser(
        row.assigned_to_user_id,
        'complaint_assigned',
        tenantId,
        { reference: row.reference_code, dueAt: row.due_at },
        BAN_DEEP_LINKS.complaints,
        id,
        `complaint_assigned:${id}:${row.assigned_to_user_id}`,
      );
    }
    return {
      reference: row.reference_code,
      status: row.status_code,
      priority: row.priority_code,
      assignedToUserId: row.assigned_to_user_id,
      dueAt: row.due_at,
    };
  }

  async resolve(id: string, input: ResolveComplaintInput): Promise<{ status: 'resolved' }> {
    const tenantId = this.tenantId();
    const row = await mapBanErrors(() =>
      this.tenantDb.transaction((tx) =>
        this.repo.resolveComplaint(tx, id, input.resolution, input.banId ?? null),
      ),
    );
    await this.notifier.toUser(
      row.reporter_user_id,
      'complaint_resolved',
      tenantId,
      { reference: row.reference_code },
      BAN_DEEP_LINKS.myComplaints,
      id,
      `complaint_resolved:${id}`,
    );
    return { status: 'resolved' };
  }

  /** A store's area; a person's on the post they were seen on; else the request's. */
  private async areaOf(input: SubmitComplaintInput): Promise<string> {
    if (input.subjectType === 'store') {
      if (!input.subjectId) throw new ComplaintNotAllowedException('subject_not_found');
      const storeId = input.subjectId;
      const tenantId = await this.read((tx) => this.repo.storeTenant(tx, storeId));
      if (!tenantId) throw new ComplaintNotAllowedException('subject_not_found');
      return tenantId;
    }
    if (input.postId) {
      const tenantId = await this.ownership.tenantOf(input.postId);
      if (!tenantId) throw new ComplaintNotAllowedException('subject_not_found');
      return tenantId;
    }
    return this.tenantId();
  }

  private read<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return mapBanErrors(() => this.tenantDb.transaction(work, { accessMode: 'read only' }));
  }

  private tenantId(): string {
    const tenantId = this.context.require().tenantId;
    if (!tenantId) throw new TenantRequiredException();
    return tenantId;
  }
}

function view(r: ComplaintQueueRow): ComplaintQueue['items'][number] {
  return {
    id: r.id,
    reference: r.reference_code,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    subjectUserId: r.subject_user_id,
    subjectName: r.subject_name,
    subjectBanSeverity: r.subject_ban_severity,
    reporterName: r.reporter_name,
    category: r.category_code,
    priority: r.priority_code,
    status: r.status_code,
    description: r.description,
    evidence: r.evidence_refs,
    assignedToUserId: r.assigned_to_user_id,
    assignedToName: r.assigned_to_name,
    dueAt: r.due_at,
    overdue: r.overdue,
    createdAt: r.created_at,
    resolution: r.resolution,
    resolvedAt: r.resolved_at,
    banId: r.ban_id,
  };
}
