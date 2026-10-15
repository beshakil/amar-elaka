import { createHmac } from 'node:crypto';

/**
 * The NID number (ADR 062), handled so that it is never stored: the API
 * normalises it, checks its shape, and keeps only
 *   - a peppered hash (HMAC-SHA256 with NID_HASH_SECRET — the NID space is
 *     small, so an unpeppered hash could be brute-forced), to spot one NID
 *     on two accounts, and
 *   - its last 3 digits, for support lookups.
 * The raw number lives only in this request's memory (and is redacted from
 * every log, logging/pino-http-options.ts).
 */

// settings-exempt: the lengths of Bangladesh NID numbers (old 13 / 17 digits, smart card 10) — a format, not a tunable
const NID_LENGTHS = new Set([10, 13, 17]);
// settings-exempt: the last-digits shown for support lookups, fixed by the column's CHECK (0058)
const LAST_DIGITS = 3;
// settings-exempt: Unicode offset of the Bengali digits (০ U+09E6)
const BENGALI_ZERO = 0x09e6;

/** Digits only, Bengali digits as ASCII; spaces and dashes ignored. Undefined if anything else is in it. */
export function normalizeNid(input: string): string | undefined {
  const ascii = input.replace(/[০-৯]/g, (d) => String(d.charCodeAt(0) - BENGALI_ZERO));
  const digits = ascii.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(digits) || !NID_LENGTHS.has(digits.length)) return undefined;
  return digits;
}

export function hashNid(normalized: string, pepper: string): { hash: string; last3: string } {
  return {
    hash: createHmac('sha256', pepper).update(normalized).digest('hex'),
    last3: normalized.slice(-LAST_DIGITS),
  };
}
