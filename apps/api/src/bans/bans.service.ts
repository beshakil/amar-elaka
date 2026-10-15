import { Injectable } from '@nestjs/common';
import { BanStateService } from '../auth/ban-state.service';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { TenantRequiredException } from '../database/tenant.exceptions';
import { SettingsService } from '../settings/settings.service';
import { BAN_DEEP_LINKS, BanNotifier } from './ban-notifier';
import { mapBanErrors, pageSize } from './bans-errors';
import { BanNotAllowedException } from './bans.exceptions';
import { BansRepository, type BanRow } from './bans.repository';
import type {
  BanList,
  BanListQuery,
  BanMemberLookup,
  IssueBanInput,
  IssuedBan,
} from './dto/bans.dto';

/**
 * An area's bans (ADR 063): its moderators issue temporary ones along the
 * ladder, its admins also permanent ones and lifts. The rules are issue_ban /
 * lift_ban's (0059); here the person's cached state is cleared at once and
 * they are told — reference, how long, which area.
 */
@Injectable()
export class BansService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: BansRepository,
    private readonly state: BanStateService,
    private readonly notifier: BanNotifier,
    private readonly settings: SettingsService,
  ) {}

  async list(query: BanListQuery): Promise<BanList> {
    const tenantId = this.tenantId();
    const limit = pageSize(
      query.limit,
      await this.settings.get('appeal_queue_page_size_max', tenantId),
    );
    const items = await this.read((tx) =>
      this.repo.list(tx, query.active !== 'false', query.after ?? null, limit),
    );
    return {
      items: items.map(banView),
      nextAfter: items.length === limit ? items[items.length - 1]!.id : null,
    };
  }

  async findMember(phone: string): Promise<BanMemberLookup> {
    this.tenantId();
    const rows = await this.read((tx) => this.repo.findMember(tx, phone));
    return {
      items: rows.map((r) => ({
        userId: r.user_id,
        displayName: r.display_name,
        role: r.role_code,
        banSeverity: r.ban_severity_code,
        priorBans: r.prior_bans,
      })),
    };
  }

  async issue(input: IssueBanInput): Promise<IssuedBan> {
    const tenantId = this.tenantId();
    if (
      input.reasonText.length > (await this.settings.get('ban_reason_text_max_length', tenantId))
    ) {
      throw new BanNotAllowedException('reason_too_long');
    }
    const issued = await mapBanErrors(() =>
      this.tenantDb.transaction(async (tx) => {
        const row = await this.repo.issue(tx, {
          userId: input.userId,
          severity: input.severity,
          reasonCode: input.reasonCode,
          reasonText: input.reasonText,
          evidence: input.evidence,
          durationDays: input.durationDays ?? null,
          permanent: input.permanent ?? false,
          overrideReason: input.overrideReason ?? null,
        });
        // A ban issued from a complaint resolves it, in the same transaction.
        if (input.complaintId) {
          await this.repo.resolveComplaint(
            tx,
            input.complaintId,
            `ban ${row.reference_code}`,
            row.id,
          );
        }
        return row;
      }),
    );
    await this.state.invalidate(input.userId);
    await this.notifier.toUser(
      input.userId,
      'ban_issued',
      tenantId,
      { areaName: issued.area_name_bn, until: issued.expires_at, reference: issued.reference_code },
      BAN_DEEP_LINKS.account,
      issued.id,
      `ban_issued:${issued.id}`,
    );
    return {
      id: issued.id,
      reference: issued.reference_code,
      startsAt: issued.starts_at,
      expiresAt: issued.expires_at,
      permanent: issued.is_permanent,
      escalationStep: issued.escalation_step,
    };
  }

  async lift(id: string, reason: string): Promise<{ status: 'revoked' }> {
    const tenantId = this.tenantId();
    const lifted = await mapBanErrors(() =>
      this.tenantDb.transaction((tx) => this.repo.lift(tx, id, reason)),
    );
    await this.state.invalidate(lifted.user_id);
    await this.notifier.toUser(
      lifted.user_id,
      'ban_lifted',
      tenantId,
      { reference: lifted.reference_code },
      BAN_DEEP_LINKS.account,
      id,
      `ban_lifted:${id}`,
    );
    return { status: 'revoked' };
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

function banView(r: BanRow): BanList['items'][number] {
  return {
    id: r.id,
    reference: r.reference_code,
    userId: r.user_id,
    displayName: r.display_name,
    severity: r.severity_code,
    reasonCode: r.reason_code,
    reasonText: r.reason_text,
    evidence: r.evidence_refs,
    permanent: r.is_permanent,
    startsAt: r.starts_at,
    expiresAt: r.expires_at,
    escalationStep: r.escalation_step,
    status: r.status_code,
    bannedByName: r.banned_by_name,
    revokeReason: r.revoke_reason,
    openAppeal: r.open_appeal,
  };
}
