export const QUEUE_MAIL = 'mail';
export const QUEUE_MAINTENANCE = 'maintenance';

/** BullMQ has no built-in dead-letter concept — a job that exhausts its retries is relayed onto `<queue>-dlq` instead (queue/dlq.util.ts). */
export function deadLetterQueueName(queueName: string): string {
  return `${queueName}-dlq`;
}

export const JOB_SEND_EMAIL = 'send-email';
export const JOB_ENSURE_AUDIT_LOG_PARTITIONS = 'ensure-audit-log-partitions';

export interface SendEmailJob {
  to: string;
  template: string;
  params: Record<string, string>;
}

export interface EnsureAuditLogPartitionsJob {
  months: number;
}

/** Job name -> payload type, per queue. @InjectQueue()/@Processor() call sites are typed against this, not `any`. */
export interface QueueJobs {
  [QUEUE_MAIL]: {
    [JOB_SEND_EMAIL]: SendEmailJob;
  };
  [QUEUE_MAINTENANCE]: {
    [JOB_ENSURE_AUDIT_LOG_PARTITIONS]: EnsureAuditLogPartitionsJob;
  };
}
