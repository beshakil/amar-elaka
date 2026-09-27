import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { TenantDb } from '../database/tenant-db';
import { PostOwnershipService } from '../posts/post-ownership.service';
import { visibilityOf } from '../posts/post-visibility';
import { PostNotFoundException } from '../posts/posts.exceptions';
import { PostsRepository } from '../posts/posts.repository';
import { SettingsService } from '../settings/settings.service';
import { ENGAGEMENT_STORE, type EngagementStore } from './engagement.store';
import { viewerKey, type ViewerSignals } from './viewer-key';

// settings-exempt: unit conversion (the duration itself is view_dedupe_hours)
const SECONDS_PER_HOUR = 60 * 60;

/**
 * POST /posts/:id/view (ADR 036). Never a synchronous UPDATE per view: a
 * view is one Redis SET NX (the dedupe claim, one per viewer per post per
 * view_dedupe_hours) and, when it's new, one HINCRBY. The worker flushes the
 * counts to posts.view_count in batches (PostViewsFlushService).
 */
@Injectable()
export class PostViewsService {
  private readonly secret: string;

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly ownership: PostOwnershipService,
    private readonly posts: PostsRepository,
    private readonly settings: SettingsService,
    @Inject(ENGAGEMENT_STORE) private readonly store: EngagementStore,
    @Inject(APP_CONFIG) env: Pick<Env, 'JWT_SECRET'>,
  ) {
    this.secret = env.JWT_SECRET;
  }

  /** Counts the view if it's this viewer's first within the window. The owner's own views never count. */
  async record(postId: string, signals: ViewerSignals): Promise<void> {
    const tenantId = await this.ownership.tenantOf(postId);
    if (!tenantId) throw new PostNotFoundException();
    const countable = await this.ownership.inTenant(tenantId, 'lookup', ({ memberId }) =>
      this.tenantDb.transaction(
        async (tx) => {
          const row = await this.posts.findById(tx, postId);
          if (!row) throw new PostNotFoundException();
          if (memberId !== undefined && row.author_member_id === memberId) return false;
          // Only what the public can see is "viewed"; anything else is 404 to them.
          const facts = {
            status: row.status_code,
            hiddenByOwner: row.hidden_by_owner,
            deleted: row.deleted_at !== null,
            scrubbed: row.scrubbed_at !== null,
          };
          if (visibilityOf(facts, 'public') !== 'full') throw new PostNotFoundException();
          return true;
        },
        { accessMode: 'read only' },
      ),
    );
    if (!countable) return;

    const hours = await this.settings.get('view_dedupe_hours');
    const key = viewerKey(this.secret, signals);
    if (await this.store.claimOnce(`view:${postId}:${key}`, hours * SECONDS_PER_HOUR)) {
      await this.store.addPendingView(postId);
    }
  }
}
