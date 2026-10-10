import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { StorageBucket } from '../storage.ports';

/**
 * The local driver's equivalent of an S3 presigned GET URL: an HMAC-signed,
 * expiring grant to read exactly one object — this bucket, this key. Like
 * the upload token (upload-token.ts) it is the authorisation itself, so it
 * carries no user identity; its own signing key means an upload grant can
 * never be replayed as a read and the other way round.
 *
 * Format: base64url(JSON payload) "." base64url(HMAC-SHA256).
 */

const payloadSchema = z.object({
  b: z.enum(['media', 'documents']),
  k: z.string().min(1),
  e: z.number().int().positive(),
});

export interface DownloadGrant {
  bucket: StorageBucket;
  key: string;
  /** Unix seconds. */
  expiresAt: number;
}

export type DownloadTokenCheck =
  | { ok: true; grant: DownloadGrant }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

/** A signing key derived from the app secret, so it is useless for anything but downloads. */
export function downloadSigningKey(appSecret: string): Buffer {
  return createHmac('sha256', appSecret).update('amar-elaka:storage-download:v1').digest();
}

function sign(key: Buffer, body: string): string {
  return createHmac('sha256', key).update(body).digest('base64url');
}

export function signDownloadToken(key: Buffer, grant: DownloadGrant): string {
  const body = Buffer.from(
    JSON.stringify({ b: grant.bucket, k: grant.key, e: grant.expiresAt }),
  ).toString('base64url');
  return `${body}.${sign(key, body)}`;
}

export function verifyDownloadToken(
  key: Buffer,
  token: string,
  nowSeconds: number,
): DownloadTokenCheck {
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) return { ok: false, reason: 'malformed' };

  const expected = Buffer.from(sign(key, body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let parsed: z.infer<typeof payloadSchema>;
  try {
    parsed = payloadSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (parsed.e <= nowSeconds) return { ok: false, reason: 'expired' };
  return { ok: true, grant: { bucket: parsed.b, key: parsed.k, expiresAt: parsed.e } };
}
