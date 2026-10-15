import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MediaModule } from '../media/media.module';
import { PostsModule } from '../posts/posts.module';
import { RbacModule } from '../rbac/rbac.module';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { TrustModule } from '../trust/trust.module';
import { ReviewModerationService } from './review-moderation.service';
import {
  PlatformReviewsController,
  ReviewModerationController,
  StoreReviewsController,
} from './reviews.controller';
import { ReviewsService } from './reviews.service';
import { SellerScoreModule } from './seller-score.module';

/**
 * Reviews (ADR 061): a store's reviews, proven by a real contact; the store's
 * reply; reports and the moderators' decision; the privacy scrub. Reuses,
 * never re-implements: the owning-tenant switch (PostsModule), trust
 * (TrustModule), the media pipeline, and the seller score (SellerScoreModule).
 * The "how was it?" job lives in ReviewPromptsModule (worker).
 */
@Module({
  imports: [
    AuthModule,
    RbacModule,
    SettingsModule,
    StorageModule,
    MediaModule,
    PostsModule,
    TrustModule,
    SellerScoreModule,
  ],
  controllers: [StoreReviewsController, ReviewModerationController, PlatformReviewsController],
  providers: [ReviewsService, ReviewModerationService],
})
export class ReviewsModule {}
