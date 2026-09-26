import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import { POST_STATUSES } from '../posts/post-state-machine';

export type QueueSource = 'submission' | 'sample' | 'rereview';
export type QueueResolution = 'approved' | 'rejected' | 'removed' | 'hard_removed' | 'withdrawn';

const MODERATED_POST = z.object({
  id: z.string(),
  tenant_id: z.string(),
  author_member_id: z.string().nullable(),
  author_user_id: z.string().nullable(),
  category_id: z.string(),
  title: z.string(),
  status_code: z.enum(POST_STATUSES),
  published_at: z.coerce.date().nullable(),
  deleted_at: z.coerce.date().nullable(),
  scrubbed_at: z.coerce.date().nullable(),
});
export type ModeratedPost = z.infer<typeof MODERATED_POST>;

const QUEUE_ROW = z.object({
  id: z.string(),
  post_id: z.string(),
  source_code: z.enum(['submission', 'sample', 'rereview']),
  reasons: z.array(z.string()),
  author_trust_score: z.number().nullable(),
  created_at: z.coerce.date(),
  title: z.string(),
  status_code: z.enum(POST_STATUSES),
  category_id: z.string(),
  category_name_bn: z.string(),
  category_name_en: z.string(),
  price: z.string().nullable(),
  outside_boundary: z.boolean(),
  media_count: z.number(),
});
export type QueueRow = z.infer<typeof QUEUE_ROW>;

@Injectable()
export class ModerationRepository {
  // ---- pre-filter inputs (author's transaction) -----------------------------

  /** Another of the author's posts in the window with the same title and the same photos (by checksum). */
  async hasDuplicate(
    tx: DatabaseTransaction,
    postId: string,
    memberId: string,
    windowHours: number,
  ): Promise<boolean> {
    const rows = await tx.execute(sql`
      with photos as (
        select a.post_id, array_agg(m.checksum_sha256 order by m.checksum_sha256) as checksums
        from public.media_attachments a
        join public.media_assets m on m.tenant_id = a.tenant_id and m.id = a.media_asset_id
        group by a.post_id
      ),
      me as (
        select p.id, lower(btrim(p.title)) as title, coalesce(ph.checksums, '{}') as checksums
        from public.posts p left join photos ph on ph.post_id = p.id
        where p.id = ${postId}::uuid
      )
      select exists (
        select 1 from public.posts o
        left join photos ph on ph.post_id = o.id, me
        where o.author_member_id = ${memberId}::uuid
          and o.id <> me.id
          and o.deleted_at is null
          and o.created_at >= now() - make_interval(hours => ${windowHours})
          and lower(btrim(o.title)) = me.title
          and coalesce(ph.checksums, '{}') = me.checksums
      ) as dup`);
    return z
      .array(z.object({ dup: z.boolean() }))
      .length(1)
      .parse([...rows])[0]!.dup;
  }

  /** Median price of the category's live/sold posts in the tenant over the lookback, and how many. */
  async priceMedian(
    tx: DatabaseTransaction,
    categoryId: string,
    lookbackDays: number,
    excludePostId: string,
  ): Promise<{ median: number | null; samples: number }> {
    const rows = await tx.execute(sql`
      select percentile_cont(0.5) within group (order by p.price)::float8 as median, count(*)::int as samples
      from public.posts p
      where p.category_id = ${categoryId}::uuid
        and p.status_code in ('live', 'sold')
        and p.deleted_at is null
        and p.price is not null
        and p.published_at >= now() - make_interval(days => ${lookbackDays})
        and p.id <> ${excludePostId}::uuid`);
    const [row] = z
      .array(z.object({ median: z.number().nullable(), samples: z.number() }))
      .length(1)
      .parse([...rows]);
    return row!;
  }

  /**
   * Files an open item for the post (file_moderation_item, 0027): the caller
   * must be its author, staff or system; the author comes from the post; a
   * post that already has an open item keeps that one.
   */
  async fileItem(
    tx: DatabaseTransaction,
    item: {
      postId: string;
      source: QueueSource;
      reasons: readonly string[];
      trustScore: number | null;
    },
  ): Promise<void> {
    await tx.execute(sql`
      select public.file_moderation_item(${item.postId}::uuid, ${item.source},
                                         ${reasonsArray(item.reasons)}, ${item.trustScore}::smallint)`);
  }

  // ---- moderator side (staff transaction) -----------------------------------

  async listQueue(
    tx: DatabaseTransaction,
    filter: { reason?: string; categoryId?: string; olderThanHours?: number; after?: string },
    limit: number,
  ): Promise<QueueRow[]> {
    const conditions: SQL[] = [sql`q.status_code = 'open'`];
    if (filter.reason) conditions.push(sql`${filter.reason} = any (q.reasons)`);
    if (filter.categoryId) conditions.push(sql`p.category_id = ${filter.categoryId}::uuid`);
    if (filter.olderThanHours !== undefined) {
      conditions.push(
        sql`q.created_at <= now() - make_interval(hours => ${filter.olderThanHours})`,
      );
    }
    if (filter.after) conditions.push(sql`q.id > ${filter.after}::uuid`);
    const rows = await tx.execute(sql`
      select q.id, q.post_id, q.source_code, q.reasons, q.author_trust_score, q.created_at,
             p.title, p.status_code, p.category_id, c.name_bn as category_name_bn, c.name_en as category_name_en,
             p.price::text as price, p.outside_boundary,
             (select count(*)::int from public.media_attachments a where a.post_id = p.id) as media_count
      from public.moderation_queue_items q
      join public.posts p on p.tenant_id = q.tenant_id and p.id = q.post_id
      join public.categories c on c.id = p.category_id
      where ${sql.join(conditions, sql` and `)}
      order by q.id
      limit ${limit}`);
    return z.array(QUEUE_ROW).parse([...rows]);
  }

  async lockPost(tx: DatabaseTransaction, postId: string): Promise<ModeratedPost | undefined> {
    const rows = await tx.execute(sql`
      select p.id, p.tenant_id, p.author_member_id, tm.user_id as author_user_id, p.category_id, p.title,
             p.status_code, p.published_at, p.deleted_at, p.scrubbed_at
      from public.posts p
      left join public.tenant_members tm on tm.tenant_id = p.tenant_id and tm.id = p.author_member_id
      where p.id = ${postId}::uuid
      for update of p`);
    return z
      .array(MODERATED_POST)
      .max(1)
      .parse([...rows])[0];
  }

  async openItem(
    tx: DatabaseTransaction,
    postId: string,
  ): Promise<{ id: string; source: QueueSource } | undefined> {
    const rows = await tx.execute(sql`
      select id, source_code from public.moderation_queue_items
      where post_id = ${postId}::uuid and status_code = 'open'`);
    const [row] = z
      .array(
        z.object({ id: z.string(), source_code: z.enum(['submission', 'sample', 'rereview']) }),
      )
      .max(1)
      .parse([...rows]);
    return row && { id: row.id, source: row.source_code };
  }

  /**
   * Closes the post's open item with the outcome, or — for an action on a
   * post nobody queued (a live post a moderator came across) — records a
   * resolved one, so the queue stays the complete per-post ledger trust reads.
   */
  async resolve(
    tx: DatabaseTransaction,
    post: { id: string; authorMemberId: string | null },
    resolution: QueueResolution,
    userId: string,
  ): Promise<void> {
    const updated = await tx.execute(sql`
      update public.moderation_queue_items
      set status_code = 'resolved', resolution_code = ${resolution},
          resolved_by_user_id = ${userId}::uuid, resolved_at = now()
      where post_id = ${post.id}::uuid and status_code = 'open'
      returning id`);
    if ([...updated].length > 0 || post.authorMemberId === null) return;
    await tx.execute(sql`
      insert into public.moderation_queue_items
        (post_id, author_member_id, source_code, status_code, resolution_code, resolved_by_user_id, resolved_at)
      values (${post.id}::uuid, ${post.authorMemberId}::uuid, 'rereview', 'resolved', ${resolution},
              ${userId}::uuid, now())`);
  }

  async recordAction(
    tx: DatabaseTransaction,
    action: {
      postId: string;
      actorUserId: string;
      actionCode: 'approved' | 'rejected' | 'removed' | 'moderator_removed';
      reasonCode: string;
      reasonText: string | null;
      evidenceRefs: readonly string[];
    },
  ): Promise<void> {
    await tx.execute(sql`
      insert into public.moderation_actions (post_id, actor_user_id, action_code, reason_code, reason_text, evidence_refs)
      values (${action.postId}::uuid, ${action.actorUserId}::uuid, ${action.actionCode}, ${action.reasonCode},
              ${action.reasonText}, ${JSON.stringify(action.evidenceRefs)}::jsonb)`);
  }

  async setModerated(
    tx: DatabaseTransaction,
    postId: string,
    patch: {
      status?: string;
      reasonCode: string | null;
      userId: string;
      publishedAt?: Date;
      expiresAt?: Date;
    },
  ): Promise<void> {
    await tx.execute(sql`
      update public.posts set
        ${patch.status ? sql`status_code = ${patch.status},` : sql``}
        ${patch.publishedAt ? sql`published_at = ${patch.publishedAt.toISOString()}::timestamptz, bumped_at = ${patch.publishedAt.toISOString()}::timestamptz,` : sql``}
        ${patch.expiresAt ? sql`expires_at = ${patch.expiresAt.toISOString()}::timestamptz,` : sql``}
        moderation_reason_code = ${patch.reasonCode},
        moderated_by_user_id = ${patch.userId}::uuid,
        moderated_at = now()
      where id = ${postId}::uuid`);
  }

  async legalHoldBlocks(tx: DatabaseTransaction, postId: string): Promise<boolean> {
    const rows = await tx.execute(
      sql`select public.legal_hold_blocks('post', ${postId}::uuid) as held`,
    );
    return z
      .array(z.object({ held: z.boolean() }))
      .length(1)
      .parse([...rows])[0]!.held;
  }

  async scrub(tx: DatabaseTransaction, postId: string, scrubReason: string): Promise<void> {
    await tx.execute(
      sql`select public.scrub_post(${postId}::uuid, ${scrubReason}, 'moderator_removed')`,
    );
  }
}

function reasonsArray(reasons: readonly string[]): SQL {
  return reasons.length === 0
    ? sql`'{}'::text[]`
    : sql`array[${sql.join(
        reasons.map((r) => sql`${r}`),
        sql`, `,
      )}]::text[]`;
}
