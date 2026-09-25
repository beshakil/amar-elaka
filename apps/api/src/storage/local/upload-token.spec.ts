import {
  signUploadToken,
  uploadSigningKey,
  verifyUploadToken,
  type UploadGrant,
} from './upload-token';

const KEY = uploadSigningKey('unit-test-secret-0123456789');
const GRANT: UploadGrant = {
  bucket: 'media',
  key: 'tenant/image/abc',
  contentType: 'image/jpeg',
  byteSize: 1234,
  expiresAt: 2_000,
};

describe('upload tokens', () => {
  it('round-trips a grant before it expires', () => {
    const token = signUploadToken(KEY, GRANT);
    expect(verifyUploadToken(KEY, token, 1_999)).toEqual({ ok: true, grant: GRANT });
  });

  it('refuses an expired grant', () => {
    const token = signUploadToken(KEY, GRANT);
    expect(verifyUploadToken(KEY, token, 2_000)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a grant whose payload was edited (e.g. a bigger size)', () => {
    const [, signature] = signUploadToken(KEY, GRANT).split('.');
    const forged = Buffer.from(JSON.stringify({ ...GRANT, s: 999_999 })).toString('base64url');
    expect(verifyUploadToken(KEY, `${forged}.${signature}`, 1)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a grant signed with another secret', () => {
    const token = signUploadToken(uploadSigningKey('another-secret-0123456789'), GRANT);
    expect(verifyUploadToken(KEY, token, 1)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses malformed tokens', () => {
    for (const token of ['', 'abc', 'a.b.c', '.']) {
      expect(verifyUploadToken(KEY, token, 1)).toMatchObject({ ok: false });
    }
  });
});
