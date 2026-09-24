import { HttpStatus, Inject } from '@nestjs/common';
import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import nodemailer, { type Transporter } from 'nodemailer';
import { PinoLogger } from 'nestjs-pino';
import { DomainException } from '../common/exceptions/domain-exception';
import { withRetry, withTimeout } from '../common/utils/with-timeout';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { relayToDeadLetterQueueOnFinalFailure } from '../queue/dlq.util';
import {
  deadLetterQueueName,
  JOB_SEND_EMAIL,
  QUEUE_MAIL,
  type SendEmailJob,
} from '../queue/queue.types';
import { renderMailTemplate } from './template-renderer';

const SEND_TIMEOUT_MS = 10_000; // settings-exempt: SMTP call timeout, network tuning not a business rule
const SMTP_IMPLICIT_TLS_PORT = 465; // settings-exempt: well-known SMTPS port number, not a business setting

export class MailSendFailedException extends DomainException {
  readonly code = 'MAIL_SEND_FAILED';
  readonly httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;

  constructor(cause: unknown) {
    super('Failed to send the email.', { cause });
  }
}

@Processor(QUEUE_MAIL)
export class MailProcessor extends WorkerHost {
  private readonly transport: Transporter;
  private readonly fromAddress: string;

  constructor(
    @Inject(APP_CONFIG) env: Pick<Env, 'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_FROM'>,
    @InjectQueue(deadLetterQueueName(QUEUE_MAIL)) private readonly dlq: Queue,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(MailProcessor.name);
    this.fromAddress = env.SMTP_FROM;
    this.transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === SMTP_IMPLICIT_TLS_PORT,
    });
  }

  async process(job: Job<SendEmailJob>): Promise<void> {
    if (job.name !== JOB_SEND_EMAIL) return;
    const { to, template, params } = job.data;
    const html = await renderMailTemplate(template, params);

    try {
      await withRetry(() =>
        withTimeout(this.transport.sendMail({ from: this.fromAddress, to, html }), SEND_TIMEOUT_MS),
      );
    } catch (error) {
      throw new MailSendFailedException(error);
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<SendEmailJob> | undefined, error: Error): Promise<void> {
    this.logger.warn({ jobId: job?.id, err: error }, 'mail job failed');
    if (job) await relayToDeadLetterQueueOnFinalFailure(this.dlq, job, error);
  }
}
