import {
  downloadSigningKey,
  signDownloadToken,
  verifyDownloadToken,
  type DownloadGrant,
} from './download-token';
import { signUploadToken, uploadSigningKey } from './upload-token';

const SECRET = 'unit-test-secret-0123456789';
const KEY = downloadSigningKey(SECRET);
const GRANT: DownloadGrant = {
  bucket: 'documents',
  key: 'tenant/chat_image/abc',
  expiresAt: 2_000,
};

describe('download tokens', () => {
  it('round-trips a grant before it expires', () => {
    const token = signDownloadToken(KEY, GRANT);
    expect(verifyDownloadToken(KEY, token, 1_999)).toEqual({ ok: true, grant: GRANT });
  });

  it('refuses an expired grant', () => {
    const token = signDownloadToken(KEY, GRANT);
    expect(verifyDownloadToken(KEY, token, 2_000)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a grant whose payload was edited (another object)', () => {
    const [, signature] = signDownloadToken(KEY, GRANT).split('.');
    const forged = Buffer.from(
      JSON.stringify({ b: 'documents', k: 'tenant/chat_image/other', e: 2_000 }),
    ).toString('base64url');
    expect(verifyDownloadToken(KEY, `${forged}.${signature}`, 1_000)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('never accepts an upload token as a read grant', () => {
    const upload = signUploadToken(uploadSigningKey(SECRET), {
      bucket: 'documents',
      key: GRANT.key,
      contentType: 'image/jpeg',
      byteSize: 10,
      expiresAt: 2_000,
    });
    expect(verifyDownloadToken(KEY, upload, 1_000)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses garbage', () => {
    expect(verifyDownloadToken(KEY, 'not-a-token', 1_000)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});
