import { Module } from '@nestjs/common';
import { MailProcessor } from './mail.processor';
import { MailService } from './mail.service';

/**
 * Imported by both AppModule (so `pnpm dev` alone still delivers mail in
 * local dev) and WorkerModule (so it also runs in the standalone worker
 * container). Queues themselves are registered once, globally, by
 * QueueModule — @InjectQueue() here resolves against that registration, so
 * this module does not (and must not) call BullModule.registerQueue() again.
 */
@Module({
  providers: [MailService, MailProcessor],
  exports: [MailService],
})
export class MailModule {}
