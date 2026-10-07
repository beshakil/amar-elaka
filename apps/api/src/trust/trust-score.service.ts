import { Injectable } from '@nestjs/common';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { SettingsService } from '../settings/settings.service';
import {
  computeTrust,
  nextAccountAgeStep,
  TRUST_ALGORITHM_VERSION,
  type TrustComponents,
  type TrustWeights,
} from './trust-formula';
import { TrustRepository } from './trust.repository';

export interface MemberTrust {
  /** The effective score: a platform override if set, else the computed one. */
  score: number;
  components: Record<string, number>;
}

/**
 * Member trust scores (per tenant_members row, 0–100; ADR 030).
 *
 * Event-driven, never a cron over every member:
 *  - moderation actions call recompute() right after they commit;
 *  - any other module whose event changes an input (ban issued, phone
 *    verified, report upheld) calls markStale(); the next read recomputes;
 *  - a member with no row yet is computed on first read;
 *  - time is an input too (account age): each save sets next_recompute_at to
 *    the next account-age step, so the first read after it recomputes.
 * Runs as `system`: the inputs include reports and bans the member can't see.
 */
@Injectable()
export class TrustScoreService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: TrustRepository,
    private readonly settings: SettingsService,
  ) {}

  async get(tenantId: string, memberId: string): Promise<MemberTrust> {
    const row = await this.asSystem(tenantId, (tx) => this.repo.current(tx, tenantId, memberId));
    if (row && !row.stale) {
      return { score: row.override_score ?? row.score, components: row.components };
    }
    const computed = await this.recompute(tenantId, memberId);
    return { score: row?.override_score ?? computed.score, components: computed.components };
  }

  async recompute(
    tenantId: string,
    memberId: string,
  ): Promise<{ score: number; components: TrustComponents }> {
    const weights = await this.weights(tenantId);
    return this.asSystem(tenantId, async (tx) => {
      const inputs = await this.repo.inputs(tx, tenantId, memberId);
      if (!inputs) throw new Error(`trust: no member ${memberId} in tenant ${tenantId}`);
      const now = new Date();
      const result = computeTrust(inputs, weights, now);
      await this.repo.save(tx, tenantId, memberId, {
        score: result.score,
        components: result.components,
        algorithmVersion: TRUST_ALGORITHM_VERSION,
        nextRecomputeAt: nextAccountAgeStep(inputs.memberSince, weights, now),
      });
      return result;
    });
  }

  /** For other modules: an input changed (e.g. a ban); the next read recomputes. */
  markStale(tenantId: string, memberId: string): Promise<void> {
    return this.asSystem(tenantId, (tx) => this.repo.markStale(tx, tenantId, memberId));
  }

  private async weights(tenantId: string): Promise<TrustWeights> {
    const get = (key: Parameters<SettingsService['get']>[0]) =>
      this.settings.get(key, tenantId) as Promise<number>;
    const [
      base,
      perApprovedPost,
      maxApprovedPoints,
      perRejectedPost,
      perRemovedPost,
      perUpheldReport,
      perAccountMonth,
      maxAccountAgePoints,
      phoneVerified,
      storeVerified,
      perBan,
      perApprovedEdit,
      maxApprovedEditPoints,
    ] = await Promise.all([
      get('trust_base_score'),
      get('trust_points_per_approved_post'),
      get('trust_max_approved_points'),
      get('trust_penalty_per_rejected_post'),
      get('trust_penalty_per_removed_post'),
      get('trust_penalty_per_upheld_report'),
      get('trust_points_per_account_month'),
      get('trust_max_account_age_points'),
      get('trust_points_phone_verified'),
      get('trust_points_store_verified'),
      get('trust_penalty_per_ban'),
      get('trust_points_per_approved_edit'),
      get('trust_max_approved_edit_points'),
    ]);
    return {
      base,
      perApprovedPost,
      maxApprovedPoints,
      perRejectedPost,
      perRemovedPost,
      perUpheldReport,
      perAccountMonth,
      maxAccountAgePoints,
      phoneVerified,
      storeVerified,
      perBan,
      perApprovedEdit,
      maxApprovedEditPoints,
    };
  }

  private asSystem<T>(tenantId: string, work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.context.run({ tenantId, role: 'system' }, () => this.tenantDb.transaction(work));
  }
}
