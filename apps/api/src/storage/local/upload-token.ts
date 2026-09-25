import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { StorageBucket } from '../storage.ports';

/**
 * The local driver's equivalent of an S3 presigned PUT URL: an HMAC-signed,
 * expiring grant to write exactly one object — this bucket, this key, this
 * content type, this many bytes. Anyone holding it may upload (like a
 * presigned URL), so it carries no user identity and needs no cookies.
 *
 * Format: base64url(JSON payload) "." base64url(HMAC-SHA256).
 */

const payloadSchema = z.object({
  b: z.enum(['media', 'documents']),
  k: z.string().min(1),
  t: z.string().min(1),
  s: z.number().int().nonnegative(),
  e: z.number().int().positive(),
});

export interface UploadGrant {
  bucket: StorageBucket;
  key: string;
  contentType: string;
  byteSize: number;
  /** Unix seconds. */
  expiresAt: number;
}

export type UploadTokenCheck =
  | { ok: true; grant: UploadGrant }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

/** A signing key derived from the app secret, so it is useless for anything but uploads. */
export function uploadSigningKey(appSecret: string): Buffer {
  return createHmac('sha256', appSecret).update('amar-elaka:storage-upload:v1').digest();
}

function sign(key: Buffer, body: string): string {
  return createHmac('sha256', key).update(body).digest('base64url');
}

export function signUploadToken(key: Buffer, grant: UploadGrant): string {
  const body = Buffer.from(
    JSON.stringify({
      b: grant.bucket,
      k: grant.key,
      t: grant.contentType,
      s: grant.byteSize,
      e: grant.expiresAt,
    }),
  ).toString('base64url');
  return `${body}.${sign(key, body)}`;
}

export function verifyUploadToken(
  key: Buffer,
  token: string,
  nowSeconds: number,
): UploadTokenCheck {
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
  return {
    ok: true,
    grant: {
      bucket: parsed.b,
      key: parsed.k,
      contentType: parsed.t,
      byteSize: parsed.s,
      expiresAt: parsed.e,
    },
  };
}
