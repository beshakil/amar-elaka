import type { Job, Queue } from 'bullmq';

/**
 * BullMQ has no built-in dead-letter queue — this is the standard way to add
 * one: when a job has used up every retry (not just failed once, which
 * `@OnWorkerEvent('failed')` also fires for on intermediate attempts), relay
 * it onto the sibling `<queue>-dlq` queue for inspection/replay, instead of
 * letting it just sit in the original queue's "failed" set.
 */
export async function relayToDeadLetterQueueOnFinalFailure(
  dlq: Queue,
  job: Job<unknown>,
  error: Error,
): Promise<void> {
  const maxAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < maxAttempts) return;

  await dlq.add(job.name, {
    originalData: job.data,
    failedReason: error.message,
    attemptsMade: job.attemptsMade,
  });
}
