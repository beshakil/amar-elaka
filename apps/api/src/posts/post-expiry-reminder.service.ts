import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { inBatches, type JobBudget, type JobOutcome } from '../jobs/job-batches';
import { NotificationService } from '../notifications/notification.service';
import { SettingsService } from '../settings/settings.service';

const DUE = z.object({
  id: z.string(),
  tenant_id: z.string(),
  title: z.string(),
  expires_at: z.coerce.date(),
  user_id: z.string(),
});

/**
 * Tells an owner `post_expiry_reminder_days` before their live post expires,
 * with a one-tap repost (the deep link opens it; POST /posts/:id/repost
 * renews a live post inside that window). One reminder per listing period:
 * `posts.expiry_reminder_for` records the expires_at already reminded about,
 * and a repost's new expires_at makes the post due again.
 *
 * Send, then mark: a crash in between resends on the next run, and the
 * notification's dedupe key (post + expires_at) keeps that to one. A post is
 * marked once its notification is queued (durable; the queue retries the delivery).
 */
@Injectable()
export class PostExpiryReminderService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly notifications: NotificationService,
    private readonly settings: SettingsService,
  ) {}

  async remindExpiring(budget: JobBudget): Promise<JobOutcome> {
    const days = await this.settings.get('post_expiry_reminder_days');
    let sent = 0;
    let failed = 0;
    const outcome = await inBatches(budget, async (limit) => {
      const due = await this.asSystem((tx) => this.due(tx, days, limit));
      // Queued is durable (Redis, retried with backoff): mark once it's on
      // the queue. A send that throws (Redis down) stops the batch; the
      // rest stay due for the next run.
      const queued: z.infer<typeof DUE>[] = [];
      try {
        for (const post of due) {
          const expiresAt = post.expires_at.toISOString();
          await this.notifications.send({
            userId: post.user_id,
            type: 'post_expiring',
            tenantId: post.tenant_id,
            params: { postId: post.id, postTitle: post.title, expiresAt, action: 'repost' },
            deepLink: `/posts/${post.id}?action=repost`,
            entityId: post.id,
            dedupeKey: `post_expiring:${post.id}:${expiresAt}`,
          });
          queued.push(post);
        }
      } finally {
        await this.asSystem((tx) => this.markReminded(tx, queued));
      }
      sent += queued.length;
      failed += due.length - queued.length;
      return queued.length < due.length ? 0 : due.length;
    });
    return { rows: sent, capped: outcome.capped, details: { failed } };
  }

  private async due(
    tx: DatabaseTransaction,
    days: number,
    limit: number,
  ): Promise<z.infer<typeof DUE>[]> {
    const rows = await tx.execute(sql`
      select p.id, p.tenant_id, p.title, p.expires_at, tm.user_id
      from public.posts p
      join public.tenant_members tm on tm.tenant_id = p.tenant_id and tm.id = p.author_member_id
      where public.post_is_listed(p.status_code, p.deleted_at, p.scrubbed_at, p.hidden_by_owner, p.store_hidden, p.expires_at, now())
        and p.expires_at is not null
        and p.expires_at <= now() + make_interval(days => ${days})
        and p.expiry_reminder_for is distinct from p.expires_at
      order by p.expires_at
      limit ${limit}`);
    return z.array(DUE).parse([...rows]);
  }

  /** Only for the expires_at that was reminded about: a repost in between wins. */
  private async markReminded(tx: DatabaseTransaction, posts: z.infer<typeof DUE>[]): Promise<void> {
    for (const post of posts) {
      await tx.execute(sql`
        update public.posts set expiry_reminder_for = expires_at
        where id = ${post.id}::uuid and expires_at = ${post.expires_at.toISOString()}::timestamptz`);
    }
  }

  private asSystem<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.context.run({ role: 'system' }, () => this.tenantDb.transaction(work));
  }
}
