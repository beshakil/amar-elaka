import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import type { JobBudget, JobOutcome } from '../jobs/job-batches';
import { SettingsService } from '../settings/settings.service';
import { NotificationService } from './notification.service';

// settings-exempt: how long a claimed event is leased to this run (ops tuning, like the search relay's)
const LEASE_SECONDS = 120;
// settings-exempt: stored error text length (a column-size guard, not behaviour)
const LAST_ERROR_MAX_CHARS = 500;

const claimed = z.object({
  id: z.string(),
  aggregate_id: z.string(),
  payload: z.record(z.unknown()),
  attempts: z.number(),
});

const saver = z.object({
  user_id: z.string(),
  tenant_id: z.string(),
  title: z.string(),
});

/**
 * Turns `post.price_dropped` outbox events (posts.service.ts, written in the
 * same transaction as the price change) into a `saved_post_price_drop`
 * notification for everyone who saved the post (ADR 059) — never the
 * seller, never for a post that isn't listed any more. Claimed with a lease
 * (FOR UPDATE SKIP LOCKED, as the search relay), so two workers never
 * notify twice; an event that keeps failing is set aside after
 * notification_outbox_max_attempts with its error. The notification
 * collapses ("৩টি সেভ করা বিজ্ঞাপনের দাম কমেছে") and is capped like any other.
 */
@Injectable()
export class NotificationOutboxRelay {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly notifications: NotificationService,
    private readonly settings: SettingsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(NotificationOutboxRelay.name);
  }

  async relay(budget: JobBudget): Promise<JobOutcome> {
    const limit = budget.batchSize * budget.maxBatches;
    const maxAttempts = await this.settings.get('notification_outbox_max_attempts');
    const events = await this.asSystem((tx) => this.claim(tx, limit));
    let notified = 0;
    for (const event of events) {
      try {
        const savers = await this.asSystem((tx) =>
          this.savers(tx, event.aggregate_id, event.payload),
        );
        for (const s of savers) {
          await this.notifications.send({
            userId: s.user_id,
            type: 'saved_post_price_drop',
            tenantId: s.tenant_id,
            params: {
              postId: event.aggregate_id,
              postTitle: s.title,
              from: stringOrNull(event.payload.from),
              to: stringOrNull(event.payload.to),
            },
            deepLink: `/posts/${event.aggregate_id}`,
            entityId: event.aggregate_id,
            dedupeKey: `saved_post_price_drop:${event.id}`,
            collapse: { key: 'saved_post_price_drop', deepLink: '/saved' },
          });
          notified += 1;
        }
        await this.asSystem((tx) => this.markProcessed(tx, event.id));
      } catch (error) {
        const message = (
          error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        ).slice(0, LAST_ERROR_MAX_CHARS);
        this.logger.warn({ eventId: event.id, err: error }, 'price-drop notification failed');
        await this.asSystem((tx) =>
          this.fail(tx, event.id, message, event.attempts >= maxAttempts),
        );
      }
    }
    await this.asSystem((tx) => this.purgeProcessed(tx));
    return { rows: notified, capped: events.length === limit, details: { events: events.length } };
  }

  private async claim(tx: DatabaseTransaction, limit: number): Promise<z.infer<typeof claimed>[]> {
    const rows = await tx.execute(sql`
      update public.outbox_events o
      set attempts = o.attempts + 1, available_at = now() + make_interval(secs => ${LEASE_SECONDS})
      where o.id in (
        select id from public.outbox_events
        where processed_at is null and available_at <= now() and event_type = 'post.price_dropped'
        order by available_at, id
        limit ${limit}
        for update skip locked
      )
      returning o.id, o.aggregate_id, o.payload, o.attempts`);
    return z.array(claimed).parse([...rows]);
  }

  /** Who saved the post (saved_posts is per user, in the post's tenant); the seller never. */
  private async savers(
    tx: DatabaseTransaction,
    postId: string,
    payload: Record<string, unknown>,
  ): Promise<z.infer<typeof saver>[]> {
    const actor = typeof payload.actorUserId === 'string' ? payload.actorUserId : null;
    const rows = await tx.execute(sql`
      select sp.user_id, p.tenant_id, p.title
      from public.saved_posts sp
      join public.posts p on p.tenant_id = sp.tenant_id and p.id = sp.post_id
      left join public.tenant_members author on author.tenant_id = p.tenant_id and author.id = p.author_member_id
      where sp.post_id = ${postId}::uuid
        and public.post_is_listed(p.status_code, p.deleted_at, p.scrubbed_at, p.hidden_by_owner, p.store_hidden,
                                  p.expires_at, now())
        and sp.user_id is distinct from author.user_id
        and (${actor}::uuid is null or sp.user_id <> ${actor}::uuid)`);
    return z.array(saver).parse([...rows]);
  }

  private async markProcessed(tx: DatabaseTransaction, id: string): Promise<void> {
    await tx.execute(sql`
      update public.outbox_events set processed_at = now(), last_error = null where id = ${id}::uuid`);
  }

  /** Back in line after the lease; past the attempt limit, set aside (processed, with its error). */
  private async fail(
    tx: DatabaseTransaction,
    id: string,
    error: string,
    giveUp: boolean,
  ): Promise<void> {
    await tx.execute(sql`
      update public.outbox_events
      set last_error = ${error}, processed_at = case when ${giveUp} then now() else null end
      where id = ${id}::uuid`);
  }

  /** Processed price-drop events past outbox_processed_retention_days. */
  private async purgeProcessed(tx: DatabaseTransaction): Promise<void> {
    const days = await this.settings.get('outbox_processed_retention_days');
    await tx.execute(sql`
      delete from public.outbox_events
      where event_type = 'post.price_dropped' and processed_at is not null
        and processed_at < now() - make_interval(days => ${days})`);
  }

  private asSystem<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.context.run({ role: 'system' }, () => this.tenantDb.transaction(work));
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
}
