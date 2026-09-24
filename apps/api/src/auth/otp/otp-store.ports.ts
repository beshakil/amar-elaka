export interface OtpRecord {
  codeHash: string;
  attempts: number;
}

/**
 * OTP codes and rate-limit counters live in Redis only, never Postgres
 * (docs/specs/schema.md §2.10's own note). Behind a port so unit tests use
 * an in-memory fake instead of real Redis.
 */
export interface OtpStore {
  createOtp(key: string, codeHash: string, ttlSeconds: number): Promise<void>;
  getOtp(key: string): Promise<OtpRecord | undefined>;
  incrementAttempts(key: string): Promise<number>;
  deleteOtp(key: string): Promise<void>;

  /** Sets a cooldown marker; returns false if one was already active. */
  trySetCooldown(key: string, ttlSeconds: number): Promise<boolean>;

  /** Atomically increments a rolling-window counter, starting its window on first use. Returns the new count. */
  incrementWindowedCounter(key: string, windowSeconds: number): Promise<number>;
}

export const OTP_STORE = Symbol('OTP_STORE');
