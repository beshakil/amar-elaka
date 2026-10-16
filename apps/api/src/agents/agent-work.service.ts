import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { normalizeBdPhone } from '../auth/phone/phone-normalizer';
import { OtpService } from '../auth/otp/otp.service';
import { DomainException } from '../common/exceptions/domain-exception';
import { phoneHash } from '../common/utils/identifier-hash';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { PlacePhoneInvalidException } from '../places/places.exceptions';
import { SettingsService } from '../settings/settings.service';
import { AgentNotActiveException } from './agents.exceptions';
import {
  AgentsRepository,
  type AgentRow,
  type OutcomeRow,
  type TaskRow,
} from './agents.repository';
import type {
  AgentMe,
  AgentStats,
  AgentTask,
  AgentToday,
  OutcomeCounts,
  SubmissionOutcome,
} from './dto/agents.dto';

/** What the agent's stats list as "recent" (a screen's worth). */
// settings-exempt: presentation — how many decisions one screen shows.
const RECENT_MAX = 30;

export function toTask(t: TaskRow): AgentTask {
  return {
    id: t.id,
    type: t.type_code,
    title: t.title,
    status: t.status_code,
    dueOn: t.due_on,
    notes: t.notes,
    placeId: t.place_id,
    placeName: t.place_name,
    localityName: t.locality_name,
    location: t.lat !== null && t.lng !== null ? { lat: t.lat, lng: t.lng } : null,
    doneAt: t.done_at?.toISOString() ?? null,
  };
}

export function targetsOf(agent: {
  targets: { daily_shops?: number | undefined; weekly_shops?: number | undefined };
}) {
  return {
    dailyShops: agent.targets.daily_shops ?? null,
    weeklyShops: agent.targets.weekly_shops ?? null,
  };
}

// settings-exempt: poisha per taka, and the two decimals of numeric(12,2).
const POISHA = 100n;
// settings-exempt: see above
const DECIMALS = 2;

/** Money as strings, summed exactly in poisha (rule 2: never a float). */
export function sumMoney(amounts: readonly string[]): string {
  const total = amounts.reduce((acc, a) => {
    const [whole = '0', frac = ''] = a.split('.');
    return acc + BigInt(whole) * POISHA + BigInt(frac.padEnd(DECIMALS, '0').slice(0, DECIMALS));
  }, 0n);
  return `${total / POISHA}.${(total % POISHA).toString().padStart(DECIMALS, '0')}`;
}

export function counts(rows: readonly OutcomeRow[]): OutcomeCounts {
  return {
    submitted: rows.length,
    approved: rows.filter((r) => r.review_status === 'approved').length,
    rejected: rows.filter((r) => r.review_status === 'rejected').length,
    pending: rows.filter((r) => r.review_status === 'pending').length,
    commission: sumMoney(rows.map((r) => r.commission)),
  };
}

export function toOutcome(r: OutcomeRow): SubmissionOutcome {
  return {
    id: r.submission_id,
    kind: r.kind_code,
    capturedAt: r.captured_at.toISOString(),
    placeId: r.place_id,
    name: r.name,
    reviewStatus: r.review_status,
    reasonCode: r.reason_code,
    reasonText: r.reason_text,
    fraudFlags: r.fraud_flags,
    commission: r.commission,
  };
}

/** A wrong code: the shop's phone failed its check (counted as phone_otp_failed). */
class AgentPhoneCheckFailedException extends DomainException {
  readonly code = 'AGENT_PHONE_CHECK_FAILED';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor() {
    super('The code did not match.');
  }
}

/**
 * The agent's own side of field agent mode (ADR 066): who they are and what
 * the phone needs offline, today's route, their numbers, and checking a
 * shop's phone by OTP (before or after the capture syncs).
 */
@Injectable()
export class AgentWorkService {
  private readonly pepper: string;

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: AgentsRepository,
    private readonly settings: SettingsService,
    private readonly otp: OtpService,
    @Inject(APP_CONFIG) env: Pick<Env, 'NID_HASH_SECRET'>,
  ) {
    this.pepper = env.NID_HASH_SECRET;
  }

  async me(): Promise<AgentMe> {
    const agent = await this.agent();
    const tenantId = agent.tenant_id;
    const [minGpsAccuracyM, photosMax, captureMaxAgeDays] = await Promise.all([
      this.settings.get('agent_min_gps_accuracy_m', tenantId),
      this.settings.get('agent_capture_photos_max'),
      this.settings.get('agent_capture_max_age_days', tenantId),
    ]);
    return {
      agent: {
        id: agent.id,
        code: agent.agent_code,
        status: agent.status_code,
        targets: targetsOf(agent),
      },
      settings: { minGpsAccuracyM, photosMax, captureMaxAgeDays },
    };
  }

  /** Open tasks due by today, and those done today: the route and its counts. */
  async today(): Promise<AgentToday> {
    const agent = await this.agent();
    return this.tenantDb.transaction(
      async (tx) => {
        const day = await this.repo.dayBounds(tx, null);
        const tasks = (await this.repo.tasksFor(tx, agent.id, day)).map(toTask);
        const done = tasks.filter((t) => t.status === 'done').length;
        return { date: day.day, tasks, done, remaining: tasks.length - done };
      },
      { accessMode: 'read only' },
    );
  }

  async stats(): Promise<AgentStats> {
    const agent = await this.agent();
    const startIsoDay = await this.settings.get('agent_stats_week_start_iso_day', agent.tenant_id);
    return this.tenantDb.transaction(
      async (tx) => {
        const day = await this.repo.dayBounds(tx, null);
        const week = await this.repo.weekBounds(tx, day.day, startIsoDay);
        const rows = await this.repo.outcomes(tx, agent.id, week.from, week.to);
        const today = rows.filter((r) => r.created_at >= day.from && r.created_at < day.to);
        return {
          today: counts(today),
          week: counts(rows),
          weekStartsOn: week.day,
          targets: targetsOf(agent),
          recent: rows
            .filter((r) => r.review_status !== 'pending')
            .slice(0, RECENT_MAX)
            .map(toOutcome),
        };
      },
      { accessMode: 'read only' },
    );
  }

  /** Sends the shop's phone a code; the owner tells it to the agent. */
  async requestPhoneOtp(
    submissionId: string,
    raw: string,
    ip: string,
  ): Promise<{ resendAfterSeconds: number }> {
    const agent = await this.agent();
    const phone = this.phone(raw);
    await this.tenantDb.transaction((tx) =>
      this.repo.upsertPhoneCheck(tx, agent.id, submissionId, phoneHash(phone, this.pepper)),
    );
    return this.otp.requestOtp(phone, ip, { kind: 'agent_shop_phone', scope: submissionId });
  }

  /**
   * The code the owner read out. A wrong or expired code marks the check
   * failed (phone_otp_failed on the submission; a later right code clears it).
   */
  async verifyPhoneOtp(
    submissionId: string,
    raw: string,
    code: string,
  ): Promise<{ status: 'verified' | 'failed' }> {
    const agent = await this.agent();
    const phone = this.phone(raw);
    const hash = phoneHash(phone, this.pepper);
    let verified = true;
    let failure: unknown = null;
    try {
      await this.otp.verifyOtp(phone, code, { kind: 'agent_shop_phone', scope: submissionId });
    } catch (error) {
      verified = false;
      failure = error;
    }
    const status = await this.tenantDb.transaction((tx) =>
      this.repo.recordPhoneResult(tx, submissionId, hash, verified),
    );
    // Already synced: the submission carries the result (as the system: a capture is otherwise fixed).
    await this.context.run({ role: 'system', tenantId: agent.tenant_id }, () =>
      this.tenantDb.transaction(async (tx) => {
        const stored = await this.repo.findSubmission(tx, submissionId);
        if (!stored || stored.field_agent_id !== agent.id) return;
        if (status === 'failed')
          await this.repo.addFlag(tx, submissionId, 'phone_otp_failed', 'failed');
        else if (status === 'verified') await this.repo.setPhoneCheck(tx, submissionId, 'verified');
      }),
    );
    if (!verified) {
      if (failure instanceof DomainException) throw failure;
      throw new AgentPhoneCheckFailedException();
    }
    return { status: 'verified' };
  }

  private phone(raw: string): string {
    const phone = normalizeBdPhone(raw);
    if (!phone) throw new PlacePhoneInvalidException([raw]);
    return phone;
  }

  async agent(): Promise<AgentRow> {
    const agent = await this.tenantDb.transaction((tx) => this.repo.myAgent(tx), {
      accessMode: 'read only',
    });
    if (!agent || agent.status_code !== 'active') throw new AgentNotActiveException();
    return agent;
  }
}
