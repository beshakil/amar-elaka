import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { SettingsModule } from '../../settings/settings.module';
import { InboxController } from './inbox.controller';
import { InboxRepository } from './inbox.repository';
import { InboxService } from './inbox.service';

/**
 * The user's in-app inbox (GET /notifications). Apart from NotificationsModule,
 * which the workers import to send: they have no HTTP routes or auth.
 */
@Module({
  imports: [AuthModule, SettingsModule],
  controllers: [InboxController],
  providers: [InboxService, InboxRepository],
})
export class InboxModule {}
