import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes and verifies a matching password', async () => {
    const hash = await service.hash('correct horse battery staple');
    await expect(service.verify(hash, 'correct horse battery staple')).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await service.hash('correct horse battery staple');
    await expect(service.verify(hash, 'wrong password')).resolves.toBe(false);
  });

  it('rejects when no hash exists, without throwing', async () => {
    await expect(service.verify(undefined, 'anything')).resolves.toBe(false);
    await expect(service.verify(null, 'anything')).resolves.toBe(false);
  });
});
