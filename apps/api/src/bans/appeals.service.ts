import { createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { BanStateService } from '../auth/ban-state.service';
import { UnauthenticatedException } from '../auth/exceptions/auth.exceptions';
import { OtpService } from '../auth/otp/otp.service';
import { CacheService } from '../cache/cache.service';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { SettingsService } from '../settings/settings.service';
import { BAN_DEEP_LINKS, BanNotifier } from './ban-notifier';
import { mapBanErrors, pageSize } from './bans-errors';
import { AppealNotAllowedException, AppealVerificationFailedException } from './bans.exceptions';
import {
  BansRepository,
  type AppealCreatedRow,
  type NoticeRow,
  type QueueRow,
} from './bans.repository';
import type {
  AccountAppealInput,
  AccountAppeals,
  AppealDecisionInput,
  AppealOtpAccepted,
  AppealDecisionResult,
  AppealQueue,
  AppealQueueQuery,
  AppealSubmitted,
  BanNotice,
  BanNotices,
  PublicAppealStatus,
  PublicAppealSubmitInput,
} from './dto/bans.dto';

// One OTP slot for the public appeal path (bound to the phone by OtpService).
const APPEAL_OTP = { kind: 'appeal', scope: 'public' } as const;
// settings-exempt: bytes of randomness in an appeal token (a capability size, not a business rule)
const TOKEN_BYTES = 32;

/**
 * Appeals (ADR 063, schema.md §9.9–§9.10). Two doors, one rule
 * (appeal_create, 0059: one appeal per ban, appeal_rate_limit_per_day per
 * phone, routing):
 *  - in-app: a restricted or banned session appeals its own bans;
 *  - public: a terminated person (no session) proves the phone by OTP. The
 *    request never says whether a phone has a ban; /status answers only
 *    after the code, with a short-lived appeal-only token so /submit needs no
 *    second SMS.
 * Decisions: an area's admins first (grant/reduce final, uphold only
 * recommends), the platform finally; escalation after appeal_escalation_days.
 */
@Injectable()
export class AppealsService {
  private readonly logger = new Logger(AppealsService.name);

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: BansRepository,
    private readonly otp: OtpService,
    private readonly cache: CacheService,
    private readonly settings: SettingsService,
    private readonly state: BanStateService,
    private readonly notifier: BanNotifier,
  ) {}

  // ---- the person's side ----

  async notices(): Promise<BanNotices> {
    this.requireUser();
    const rows = await this.read((tx) => this.repo.myNotices(tx));
    return { items: rows.map(noticeView) };
  }

  async myAppeals(): Promise<AccountAppeals> {
    this.requireUser();
    const rows = await this.read((tx) => this.repo.myAppeals(tx));
    return {
      items: rows.map((r) => ({
        id: r.id,
        reference: r.public_reference,
        status: r.status_code,
        targetReference: r.target_reference,
        submittedAt: r.submitted_at,
        decidedAt: r.decided_at,
      })),
    };
  }

  async submitInApp(input: AccountAppealInput): Promise<AppealSubmitted> {
    this.requireUser();
    const created = await mapBanErrors(() =>
      this.tenantDb.transaction((tx) => this.repo.submitInApp(tx, input.targetId, input.statement)),
    );
    await this.announce(created);
    return { id: created.id, reference: created.public_reference, status: created.status_code };
  }

  // ---- the public path ----

  /**
   * Always the same answer; an SMS goes out only if the phone has something
   * to appeal. The cooldown is shared with sign-in (per phone, against SMS
   * bombing), so the app times its resend button from resendAfterSeconds.
   */
  async requestOtp(phone: string, ip: string): Promise<AppealOtpAccepted> {
    try {
      const items = await this.asPublic((tx) => this.repo.publicStatus(tx, phone));
      if (items.length > 0) await this.otp.requestOtp(phone, ip, APPEAL_OTP);
    } catch (error) {
      // Cooldowns and limits included: telling them apart would reveal the phone has a ban.
      this.logger.debug(`appeal OTP not sent: ${String(error)}`);
    }
    return {
      status: 'accepted',
      resendAfterSeconds: await this.settings.get('otp_resend_cooldown_seconds'),
    };
  }

  async status(phone: string, code: string): Promise<PublicAppealStatus> {
    await this.otp.verifyOtp(phone, code, APPEAL_OTP);
    const rows = await this.asPublic((tx) => this.repo.publicStatus(tx, phone));
    const ttl = await this.settings.get('appeal_public_token_ttl_seconds');
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    await this.cache.setText(tokenKey(token), phone, ttl);
    return {
      items: rows.map(noticeView),
      appealsLeftToday:
        rows[0]?.appeals_left_today ?? (await this.settings.get('appeal_rate_limit_per_day')),
      appealToken: token,
      appealTokenExpiresInSeconds: ttl,
    };
  }

  async submitPublic(
    input: PublicAppealSubmitInput,
    ip: string,
    userAgent: string | undefined,
  ): Promise<AppealSubmitted> {
    if (input.otp) {
      await this.otp.verifyOtp(input.phone, input.otp, APPEAL_OTP);
    } else if (input.appealToken) {
      const phone = await this.cache.getText(tokenKey(input.appealToken));
      if (phone !== input.phone) throw new AppealVerificationFailedException();
    } else {
      throw new AppealVerificationFailedException();
    }
    const created = await this.asPublic((tx) =>
      this.repo.publicSubmit(tx, {
        phone: input.phone,
        reference: input.reference,
        statement: input.statement,
        ip,
        userAgent: userAgent ?? null,
      }),
    );
    if (input.appealToken) await this.cache.del(tokenKey(input.appealToken));
    await this.announce(created);
    return { id: created.id, reference: created.public_reference, status: created.status_code };
  }

  // ---- the deciders ----

  async queue(scope: 'area' | 'platform', query: AppealQueueQuery): Promise<AppealQueue> {
    const limit = pageSize(query.limit, await this.settings.get('appeal_queue_page_size_max'));
    const rows = await this.read((tx) => this.repo.queue(tx, scope, query.after ?? null, limit));
    return {
      items: rows.map(queueView),
      nextAfter: rows.length === limit ? rows[rows.length - 1]!.id : null,
    };
  }

  async decide(id: string, input: AppealDecisionInput): Promise<AppealDecisionResult> {
    if (input.decision === 'reduce' && !input.reducedUntil)
      throw new AppealNotAllowedException('reduce_until');
    const decided = await mapBanErrors(() =>
      this.tenantDb.transaction((tx) =>
        this.repo.decideAppeal(
          tx,
          id,
          input.decision,
          input.note ?? null,
          input.reducedUntil ?? null,
        ),
      ),
    );
    if (decided.status_code === 'escalated') {
      // The area recommended upholding: the platform decides.
      await this.notifier.toStaff(
        'platform_admins',
        null,
        'appeal_received',
        { reference: decided.public_reference, escalated: 'true' },
        BAN_DEEP_LINKS.appealsPlatform,
        id,
        `appeal_escalated:${id}`,
      );
    } else {
      await this.state.invalidate(decided.user_id);
      await this.notifier.toUser(
        decided.user_id,
        'appeal_decided',
        decided.tenant_id,
        {
          reference: decided.public_reference,
          granted: decided.status_code === 'granted' ? 'true' : null,
          reduced: decided.status_code === 'reduced' ? 'true' : null,
          upheld: decided.status_code === 'upheld' ? 'true' : null,
        },
        BAN_DEEP_LINKS.account,
        id,
        `appeal_decided:${id}`,
      );
    }
    return {
      status: decided.status_code,
      replacementReference: decided.replacement_reference,
      replacementUntil: decided.replacement_until,
    };
  }

  /** New appeal: the area's admins, or the platform for a global one. */
  private async announce(created: AppealCreatedRow): Promise<void> {
    const toArea = created.queue_code === 'tenant_admin';
    await this.notifier.toStaff(
      toArea ? 'area_admins' : 'platform_admins',
      created.tenant_id,
      'appeal_received',
      { reference: created.public_reference, escalated: null },
      toArea ? BAN_DEEP_LINKS.appealsArea : BAN_DEEP_LINKS.appealsPlatform,
      created.id,
      `appeal_received:${created.id}`,
    );
  }

  private asPublic<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return mapBanErrors(() =>
      this.context.run({ role: 'appeal_public' }, () => this.tenantDb.transaction(work)),
    );
  }

  private read<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return mapBanErrors(() => this.tenantDb.transaction(work, { accessMode: 'read only' }));
  }

  private requireUser(): string {
    const userId = this.context.require().userId;
    if (!userId) throw new UnauthenticatedException();
    return userId;
  }
}

/** Only a hash of the token is a Redis key. */
const tokenKey = (token: string) =>
  `appeal:token:${createHash('sha256').update(token).digest('hex')}`;

export function noticeView(r: NoticeRow): BanNotice {
  return {
    kind: r.kind,
    id: r.id,
    reference: r.reference_code,
    severity: r.severity_code,
    reasonCode: r.reason_code,
    areaName: r.area_name_bn ? { bn: r.area_name_bn, en: r.area_name_en } : null,
    startsAt: r.starts_at,
    expiresAt: r.expires_at,
    permanent: r.is_permanent,
    appeal:
      r.appeal_id && r.appeal_reference && r.appeal_status
        ? {
            id: r.appeal_id,
            reference: r.appeal_reference,
            // The person sees "waiting" until it is final: an escalation is internal.
            status:
              r.appeal_status === 'in_review' || r.appeal_status === 'escalated'
                ? 'submitted'
                : r.appeal_status,
          }
        : null,
    canAppeal: r.can_appeal,
  };
}

function queueView(r: QueueRow): AppealQueue['items'][number] {
  return {
    id: r.id,
    reference: r.public_reference,
    status: r.status_code,
    queue: r.queue_code,
    channel: r.channel_code,
    statement: r.statement,
    submittedAt: r.submitted_at,
    escalateAt: r.escalate_at,
    escalatedAt: r.escalated_at,
    escalationReason: r.escalation_reason,
    tenantRecommendation: r.tenant_recommendation,
    tenantNote: r.tenant_note,
    kind: r.kind,
    targetId: r.target_id,
    targetReference: r.target_reference,
    severity: r.severity_code,
    reasonCode: r.reason_code,
    reasonText: r.reason_text,
    evidence: r.evidence_refs,
    permanent: r.is_permanent,
    expiresAt: r.expires_at,
    areaName: r.area_name_bn,
    appellantUserId: r.appellant_user_id,
    appellantName: r.appellant_name,
  };
}
