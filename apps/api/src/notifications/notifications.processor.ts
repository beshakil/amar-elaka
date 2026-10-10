import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { JobRunner } from '../jobs/job-runner.service';
import { relayToDeadLetterQueueOnFinalFailure } from '../queue/dlq.util';
import {
  deadLetterQueueName,
  JOB_DELIVER_NOTIFICATION,
  JOB_NOTIFY,
  JOB_RELAY_NOTIFICATION_OUTBOX,
  QUEUE_NOTIFICATIONS,
  type DeliverNotificationJob,
  type ScheduledJobData,
} from '../queue/queue.types';
import type { OutgoingNotification } from './notification-channel';
import { NotificationDispatcher } from './notification-dispatcher';
import { NotificationOutboxRelay } from './notification-outbox.relay';

type NotificationsJob = Job<OutgoingNotification | DeliverNotificationJob | ScheduledJobData>;

/**
 * The only processor on the `notifications` queue (worker only, ADR 059).
 * Every job is retried with backoff (queue.module.ts); a delivery's last
 * failed attempt marks it failed and goes to the dead-letter queue.
 */
@Processor(QUEUE_NOTIFICATIONS)
export class NotificationsProcessor extends WorkerHost {
  constructor(
    private readonly dispatcher: NotificationDispatcher,
    private readonly outbox: NotificationOutboxRelay,
    private readonly runner: JobRunner,
    @InjectQueue(deadLetterQueueName(QUEUE_NOTIFICATIONS)) private readonly dlq: Queue,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(NotificationsProcessor.name);
  }

  async process(job: NotificationsJob): Promise<unknown> {
    switch (job.name) {
      case JOB_NOTIFY:
        return this.dispatcher.dispatch(job.data as OutgoingNotification);
      case JOB_DELIVER_NOTIFICATION:
        return this.dispatcher.deliver((job.data as DeliverNotificationJob).deliveryId);
      case JOB_RELAY_NOTIFICATION_OUTBOX:
        return this.runner.run(
          JOB_RELAY_NOTIFICATION_OUTBOX,
          job.data as ScheduledJobData,
          job.id ?? null,
          (budget) => this.outbox.relay(budget),
        );
      default:
        throw new Error(`notifications queue: unknown job ${job.name}`);
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: NotificationsJob | undefined, error: Error): Promise<void> {
    this.logger.warn({ jobId: job?.id, jobName: job?.name, err: error }, 'notification job failed');
    if (!job) return;
    if (job.name === JOB_DELIVER_NOTIFICATION) {
      const { deliveryId } = job.data as DeliverNotificationJob;
      const final = job.attemptsMade >= (job.opts.attempts ?? 1);
      const message = `${error.name}: ${error.message}`;
      await (
        final
          ? this.dispatcher.markFailed(deliveryId, message)
          : this.dispatcher.noteAttempt(deliveryId, message)
      ).catch((e: unknown) =>
        this.logger.error({ err: e, deliveryId }, 'could not record a delivery failure'),
      );
    }
    await relayToDeadLetterQueueOnFinalFailure(this.dlq, job, error);
  }
}
