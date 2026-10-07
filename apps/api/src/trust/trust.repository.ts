import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import type { TrustComponents, TrustInputs } from './trust-formula';

const SCORE_ROW = z.object({
  score: z.number(),
  override_score: z.number().nullable(),
  components: z.record(z.number()),
  stale: z.boolean(),
});

/** Runs in a `system` context: the inputs include reports and bans no member may read. */
@Injectable()
export class TrustRepository {
  async current(
    tx: DatabaseTransaction,
    tenantId: string,
    memberId: string,
  ): Promise<z.infer<typeof SCORE_ROW> | undefined> {
    const rows = await tx.execute(sql`
      select score, override_score, components,
             (next_recompute_at is not null and next_recompute_at <= now()) as stale
      from public.member_trust_scores
      where tenant_id = ${tenantId}::uuid and member_id = ${memberId}::uuid`);
    return z
      .array(SCORE_ROW)
      .max(1)
      .parse([...rows])[0];
  }

  async inputs(
    tx: DatabaseTransaction,
    tenantId: string,
    memberId: string,
  ): Promise<TrustInputs | undefined> {
    const rows = await tx.execute(sql`
      with m as (
        select tm.id, tm.user_id, tm.created_at from public.tenant_members tm
        where tm.tenant_id = ${tenantId}::uuid and tm.id = ${memberId}::uuid
      )
      select
        m.created_at as member_since,
        (u.phone_verified_at is not null) as phone_verified,
        exists (
          select 1 from public.stores s
          where s.tenant_id = ${tenantId}::uuid and s.owner_member_id = m.id
            and s.is_verified and s.deleted_at is null
        ) as store_verified,
        (select count(*)::int from public.posts p
          where p.tenant_id = ${tenantId}::uuid and p.author_member_id = m.id
            and p.status_code in ('live', 'sold', 'expired') and p.published_at is not null
            and (p.deletion_reason_code is null or p.deletion_reason_code = 'user_deleted')) as approved_posts,
        (select count(*)::int from public.moderation_queue_items q
          where q.tenant_id = ${tenantId}::uuid and q.author_member_id = m.id
            and q.resolution_code = 'rejected') as rejected_posts,
        (select count(*)::int from public.moderation_queue_items q
          where q.tenant_id = ${tenantId}::uuid and q.author_member_id = m.id
            and q.resolution_code in ('removed', 'hard_removed')) as removed_posts,
        (select count(*)::int from public.reports r
          where r.tenant_id = ${tenantId}::uuid and r.status_code = 'actioned'
            and (r.reported_member_id = m.id
                 or r.post_id in (select p.id from public.posts p
                                  where p.tenant_id = ${tenantId}::uuid and p.author_member_id = m.id))) as upheld_reports,
        (select count(*)::int from public.bans b
          where b.tenant_id = ${tenantId}::uuid and b.user_id = m.user_id and b.revoked_at is null) as bans,
        (select count(*)::int from public.place_edit_suggestions s
          where s.tenant_id = ${tenantId}::uuid and s.suggester_member_id = m.id
            and s.status_code = 'approved') as approved_edits
      from m join public.users u on u.id = m.user_id`);
    const [row] = z
      .array(
        z.object({
          member_since: z.coerce.date(),
          phone_verified: z.boolean(),
          store_verified: z.boolean(),
          approved_posts: z.number(),
          rejected_posts: z.number(),
          removed_posts: z.number(),
          upheld_reports: z.number(),
          bans: z.number(),
          approved_edits: z.number(),
        }),
      )
      .max(1)
      .parse([...rows]);
    return (
      row && {
        memberSince: row.member_since,
        phoneVerified: row.phone_verified,
        storeVerified: row.store_verified,
        approvedPosts: row.approved_posts,
        rejectedPosts: row.rejected_posts,
        removedPosts: row.removed_posts,
        upheldReports: row.upheld_reports,
        bans: row.bans,
        approvedEdits: row.approved_edits,
      }
    );
  }

  async save(
    tx: DatabaseTransaction,
    tenantId: string,
    memberId: string,
    computed: {
      score: number;
      components: TrustComponents;
      algorithmVersion: number;
      /** When a time-based input (account age) next changes; null if none will. */
      nextRecomputeAt: Date | null;
    },
  ): Promise<void> {
    const next = computed.nextRecomputeAt?.toISOString() ?? null;
    await tx.execute(sql`
      insert into public.member_trust_scores (tenant_id, member_id, score, components, algorithm_version, computed_at, next_recompute_at)
      values (${tenantId}::uuid, ${memberId}::uuid, ${computed.score}, ${JSON.stringify(computed.components)}::jsonb,
              ${computed.algorithmVersion}, now(), ${next}::timestamptz)
      on conflict (tenant_id, member_id) do update set
        score = excluded.score, components = excluded.components,
        algorithm_version = excluded.algorithm_version, computed_at = now(),
        next_recompute_at = excluded.next_recompute_at`);
  }

  async markStale(tx: DatabaseTransaction, tenantId: string, memberId: string): Promise<void> {
    await tx.execute(sql`
      update public.member_trust_scores set next_recompute_at = now()
      where tenant_id = ${tenantId}::uuid and member_id = ${memberId}::uuid`);
  }
}
