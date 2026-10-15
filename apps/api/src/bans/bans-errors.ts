import { sqlStateOf } from '../common/utils/sql-state';
import { sqlDetailOf } from '../verification/verification.exceptions';
import { banError } from './bans.exceptions';

/** Runs database work and turns AE8xx / 42501 into typed errors. */
export async function mapBanErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw banError(sqlStateOf(error), sqlDetailOf(error)) ?? error;
  }
}

/** A page size the caller asked for, capped by the setting. */
export function pageSize(requested: number | undefined, max: number): number {
  return Math.min(requested ?? max, max);
}
