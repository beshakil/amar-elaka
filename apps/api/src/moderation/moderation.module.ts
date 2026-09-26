import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PostsRepository } from '../posts/posts.repository';
import { RbacModule } from '../rbac/rbac.module';
import { SettingsModule } from '../settings/settings.module';
import { TrustModule } from '../trust/trust.module';
import { ModerationDecisionService } from './moderation-decision.service';
import { ModerationController } from './moderation.controller';
import { ModerationRepository } from './moderation.repository';
import { ModerationService } from './moderation.service';

/**
 * Trust-based moderation (ADR 030): the submission decision (used by
 * PostsModule) and the moderator queue. Doesn't import PostsModule — it uses
 * the stateless PostsRepository directly, so PostsModule can import this one.
 */
@Module({
  imports: [AuthModule, RbacModule, SettingsModule, TrustModule, NotificationsModule],
  controllers: [ModerationController],
  providers: [ModerationService, ModerationDecisionService, ModerationRepository, PostsRepository],
  exports: [ModerationDecisionService, ModerationRepository],
})
export class ModerationModule {}
