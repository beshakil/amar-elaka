import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { sqlStateOf } from '../common/utils/sql-state';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { TenantRequiredException } from '../database/tenant.exceptions';
import { SettingsService } from '../settings/settings.service';
import { ChatReportNotFoundException } from './chat.exceptions';
import { ChatRepository, type ReportQueueRow } from './chat.repository';
import {
  transcriptEntrySchema,
  type ChatReportDecision,
  type ChatReportDecisionResult,
  type ChatReportDetail,
  type ChatReportQueue,
  type ChatReportQueueItem,
  type ChatReportQueueQuery,
} from './dto/chat.dto';
import { ChatBroadcaster, SERVER_EVENTS } from './realtime/chat-broadcaster';

const NO_DATA_FOUND = 'P0002';

const isoTimestamp = z.string().transform((v) => new Date(v).toISOString());
const storedTranscriptEntry = transcriptEntrySchema.extend({
  createdAt: isoTimestamp,
  deletedAt: isoTimestamp.nullable(),
});

/**
 * The moderators' side of chat reports (ADR 058): the queue of open
 * conversation reports in their tenant, a report with its transcript
 * snapshot (the only way staff ever see a conversation — Q13), and the
 * decision. Locking writes moderation_actions in the same transaction as
 * the lock (decide_conversation_report, CLAUDE.md rule 13), then the
 * participants' apps are told to refresh the conversation.
 */
@Injectable()
export class ChatReportsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: ChatRepository,
    private readonly settings: SettingsService,
    private readonly broadcaster: ChatBroadcaster,
  ) {}

  async queue(query: ChatReportQueueQuery): Promise<ChatReportQueue> {
    const tenantId = this.tenantId();
    const max = await this.settings.get('chat_inbox_page_size_max', tenantId);
    const limit = Math.min(query.limit ?? max, max);
    const rows = await this.tenantDb.transaction(
      (tx) =>
        this.repo.reportQueue(tx, {
          ...(query.before ? { before: query.before } : {}),
          limit: limit + 1,
        }),
      { accessMode: 'read only' },
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map(toItem),
      nextBefore: rows.length > limit ? (page[page.length - 1]?.report_id ?? null) : null,
    };
  }

  async detail(reportId: string): Promise<ChatReportDetail> {
    this.tenantId();
    const row = await this.tenantDb.transaction((tx) => this.repo.reportDetail(tx, reportId), {
      accessMode: 'read only',
    });
    if (!row) throw new ChatReportNotFoundException();
    return {
      ...toItem(row),
      capturedAt: row.captured_at,
      // jsonb timestamps come back as Postgres text ("2026-10-10T08:00:00.123+00:00"): ISO them.
      transcript: z.array(storedTranscriptEntry).parse(row.transcript),
    };
  }

  async decide(reportId: string, decision: ChatReportDecision): Promise<ChatReportDecisionResult> {
    const tenantId = this.tenantId();
    let decided: { conversationId: string; actionId: string };
    try {
      decided = await this.tenantDb.transaction((tx) =>
        this.repo.decideReport(
          tx,
          reportId,
          decision.decision,
          decision.reasonCode,
          decision.note ?? null,
        ),
      );
    } catch (error) {
      if (sqlStateOf(error) === NO_DATA_FOUND) throw new ChatReportNotFoundException();
      throw error;
    }
    if (decision.decision === 'lock') {
      // Staff aren't participants (no roster read): the roster is read as system.
      const participants = await this.context.run({ tenantId, role: 'system' }, () =>
        this.tenantDb.transaction((tx) => this.repo.participants(tx, decided.conversationId), {
          accessMode: 'read only',
        }),
      );
      this.broadcaster.toUsers(
        participants.map((p) => p.user_id),
        SERVER_EVENTS.conversationUpdated,
        { conversationId: decided.conversationId },
      );
    }
    return {
      reportId,
      conversationId: decided.conversationId,
      decision: decision.decision,
      moderationActionId: decided.actionId,
    };
  }

  private tenantId(): string {
    const tenantId = this.context.require().tenantId;
    if (!tenantId) throw new TenantRequiredException();
    return tenantId;
  }
}

function toItem(row: ReportQueueRow): ChatReportQueueItem {
  return {
    reportId: row.report_id,
    conversationId: row.conversation_id,
    reporterMemberId: row.reporter_member_id,
    reasonCode: row.reason_code,
    details: row.details,
    status: row.status_code,
    messageCount: row.message_count,
    createdAt: row.created_at,
  };
}
