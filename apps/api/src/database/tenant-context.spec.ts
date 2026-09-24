import { ZodError } from 'zod';
import { TenantContext, TenantContextMissingException } from './tenant-context';

const TENANT_A = '0191e3a0-0000-7000-8000-00000000000a';
const TENANT_B = '0191e3a0-0000-7000-8000-00000000000b';
const USER = '0191e3a0-0000-7000-8000-0000000000c1';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('TenantContext', () => {
  const context = new TenantContext();

  it('has no store outside a scope', () => {
    expect(context.current()).toBeUndefined();
    expect(() => context.require()).toThrow(TenantContextMissingException);
    expect(() => context.set({ tenantId: TENANT_A })).toThrow(TenantContextMissingException);
  });

  it('exposes the store to everything awaited inside the scope', async () => {
    await context.run({ tenantId: TENANT_A, userId: USER }, async () => {
      await tick(1);
      await Promise.resolve();
      expect(context.require()).toEqual({ tenantId: TENANT_A, userId: USER });
    });
  });

  it('isolates concurrent scopes across interleaved awaits', async () => {
    const tenants = Array.from({ length: 40 }, (_, index) =>
      index % 2 === 0 ? TENANT_A : TENANT_B,
    );
    const seen = await Promise.all(
      tenants.map((tenantId, index) =>
        context.run({}, async () => {
          await tick(index % 5);
          context.set({ tenantId });
          await tick((index * 7) % 5);
          return context.require().tenantId;
        }),
      ),
    );
    expect(seen).toEqual(tenants);
  });

  it('does not let a scope mutate the object passed to run()', async () => {
    const initial = { tenantId: TENANT_A };
    await context.run(initial, async () => {
      context.set({ tenantId: TENANT_B });
      await tick(1);
    });
    expect(initial.tenantId).toBe(TENANT_A);
  });

  it('rejects malformed identifiers and unknown roles', () => {
    expect(() => context.run({ tenantId: "x'; drop table users; --" }, () => undefined)).toThrow(
      ZodError,
    );
    context.run({}, () => {
      expect(() => context.set({ userId: 'not-a-uuid' })).toThrow(ZodError);
    });
    expect(() =>
      context.run({ role: 'superuser' } as unknown as Parameters<TenantContext['run']>[0], () => 0),
    ).toThrow(ZodError);
  });
});
