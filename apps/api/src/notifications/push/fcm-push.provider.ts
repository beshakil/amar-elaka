import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';
import { TimeoutError, withRetry, withTimeout } from '../../common/utils/with-timeout';
import {
  PushRejectedError,
  PushTransientError,
  type PushMessage,
  type PushProvider,
  type PushResult,
} from './push-provider';

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const FCM_DEFAULT_URL = 'https://fcm.googleapis.com';
// settings-exempt: one retry (CLAUDE.md rule 5); the queue retries later with backoff
const ATTEMPTS = 2;
// settings-exempt: pause before the retry
const RETRY_DELAY_MS = 300;
// settings-exempt: HTTP status classes and codes
const HTTP_TOO_MANY_REQUESTS = 429;
// settings-exempt: see above
const HTTP_SERVER_ERROR = 500;
// settings-exempt: see above
const HTTP_OK = 200;
// settings-exempt: see above
const HTTP_REDIRECT = 300;
// settings-exempt: APNs' limit for apns-collapse-id, in bytes
const APNS_COLLAPSE_ID_MAX_BYTES = 64;

const serviceAccountSchema = z.object({
  project_id: z.string().min(1),
  client_email: z.string().min(1),
  private_key: z.string().min(1),
});

const errorSchema = z.object({
  error: z.object({
    code: z.number().optional(),
    status: z.string().optional(),
    message: z.string().optional(),
    details: z.array(z.object({ errorCode: z.string().optional() }).passthrough()).optional(),
  }),
});

/** How the provider reaches FCM; swapped in tests. */
export interface FcmTransport {
  accessToken(): Promise<string>;
  post(
    url: string,
    token: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<{ status: number; json: unknown }>;
}

export interface FcmConfig {
  serviceAccountJson: string;
  apiUrl: string;
  timeoutMs: number;
}

/** Thrown inside one attempt to say "retry this one". */
class RetryableAttempt extends Error {}

/**
 * Push through the FCM HTTP v1 API (ADR 059) — Android, iOS and the web
 * all hold FCM tokens. Auth is a Google service account
 * (google-auth-library, which caches and refreshes the access token).
 *
 * Every call has a timeout and one quick retry; then:
 *  - UNREGISTERED, SENDER_ID_MISMATCH, or INVALID_ARGUMENT about the token
 *    → { invalidToken } (the token is dead: remove it);
 *  - 429 / 5xx / timeout → PushTransientError (the delivery job retries);
 *  - any other refusal → PushRejectedError.
 */
export class FcmPushProvider implements PushProvider {
  readonly name = 'fcm';
  private readonly endpoint: string;

  constructor(
    private readonly config: FcmConfig,
    private readonly transport: FcmTransport = defaultTransport(config.serviceAccountJson),
  ) {
    const account = serviceAccountSchema.parse(JSON.parse(config.serviceAccountJson));
    const base = (config.apiUrl || FCM_DEFAULT_URL).replace(/\/+$/, '');
    this.endpoint = `${base}/v1/projects/${account.project_id}/messages:send`;
  }

  async send(message: PushMessage): Promise<PushResult> {
    let response: { status: number; json: unknown };
    try {
      response = await withRetry(
        async () => {
          const token = await this.transport.accessToken();
          const answer = await withTimeout(
            this.transport.post(this.endpoint, token, fcmBody(message), this.config.timeoutMs),
            this.config.timeoutMs,
          );
          if (answer.status === HTTP_TOO_MANY_REQUESTS || answer.status >= HTTP_SERVER_ERROR) {
            throw new RetryableAttempt(`HTTP ${answer.status}`);
          }
          return answer;
        },
        ATTEMPTS,
        RETRY_DELAY_MS,
      );
    } catch (error) {
      const reason =
        error instanceof TimeoutError || error instanceof RetryableAttempt
          ? error.message
          : `network: ${error instanceof Error ? error.message : String(error)}`;
      throw new PushTransientError(reason);
    }

    if (response.status >= HTTP_OK && response.status < HTTP_REDIRECT) {
      const name = z.object({ name: z.string() }).safeParse(response.json);
      return { ok: true, messageId: name.success ? name.data.name : 'fcm' };
    }
    const parsed = errorSchema.safeParse(response.json);
    const error = parsed.success ? parsed.data.error : {};
    const codes = (error.details ?? []).map((d) => d.errorCode).filter((c): c is string => !!c);
    const reason = codes[0] ?? error.status ?? `HTTP ${response.status}`;
    if (
      codes.includes('UNREGISTERED') ||
      codes.includes('SENDER_ID_MISMATCH') ||
      (error.status === 'INVALID_ARGUMENT' && /registration token/i.test(error.message ?? ''))
    ) {
      return { ok: false, invalidToken: true, reason };
    }
    throw new PushRejectedError(reason);
  }
}

/** The FCM v1 message: one token; a collapse key on every platform so updates replace. */
function fcmBody(m: PushMessage): unknown {
  const collapse = m.collapseKey;
  return {
    message: {
      token: m.token,
      notification: { ...(m.title ? { title: m.title } : {}), body: m.body },
      data: m.data,
      android: {
        priority: m.urgent ? 'HIGH' : 'NORMAL',
        ...(collapse ? { collapse_key: collapse, notification: { tag: collapse } } : {}),
      },
      apns: {
        headers: {
          'apns-priority': m.urgent ? '10' : '5',
          ...(collapse
            ? { 'apns-collapse-id': truncateBytes(collapse, APNS_COLLAPSE_ID_MAX_BYTES) }
            : {}),
        },
      },
      webpush: {
        headers: { Urgency: m.urgent ? 'high' : 'normal' },
        ...(collapse ? { notification: { tag: collapse } } : {}),
      },
    },
  };
}

function truncateBytes(text: string, max: number): string {
  const bytes = Buffer.from(text, 'utf8');
  return bytes.length <= max ? text : bytes.subarray(0, max).toString('utf8');
}

function defaultTransport(serviceAccountJson: string): FcmTransport {
  const account = serviceAccountSchema.parse(JSON.parse(serviceAccountJson));
  const auth = new GoogleAuth({
    credentials: { client_email: account.client_email, private_key: account.private_key },
    scopes: [FCM_SCOPE],
  });
  return {
    async accessToken() {
      const token = await auth.getAccessToken();
      if (!token) throw new Error('FCM: no access token from the service account');
      return token;
    },
    async post(url, token, body, timeoutMs) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: response.status, json: await response.json().catch(() => null) };
    },
  };
}
