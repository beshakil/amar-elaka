import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { JOB_SEND_EMAIL, QUEUE_MAIL, type SendEmailJob } from '../queue/queue.types';

/**
 * Never sends inline — every call only enqueues onto the `mail` BullMQ
 * queue; `MailProcessor` (registered in both the HTTP app and the worker)
 * does the actual rendering + SMTP send.
 */
@Injectable()
export class MailService {
  constructor(@InjectQueue(QUEUE_MAIL) private readonly queue: Queue<SendEmailJob>) {}

  async send(to: string, template: string, params: Record<string, string>): Promise<void> {
    await this.queue.add(JOB_SEND_EMAIL, { to, template, params });
  }
}
