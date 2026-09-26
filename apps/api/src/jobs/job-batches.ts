/** How much one run may do: rows per transaction, transactions per run (settings job_batch_size, job_max_batches_per_run). */
export interface JobBudget {
  batchSize: number;
  maxBatches: number;
}

/** What a run did, recorded in job_runs. */
export interface JobOutcome {
  rows: number;
  /** Stopped at maxBatches with work left over; the next run carries on. */
  capped: boolean;
  details?: Record<string, number>;
}

/**
 * Runs `batch` until it returns fewer rows than a full batch (nothing left)
 * or the run's cap is reached. Each call is its own transaction, so a failure
 * keeps the batches already done and the next run resumes where this stopped.
 */
export async function inBatches(
  budget: JobBudget,
  batch: (limit: number) => Promise<number>,
): Promise<JobOutcome> {
  let rows = 0;
  for (let run = 0; run < budget.maxBatches; run++) {
    const done = await batch(budget.batchSize);
    rows += done;
    if (done < budget.batchSize) return { rows, capped: false };
  }
  return { rows, capped: true };
}
