import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/exceptions/domain-exception';

/** One push to one device (FCM token: Android, iOS or the web — ADR 059). */
export interface PushMessage {
  token: string;
  platform: 'android' | 'ios' | 'web';
  title: string | null;
  body: string;
  /** Delivered to the app as data (strings only). */
  data: Record<string, string>;
  /** Pushes with the same key replace each other on the device ("৪টি নতুন মেসেজ"). */
  collapseKey: string | null;
  /** High priority (wakes the device): security and account notices. */
  urgent: boolean;
}

/**
 *  - ok: the push service accepted it;
 *  - invalidToken: the token is dead (app uninstalled, token rotated) — the
 *    caller removes it from user_devices and doesn't retry.
 * Anything else throws: PushTransientError (retry later), PushRejectedError
 * (this message will never be accepted).
 */
export type PushResult =
  { ok: true; messageId: string } | { ok: false; invalidToken: true; reason: string };

export interface PushProvider {
  readonly name: string;
  send(message: PushMessage): Promise<PushResult>;
}

export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');

/** Unavailable, rate-limited, timed out: the delivery job is retried with backoff. */
export class PushTransientError extends DomainException {
  readonly code = 'PUSH_TRANSIENT';
  readonly httpStatus = HttpStatus.SERVICE_UNAVAILABLE;

  constructor(readonly reason: string) {
    super('The push service is unavailable.');
  }
}

/** The push service refused the message itself (not the token): retrying won't help. */
export class PushRejectedError extends DomainException {
  readonly code = 'PUSH_REJECTED';
  readonly httpStatus = HttpStatus.BAD_GATEWAY;

  constructor(readonly reason: string) {
    super('The push service refused the message.');
  }
}
