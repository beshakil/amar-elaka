import { Inject, Injectable } from '@nestjs/common';
import { BanStateService } from '../auth/ban-state.service';
import { phoneHash } from '../common/utils/identifier-hash';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { TenantRequiredException } from '../database/tenant.exceptions';
import { SettingsService } from '../settings/settings.service';
import { BAN_DEEP_LINKS, BanNotifier } from './ban-notifier';
import { mapBanErrors, pageSize } from './bans-errors';
import { BansRepository, type BlacklistRow } from './bans.repository';
import type {
  BlacklistDecisionInput,
  BlacklistPage,
  BlacklistQuery,
  RecommendBlacklistInput,
} from './dto/bans.dto';

/**
 * Global blacklist governance (ADR 063, schema.md §9.6): an area's admins
 * only recommend; platform_admin approves or rejects, and approval takes
 * effect in every area at once. On approval the person's phone is hashed
 * here (HMAC, the server-side pepper) so the entry can match a new account
 * on the same number at sign-up — the number itself is never stored.
 */
@Injectable()
export class BlacklistService {
  private readonly pepper: string;

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: BansRepository,
    private readonly state: BanStateService,
    private readonly notifier: BanNotifier,
    private readonly settings: SettingsService,
    @Inject(APP_CONFIG) env: Pick<Env, 'NID_HASH_SECRET'>,
  ) {
    this.pepper = env.NID_HASH_SECRET;
  }

  async recommend(input: RecommendBlacklistInput): Promise<{ id: string; reference: string }> {
    const tenantId = this.context.require().tenantId;
    if (!tenantId) throw new TenantRequiredException();
    const created = await mapBanErrors(() =>
      this.tenantDb.transaction(async (tx) => ({
        entry: await this.repo.recommend(tx, {
          userId: input.userId,
          reasonCode: input.reasonCode,
          severity: input.severity,
          summary: input.summary,
          evidence: input.evidence,
          expiresAt: input.expiresAt ?? null,
        }),
        areaName: await this.repo.areaName(tx),
      })),
    );
    await this.notifier.toStaff(
      'platform_admins',
      null,
      'blacklist_recommended',
      { areaName: created.areaName, reference: created.entry.reference_code },
      BAN_DEEP_LINKS.blacklist,
      created.entry.id,
      `blacklist_recommended:${created.entry.id}`,
    );
    return { id: created.entry.id, reference: created.entry.reference_code };
  }

  async page(scope: 'area' | 'platform', query: BlacklistQuery): Promise<BlacklistPage> {
    const limit = pageSize(query.limit, await this.settings.get('appeal_queue_page_size_max'));
    const rows = await this.read((tx) =>
      this.repo.blacklistPage(tx, scope, query.status ?? null, query.after ?? null, limit),
    );
    return {
      items: rows.map(view),
      nextAfter: rows.length === limit ? rows[rows.length - 1]!.id : null,
    };
  }

  async decide(
    id: string,
    input: BlacklistDecisionInput,
  ): Promise<{ status: BlacklistRow['status_code'] }> {
    const decided = await mapBanErrors(() =>
      this.tenantDb.transaction(async (tx) => {
        const phone = input.decision === 'approve' ? await this.repo.subjectPhone(tx, id) : null;
        return this.repo.decideBlacklist(
          tx,
          id,
          input.decision,
          input.note ?? null,
          phone ? phoneHash(phone, this.pepper) : null,
        );
      }),
    );
    if (decided.status_code === 'active' && decided.user_id) {
      await this.state.invalidate(decided.user_id);
      if (decided.severity_code !== 'watch') {
        await this.notifier.toUser(
          decided.user_id,
          'ban_issued',
          null,
          { areaName: null, until: decided.expires_at, reference: decided.reference_code },
          BAN_DEEP_LINKS.account,
          id,
          `ban_issued:${id}`,
        );
      }
    }
    return { status: decided.status_code };
  }

  async revoke(id: string, reason: string): Promise<{ status: 'revoked' }> {
    const revoked = await mapBanErrors(() =>
      this.tenantDb.transaction((tx) => this.repo.revokeBlacklist(tx, id, reason)),
    );
    if (revoked.user_id) {
      await this.state.invalidate(revoked.user_id);
      await this.notifier.toUser(
        revoked.user_id,
        'ban_lifted',
        null,
        { reference: revoked.reference_code },
        BAN_DEEP_LINKS.account,
        id,
        `ban_lifted:${id}`,
      );
    }
    return { status: 'revoked' };
  }

  private read<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return mapBanErrors(() => this.tenantDb.transaction(work, { accessMode: 'read only' }));
  }
}

function view(r: BlacklistRow): BlacklistPage['items'][number] {
  return {
    id: r.id,
    reference: r.reference_code,
    userId: r.user_id,
    displayName: r.display_name,
    reasonCode: r.reason_code,
    severity: r.severity_code,
    status: r.status_code,
    summary: r.summary,
    evidence: r.evidence_refs,
    expiresAt: r.expires_at,
    sourceAreaName: r.source_area_name_bn,
    recommendedByName: r.recommended_by_name,
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
    reviewNote: r.review_note,
  };
}
