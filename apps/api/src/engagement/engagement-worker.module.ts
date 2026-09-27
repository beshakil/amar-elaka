import { Module } from '@nestjs/common';
import { EngagementRepository } from './engagement.repository';
import { ENGAGEMENT_STORE, RedisEngagementStore } from './engagement.store';
import { PostViewsFlushService } from './post-views-flush.service';

/** The worker side of engagement: the view-count flush, run by the posts queue's processor (PostsWorkerModule). */
@Module({
  providers: [
    EngagementRepository,
    PostViewsFlushService,
    { provide: ENGAGEMENT_STORE, useClass: RedisEngagementStore },
  ],
  exports: [PostViewsFlushService],
})
export class EngagementWorkerModule {}
