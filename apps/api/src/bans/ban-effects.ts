import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { BanStateService } from '../auth/ban-state.service';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { TrustScoreService } from '../trust/trust-score.service';

/**
 * What follows any change to a person's bans in an area (issued, lifted,
 * expired, appeal decided) — one place for it (Month 3 review):
 *  - the cached ban state is dropped, so the next request sees the change;
 *  - the member's trust is recomputed now (trust_penalty_per_ban), because the
 *    feed and the "trusted" badge read the stored score: marking it stale alone
 *    left a banned seller ranked as before until some other path recomputed.
 * The ban is already committed; a failed recompute is logged, never thrown
 * (the score stays marked for recompute by issue_ban()).
 */
@Injectable()
export class BanEffects {
  private readonly logger = new Logger(BanEffects.name);

  constructor(
    private readonly state: BanStateService,
    private readonly trust: TrustScoreService,
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
  ) {}

  async changed(userId: string, tenantId: string | null): Promise<void> {
    await this.state.invalidate(userId);
    if (!tenantId) return; // a platform-wide entry: no area score to move
    try {
      const memberId = await this.context.run({ role: 'system', tenantId }, () =>
        this.tenantDb.transaction(
          async (tx) => {
            const rows = await tx.execute(sql`
              select id from public.tenant_members
              where tenant_id = ${tenantId}::uuid and user_id = ${userId}::uuid and deleted_at is null`);
            return ([...rows][0] as { id: string } | undefined)?.id;
          },
          { accessMode: 'read only' },
        ),
      );
      if (memberId) await this.trust.recompute(tenantId, memberId);
    } catch (error) {
      this.logger.warn(`trust not recomputed after a ban change: ${String(error)}`);
    }
  }
}
