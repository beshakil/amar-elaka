import { Injectable } from '@nestjs/common';
import { UnauthenticatedException } from '../auth/exceptions/auth.exceptions';
import { DomainException } from '../common/exceptions/domain-exception';
import { sqlStateOf } from '../common/utils/sql-state';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantRequiredException } from '../database/tenant.exceptions';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { NotificationService } from '../notifications/notification.service';
import type { NotificationType } from '../notifications/notification-channel';
import { assertTransition } from '../posts/post-state-machine';
import { PostsRepository } from '../posts/posts.repository';
import { SettingsService } from '../settings/settings.service';
import { TrustScoreService } from '../trust/trust-score.service';
import type {
  BulkInput,
  BulkResult,
  DecisionInput,
  HardRemoveInput,
  ModerationResult,
  QueuePage,
  QueueQuery,
} from './dto/moderation.dto';
import {
  BulkTooLargeException,
  LegalHoldBlocksScrubException,
  ModerationPostNotFoundException,
} from './moderation.exceptions';
import { ModerationRepository, type ModeratedPost } from './moderation.repository';

// settings-exempt: unit conversions
const MS_PER_HOUR = 60 * 60 * 1_000;
// settings-exempt: see above
const MS_PER_DAY = 24 * MS_PER_HOUR;
const LEGAL_HOLD_SQLSTATE = 'AE100';

interface AfterCommit {
  post: ModeratedPost;
  notify?: { type: NotificationType; reasonCode: string | null; reasonText: string | null };
}

/**
 * The moderation queue's actions (ADR 030), tenant staff only (RLS keeps a
 * moderator to their own tenant). Each action, in one transaction: the
 * status change (through the post state machine), a moderation_actions row,
 * the queue item closed, and a post.* outbox event. After commit: the
 * author's trust score is recomputed and the owner is notified.
 */
@Injectable()
export class ModerationService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: ModerationRepository,
    private readonly posts: PostsRepository,
    private readonly trust: TrustScoreService,
    private readonly notifications: NotificationService,
    private readonly settings: SettingsService,
  ) {}

  async queue(query: QueueQuery): Promise<QueuePage> {
    const [pageDefault, pageMax] = await Promise.all([
      this.settings.get('moderation_queue_page_size_default'),
      this.settings.get('moderation_queue_page_size_max'),
    ]);
    const limit = Math.min(query.limit ?? pageDefault, pageMax);
    const rows = await this.tenantDb.transaction(
      (tx) =>
        this.repo.listQueue(
          tx,
          {
            ...(query.reason ? { reason: query.reason } : {}),
            ...(query.categoryId ? { categoryId: query.categoryId } : {}),
            ...(query.olderThanHours !== undefined ? { olderThanHours: query.olderThanHours } : {}),
            ...(query.cursor ? { after: query.cursor } : {}),
          },
          limit + 1,
        ),
      { accessMode: 'read only' },
    );
    const page = rows.slice(0, limit);
    const now = Date.now();
    return {
      items: page.map((row) => ({
        id: row.id,
        postId: row.post_id,
        source: row.source_code,
        reasons: row.reasons,
        postStatus: row.status_code,
        title: row.title,
        category: {
          id: row.category_id,
          name: { bn: row.category_name_bn, en: row.category_name_en },
        },
        price: row.price,
        outsideBoundary: row.outside_boundary,
        mediaCount: row.media_count,
        authorTrustScore: row.author_trust_score,
        queuedAt: row.created_at.toISOString(),
        ageHours: Math.floor((now - row.created_at.getTime()) / MS_PER_HOUR),
      })),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /** pending → live; for a live post (a sample or re-review) it just clears the item. */
  approve(postId: string): Promise<ModerationResult> {
    return this.act(postId, async (post, tx, userId) => {
      if (post.status_code === 'pending') {
        assertTransition('pending', 'live', 'moderator');
        const now = new Date();
        const policy = await this.posts.categoryPolicy(tx, post.category_id, post.tenant_id);
        const days =
          policy.expiryDays ??
          (await this.settings.get('post_expiry_days_default', post.tenant_id));
        await this.repo.setModerated(tx, post.id, {
          status: 'live',
          reasonCode: null,
          userId,
          ...(post.published_at ? {} : { publishedAt: now }),
          expiresAt: new Date(now.getTime() + days * MS_PER_DAY),
        });
        await this.posts.emit(tx, 'post.live', post.id, {
          tenantId: post.tenant_id,
          actorUserId: userId,
          from: 'pending',
          to: 'live',
          reason: 'moderator_approved',
        });
      } else if (post.status_code !== 'live') {
        assertTransition(post.status_code, 'live', 'moderator'); // throws: nothing to approve
      }
      await this.repo.recordAction(tx, {
        postId: post.id,
        actorUserId: userId,
        actionCode: 'approved',
        reasonCode: 'meets_guidelines',
        reasonText: null,
        evidenceRefs: [],
      });
      await this.repo.resolve(
        tx,
        { id: post.id, authorMemberId: post.author_member_id },
        'approved',
        userId,
      );
      return {
        status: 'live',
        after:
          post.status_code === 'pending'
            ? { type: 'post_approved', reasonCode: null, reasonText: null }
            : undefined,
      };
    });
  }

  reject(postId: string, input: DecisionInput): Promise<ModerationResult> {
    return this.takedown(postId, 'rejected', input);
  }

  remove(postId: string, input: DecisionInput): Promise<ModerationResult> {
    return this.takedown(postId, 'removed', input);
  }

  /**
   * deletion_reason = moderator_removed + scrub (ADR 005/006). A post under a
   * legal hold (direct or through its author, ADR 012) is refused before
   * anything changes; scrub_post() refuses it again inside the database.
   */
  hardRemove(postId: string, input: HardRemoveInput): Promise<ModerationResult> {
    return this.act(postId, async (post, tx, userId) => {
      if (post.scrubbed_at) return { status: post.status_code, scrubbed: true };
      if (await this.repo.legalHoldBlocks(tx, post.id)) throw new LegalHoldBlocksScrubException();
      // Ledger first: the scrub nulls the post's author.
      await this.repo.resolve(
        tx,
        { id: post.id, authorMemberId: post.author_member_id },
        'hard_removed',
        userId,
      );
      await this.repo.recordAction(tx, {
        postId: post.id,
        actorUserId: userId,
        actionCode: 'moderator_removed',
        reasonCode: input.reasonCode,
        reasonText: input.reasonText,
        evidenceRefs: input.evidenceRefs,
      });
      try {
        await this.repo.scrub(tx, post.id, input.reasonCode);
      } catch (error) {
        if (sqlStateOf(error) === LEGAL_HOLD_SQLSTATE) throw new LegalHoldBlocksScrubException();
        throw error;
      }
      await this.posts.emit(tx, 'post.hard_removed', post.id, {
        tenantId: post.tenant_id,
        actorUserId: userId,
        reasonCode: input.reasonCode,
      });
      return {
        status: post.status_code,
        scrubbed: true,
        after: { type: 'post_removed', reasonCode: input.reasonCode, reasonText: null },
      };
    });
  }

  async bulk(input: BulkInput): Promise<BulkResult> {
    const max = await this.settings.get('moderation_bulk_max');
    const ids = [...new Set(input.postIds)];
    if (ids.length > max) throw new BulkTooLargeException(max);
    const results: BulkResult['results'] = [];
    // One transaction per post: one bad post doesn't undo the rest.
    for (const postId of ids) {
      try {
        const result =
          input.action === 'approve'
            ? await this.approve(postId)
            : await this.reject(postId, {
                reasonCode: input.reasonCode!,
                ...(input.reasonText ? { reasonText: input.reasonText } : {}),
              });
        results.push({ postId, ok: true, status: result.status, error: null });
      } catch (error) {
        results.push({
          postId,
          ok: false,
          status: null,
          error: error instanceof DomainException ? error.code : 'INTERNAL_ERROR',
        });
      }
    }
    return { results };
  }

  // ---- helpers -------------------------------------------------------------

  private takedown(
    postId: string,
    to: 'rejected' | 'removed',
    input: DecisionInput,
  ): Promise<ModerationResult> {
    return this.act(postId, async (post, tx, userId) => {
      assertTransition(post.status_code, to, 'moderator');
      await this.repo.setModerated(tx, post.id, {
        status: to,
        reasonCode: input.reasonCode,
        userId,
      });
      await this.repo.recordAction(tx, {
        postId: post.id,
        actorUserId: userId,
        actionCode: to,
        reasonCode: input.reasonCode,
        reasonText: input.reasonText ?? null,
        evidenceRefs: [],
      });
      await this.repo.resolve(
        tx,
        { id: post.id, authorMemberId: post.author_member_id },
        to,
        userId,
      );
      await this.posts.emit(tx, `post.${to}`, post.id, {
        tenantId: post.tenant_id,
        actorUserId: userId,
        from: post.status_code,
        to,
        reasonCode: input.reasonCode,
      });
      return {
        status: to,
        after: {
          type: to === 'rejected' ? 'post_rejected' : 'post_removed',
          reasonCode: input.reasonCode,
          reasonText: input.reasonText ?? null,
        },
      };
    });
  }

  /** Lock the post in the moderator's tenant, run `work`, commit; then trust + notification. */
  private async act(
    postId: string,
    work: (
      post: ModeratedPost,
      tx: DatabaseTransaction,
      userId: string,
    ) => Promise<{ status: string; scrubbed?: boolean; after?: AfterCommit['notify'] }>,
  ): Promise<ModerationResult> {
    const { tenantId, userId } = this.context.require();
    if (!userId) throw new UnauthenticatedException();
    if (!tenantId) throw new TenantRequiredException();

    const { post, outcome } = await this.tenantDb.transaction(async (tx) => {
      const found = await this.repo.lockPost(tx, postId);
      if (!found || found.tenant_id !== tenantId) throw new ModerationPostNotFoundException();
      return { post: found, outcome: await work(found, tx, userId) };
    });

    if (post.author_member_id) {
      await this.trust.recompute(post.tenant_id, post.author_member_id);
    }
    if (outcome.after && post.author_user_id) {
      await this.notifications.send({
        userId: post.author_user_id,
        type: outcome.after.type,
        params: {
          postId: post.id,
          postTitle: post.title,
          reasonCode: outcome.after.reasonCode,
          reasonText: outcome.after.reasonText,
        },
        deepLink: `/posts/${post.id}`,
        entityId: post.id,
        dedupeKey: `${outcome.after.type}:${post.id}:${outcome.status}`,
      });
    }
    return { postId: post.id, status: outcome.status, scrubbed: outcome.scrubbed ?? false };
  }
}
