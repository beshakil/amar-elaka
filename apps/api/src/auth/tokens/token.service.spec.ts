import { JwtService } from '@nestjs/jwt';
import { TokenService } from './token.service';

function buildService(): TokenService {
  const jwt = new JwtService({
    secret: 'test-secret-at-least-16-chars',
    signOptions: { expiresIn: '15m' },
  });
  return new TokenService(jwt, { JWT_REFRESH_TTL: '60d' });
}

describe('TokenService', () => {
  it('round-trips access token claims', async () => {
    const service = buildService();
    const claims = {
      userId: 'user-1',
      tenantId: 'tenant-1',
      memberId: 'member-1',
      role: 'member' as const,
    };
    const token = await service.signAccessToken(claims);
    await expect(service.verifyAccessToken(token)).resolves.toEqual(claims);
  });

  it('rejects a tampered token', async () => {
    const service = buildService();
    const token = await service.signAccessToken({
      userId: 'user-1',
      tenantId: 'tenant-1',
      memberId: 'member-1',
      role: 'member' as const,
    });
    await expect(service.verifyAccessToken(`${token}tampered`)).rejects.toThrow();
  });

  it('issues a refresh token whose hash is deterministic from the token', () => {
    const service = buildService();
    const issued = service.issueRefreshToken();
    expect(issued.token).toHaveLength(43); // base64url of 32 random bytes
    expect(service.hashRefreshToken(issued.token)).toBe(issued.tokenHash);
  });

  it('sets the refresh token to expire ~60 days out', () => {
    const service = buildService();
    const issued = service.issueRefreshToken();
    const days = (issued.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(59);
    expect(days).toBeLessThan(61);
  });

  it('two issued refresh tokens never share a family', () => {
    const service = buildService();
    const a = service.issueRefreshToken();
    const b = service.issueRefreshToken();
    expect(a.familyId).not.toBe(b.familyId);
  });
});
