import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PostsModule } from '../posts/posts.module';
import { RbacModule } from '../rbac/rbac.module';
import { SettingsModule } from '../settings/settings.module';
import { HoursController } from './hours.controller';
import { HoursRepository } from './hours.repository';
import { HoursService } from './hours.service';

/** Business hours and open state (ADR 049). PostsModule only for PostOwnershipService (owning tenant). */
@Module({
  imports: [AuthModule, RbacModule, SettingsModule, PostsModule],
  controllers: [HoursController],
  providers: [HoursService, HoursRepository],
  exports: [HoursRepository],
})
export class HoursModule {}
