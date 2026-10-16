import { Inject, Injectable } from '@nestjs/common';
import { UnauthenticatedException } from '../auth/exceptions/auth.exceptions';
import { sqlStateOf } from '../common/utils/sql-state';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { parseVariants } from '../media/media.types';
import { isStaffRole } from '../posts/post-visibility';
import { SettingsService } from '../settings/settings.service';
import { STORAGE_SERVICE, type StorageService } from '../storage/storage.ports';
import { counts, sumMoney, targetsOf, toTask } from './agent-work.service';
import {
  AgentAdminOnlyException,
  AgentAlreadyExistsException,
  AgentNotFoundException,
  AgentTaskNotFoundException,
} from './agents.exceptions';
import { AgentsRepository, type OutcomeRow } from './agents.repository';
import type {
  AgentList,
  CommissionReport,
  CreateAgentInput,
  CreateTaskInput,
  DayQuery,
  PeriodQuery,
  SubmissionDay,
  UpdateAgentInput,
} from './dto/agents.dto';

const UNIQUE_VIOLATION = '23505';
// The roles that may change agents, rates and targets (field_agents' RLS: tenant admins).
const ADMIN_ROLES: ReadonlySet<string> = new Set([
  'tenant_admin',
  'partner_owner',
  'platform_admin',
]);

/**
 * The area team's side of field agent mode (ADR 066): agents with today's and
 * this week's numbers and approval rate, targets and rates, tasks, a day's
 * submissions (the map and the review list — decisions go through the places
 * review queue), and the commission report (calculation only).
 */
@Injectable()
export class AgentsAdminService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: AgentsRepository,
    private readonly settings: SettingsService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  async list(): Promise<AgentList> {
    const tenantId = this.requireStaff();
    const startIsoDay = await this.settings.get('agent_stats_week_start_iso_day', tenantId);
    return this.tenantDb.transaction(
      async (tx) => {
        const day = await this.repo.dayBounds(tx, null);
        const week = await this.repo.weekBounds(tx, day.day, startIsoDay);
        const [agents, rows, candidates] = await Promise.all([
          this.repo.listAgents(tx),
          this.repo.outcomes(tx, null, week.from, week.to),
          this.repo.candidates(tx),
        ]);
        const byAgent = groupBy(rows, (r) => r.field_agent_id);
        return {
          date: day.day,
          items: agents.map((a) => {
            const mine = byAgent.get(a.id) ?? [];
            const today = mine.filter((r) => r.created_at >= day.from && r.created_at < day.to);
            const w = counts(mine);
            const decided = w.approved + w.rejected;
            return {
              id: a.id,
              memberId: a.member_id,
              code: a.agent_code,
              name: a.name,
              status: a.status_code,
              commissionRate: a.commission_rate,
              targets: targetsOf(a),
              today: counts(today),
              week: w,
              approvalRate: decided === 0 ? null : w.approved / decided,
              flagged: mine.filter((r) => r.fraud_flags.length > 0).length,
            };
          }),
          candidates: candidates.map((c) => ({ memberId: c.member_id, name: c.name })),
        };
      },
      { accessMode: 'read only' },
    );
  }

  async create(input: CreateAgentInput): Promise<{ id: string }> {
    this.requireAdmin();
    try {
      return await this.tenantDb.transaction(async (tx) => {
        if (!(await this.repo.memberIsAgent(tx, input.memberId)))
          throw new AgentNotFoundException();
        return { id: await this.repo.createAgent(tx, input) };
      });
    } catch (error) {
      if (sqlStateOf(error) === UNIQUE_VIOLATION) throw new AgentAlreadyExistsException();
      throw error;
    }
  }

  async update(id: string, input: UpdateAgentInput): Promise<void> {
    this.requireAdmin();
    const ok = await this.tenantDb.transaction((tx) => this.repo.updateAgent(tx, id, input));
    if (!ok) throw new AgentNotFoundException();
  }

  async tasks(agentId: string) {
    this.requireStaff();
    return this.tenantDb.transaction(
      async (tx) => {
        if (!(await this.repo.agentExists(tx, agentId))) throw new AgentNotFoundException();
        return { items: (await this.repo.tasksFor(tx, agentId, null)).map(toTask) };
      },
      { accessMode: 'read only' },
    );
  }

  async createTask(agentId: string, input: CreateTaskInput): Promise<{ id: string }> {
    this.requireStaff();
    const userId = this.context.require().userId!;
    return this.tenantDb.transaction(async (tx) => {
      if (!(await this.repo.agentExists(tx, agentId))) throw new AgentNotFoundException();
      return { id: await this.repo.createTask(tx, agentId, input, userId) };
    });
  }

  async setTaskStatus(taskId: string, status: 'open' | 'cancelled'): Promise<void> {
    this.requireStaff();
    const ok = await this.tenantDb.transaction((tx) => this.repo.setTaskStatus(tx, taskId, status));
    if (!ok) throw new AgentTaskNotFoundException();
  }

  /** A day's submissions (today by default), with where, what, flags and photos. */
  async day(query: DayQuery): Promise<SubmissionDay> {
    this.requireStaff();
    const limit = await this.settings.get('agent_list_page_size_max');
    return this.tenantDb.transaction(
      async (tx) => {
        const day = await this.repo.dayBounds(tx, query.date ?? null);
        const rows = await this.repo.submissionsBetween(
          tx,
          day.from,
          day.to,
          query.agentId ?? null,
          limit,
        );
        const outcomes = new Map(
          (await this.repo.outcomes(tx, query.agentId ?? null, day.from, day.to)).map((o) => [
            o.submission_id,
            o,
          ]),
        );
        const media = new Map(
          (
            await this.repo.media(
              tx,
              rows.flatMap((r) => r.photo_media_ids),
            )
          ).map((m) => [m.id, m]),
        );
        return {
          date: day.day,
          items: rows.map((r) => {
            const o = outcomes.get(r.id);
            return {
              id: r.id,
              agentId: r.field_agent_id,
              agentCode: r.agent_code,
              kind: r.kind_code,
              capturedAt: r.captured_at.toISOString(),
              location: { lat: r.lat, lng: r.lng },
              accuracyM: r.accuracy_m,
              placeId: r.place_id,
              placeEditSuggestionId: r.place_edit_suggestion_id,
              name: o?.name ?? null,
              reviewStatus: o?.review_status ?? 'pending',
              reasonCode: o?.reason_code ?? null,
              fraudFlags: r.fraud_flags,
              fraudDetail: r.fraud_detail,
              phoneCheck: r.phone_check_status,
              photos: r.photo_media_ids.map((id) => {
                const variants = parseVariants(media.get(id)?.variants);
                return {
                  id,
                  url: variants ? this.storage.getPublicUrl('media', variants.card.key) : null,
                };
              }),
              notes: r.notes,
            };
          }),
        };
      },
      { accessMode: 'read only' },
    );
  }

  /** Estimated commission per agent for [from, to] (the area's days). Calculation only. */
  async commissions(query: PeriodQuery): Promise<CommissionReport> {
    const tenantId = this.requireStaff();
    const perShop = await this.settings.get('agent_commission_per_shop', tenantId);
    return this.tenantDb.transaction(
      async (tx) => {
        const from = await this.repo.dayBounds(tx, query.from);
        const to = await this.repo.dayBounds(tx, query.to);
        const [agents, rows] = await Promise.all([
          this.repo.listAgents(tx),
          this.repo.outcomes(tx, null, from.from, to.to),
        ]);
        const byAgent = groupBy(rows, (r) => r.field_agent_id);
        const items = agents
          .map((a) => {
            const mine = byAgent.get(a.id) ?? [];
            const approved = (kind: string) =>
              mine.filter((r) => r.review_status === 'approved' && r.kind_code === kind).length;
            return {
              agentId: a.id,
              agentCode: a.agent_code,
              name: a.name,
              rate: a.commission_rate ?? perShop,
              newShops: approved('new_shop'),
              verifications: approved('verify_shop'),
              updates: approved('update_info'),
              rejected: mine.filter((r) => r.review_status === 'rejected').length,
              pending: mine.filter((r) => r.review_status === 'pending').length,
              amount: sumMoney(mine.map((r) => r.commission)),
            };
          })
          .filter((i) => i.newShops + i.verifications + i.updates + i.rejected + i.pending > 0);
        return { from: from.day, to: to.day, items, total: sumMoney(items.map((i) => i.amount)) };
      },
      { accessMode: 'read only' },
    );
  }

  private requireStaff(): string {
    const { tenantId, userId, role } = this.context.require();
    if (!userId) throw new UnauthenticatedException();
    if (!tenantId || !isStaffRole(role)) throw new AgentAdminOnlyException();
    return tenantId;
  }

  private requireAdmin(): string {
    const tenantId = this.requireStaff();
    if (!ADMIN_ROLES.has(this.context.require().role ?? '')) throw new AgentAdminOnlyException();
    return tenantId;
  }
}

function groupBy(
  rows: readonly OutcomeRow[],
  key: (r: OutcomeRow) => string,
): Map<string, OutcomeRow[]> {
  const out = new Map<string, OutcomeRow[]>();
  for (const r of rows) out.set(key(r), [...(out.get(key(r)) ?? []), r]);
  return out;
}
