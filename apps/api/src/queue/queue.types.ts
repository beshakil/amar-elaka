export const QUEUE_MAIL = 'mail';
export const QUEUE_MAINTENANCE = 'maintenance';
/** Every media job (processing, orphan cleanup, purge): one queue, one processor (media/media.processor.ts). */
export const QUEUE_MEDIA = 'media';
/** Search index upkeep (outbox relay, sweeper, settings): one queue, one processor (search/indexing/search.processor.ts). */
export const QUEUE_SEARCH = 'search';

/** BullMQ has no built-in dead-letter concept — a job that exhausts its retries is relayed onto `<queue>-dlq` instead (queue/dlq.util.ts). */
export function deadLetterQueueName(queueName: string): string {
  return `${queueName}-dlq`;
}

export const JOB_SEND_EMAIL = 'send-email';
export const JOB_ENSURE_AUDIT_LOG_PARTITIONS = 'ensure-audit-log-partitions';
export const JOB_PROCESS_MEDIA = 'process-media';
export const JOB_CLEAN_ORPHAN_MEDIA = 'clean-orphan-media';
export const JOB_PURGE_DELETED_MEDIA = 'purge-deleted-media';
export const JOB_RELAY_SEARCH_OUTBOX = 'relay-search-outbox';
export const JOB_SWEEP_SEARCH_INDEX = 'sweep-search-index';
export const JOB_PURGE_SEARCH_OUTBOX = 'purge-search-outbox';
export const JOB_APPLY_SEARCH_SETTINGS = 'apply-search-settings';

export interface SendEmailJob {
  to: string;
  template: string;
  params: Record<string, string>;
}

export interface EnsureAuditLogPartitionsJob {
  months: number;
}

export interface ProcessMediaJob {
  tenantId: string;
  mediaAssetId: string;
}

/** Scheduled sweeps carry no data. */
export type MediaSweepJob = Record<string, never>;

/** Search jobs carry no data: each reads its work from the outbox or the tables. */
export type SearchJob = Record<string, never>;

/** Job name -> payload type, per queue. @InjectQueue()/@Processor() call sites are typed against this, not `any`. */
export interface QueueJobs {
  [QUEUE_MAIL]: {
    [JOB_SEND_EMAIL]: SendEmailJob;
  };
  [QUEUE_MAINTENANCE]: {
    [JOB_ENSURE_AUDIT_LOG_PARTITIONS]: EnsureAuditLogPartitionsJob;
  };
  [QUEUE_MEDIA]: {
    [JOB_PROCESS_MEDIA]: ProcessMediaJob;
    [JOB_CLEAN_ORPHAN_MEDIA]: MediaSweepJob;
    [JOB_PURGE_DELETED_MEDIA]: MediaSweepJob;
  };
  [QUEUE_SEARCH]: {
    [JOB_RELAY_SEARCH_OUTBOX]: SearchJob;
    [JOB_SWEEP_SEARCH_INDEX]: SearchJob;
    [JOB_PURGE_SEARCH_OUTBOX]: SearchJob;
    [JOB_APPLY_SEARCH_SETTINGS]: SearchJob;
  };
}
