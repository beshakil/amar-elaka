import { Module } from '@nestjs/common';
import { NotificationService } from './notification.service';

/**
 * The sending side, for every module that notifies (ADR 059):
 * NotificationService only puts the notification on the queue. Everything
 * else — inbox row, channels, caps, quiet hours, delivery — runs in the
 * worker (NotificationsWorkerModule).
 */
@Module({
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationsModule {}
