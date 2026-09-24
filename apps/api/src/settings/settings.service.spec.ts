import { InvalidSettingValueException, SettingNotFoundException } from './settings.exceptions';
import type {
  InvalidationScope,
  SettingsClock,
  SettingsInvalidationBus,
  SettingsSource,
} from './settings.ports';
import { SettingsService } from './settings.service';

const TENANT_A = '0191e3a0-0000-7000-8000-00000000000a';
const TENANT_B = '0191e3a0-0000-7000-8000-00000000000b';
const TTL_MS = 60_000;

class FakeSource implements SettingsSource {
  platform = new Map<string, unknown>([
    ['grace_past_due_days', 15],
    ['post_expiry_days_default', 30],
    ['ban_ladder_days', [7, 30, null]],
    ['continuity_subsidy_max_bdt_per_month', '25000.00'],
  ]);
  overrides = new Map<string, Map<string, unknown>>();
  platformLoads = 0;
  tenantLoads = 0;

  loadPlatformSettings(): Promise<ReadonlyMap<string, unknown>> {
    this.platformLoads += 1;
    return Promise.resolve(new Map(this.platform));
  }

  loadTenantOverrides(tenantId: string): Promise<ReadonlyMap<string, unknown>> {
    this.tenantLoads += 1;
    return Promise.resolve(new Map(this.overrides.get(tenantId) ?? []));
  }
}

class FakeBus implements SettingsInvalidationBus {
  published: InvalidationScope[] = [];
  private handler: ((scope: InvalidationScope) => void) | undefined;

  publish(scope: InvalidationScope): Promise<void> {
    this.published.push(scope);
    return Promise.resolve();
  }

  subscribe(handler: (scope: InvalidationScope) => void): Promise<void> {
    this.handler = handler;
    return Promise.resolve();
  }

  deliverFromAnotherInstance(scope: InvalidationScope): void {
    this.handler?.(scope);
  }
}

class ManualClock implements SettingsClock {
  current = 0;
  now(): number {
    return this.current;
  }
}

async function setup() {
  const source = new FakeSource();
  const bus = new FakeBus();
  const clock = new ManualClock();
  const service = new SettingsService(source, bus, clock, TTL_MS);
  await service.onModuleInit();
  return { source, bus, clock, service };
}

describe('SettingsService', () => {
  it('returns the typed platform value', async () => {
    const { service } = await setup();
    await expect(service.get('grace_past_due_days')).resolves.toBe(15);
    await expect(service.get('ban_ladder_days')).resolves.toEqual([7, 30, null]);
  });

  it('returns money settings as two-decimal strings and rejects numbers', async () => {
    const { source, service } = await setup();
    await expect(service.get('continuity_subsidy_max_bdt_per_month')).resolves.toBe('25000.00');

    source.overrides.set(TENANT_A, new Map([['continuity_subsidy_max_bdt_per_month', 25000]]));
    await expect(
      service.get('continuity_subsidy_max_bdt_per_month', TENANT_A),
    ).rejects.toBeInstanceOf(InvalidSettingValueException);
  });

  it('prefers a tenant override over the platform value', async () => {
    const { source, service } = await setup();
    source.overrides.set(TENANT_A, new Map([['post_expiry_days_default', 45]]));

    await expect(service.get('post_expiry_days_default', TENANT_A)).resolves.toBe(45);
    await expect(service.get('post_expiry_days_default', TENANT_B)).resolves.toBe(30);
    await expect(service.get('grace_past_due_days', TENANT_A)).resolves.toBe(15);
  });

  it('caches loads until the TTL expires', async () => {
    const { source, clock, service } = await setup();
    await service.get('grace_past_due_days', TENANT_A);
    await service.get('post_expiry_days_default', TENANT_A);
    expect(source.platformLoads).toBe(1);
    expect(source.tenantLoads).toBe(1);

    clock.current += TTL_MS + 1;
    source.platform.set('grace_past_due_days', 20);
    await expect(service.get('grace_past_due_days', TENANT_A)).resolves.toBe(20);
    expect(source.platformLoads).toBe(2);
    expect(source.tenantLoads).toBe(2);
  });

  it('shares one load between concurrent callers', async () => {
    const { source, service } = await setup();
    await Promise.all([
      service.get('grace_past_due_days'),
      service.get('post_expiry_days_default'),
      service.get('ban_ladder_days'),
    ]);
    expect(source.platformLoads).toBe(1);
  });

  it('invalidates a tenant locally and publishes to other instances', async () => {
    const { source, bus, service } = await setup();
    await service.get('post_expiry_days_default', TENANT_A);
    source.overrides.set(TENANT_A, new Map([['post_expiry_days_default', 60]]));

    await service.invalidate(TENANT_A);

    await expect(service.get('post_expiry_days_default', TENANT_A)).resolves.toBe(60);
    expect(bus.published).toEqual([{ kind: 'tenant', tenantId: TENANT_A }]);
    expect(source.platformLoads).toBe(1);
  });

  it('invalidates everything when no tenant is given', async () => {
    const { source, bus, service } = await setup();
    await service.get('grace_past_due_days');
    source.platform.set('grace_past_due_days', 25);

    await service.invalidate();

    await expect(service.get('grace_past_due_days')).resolves.toBe(25);
    expect(bus.published).toEqual([{ kind: 'all' }]);
  });

  it('applies invalidations received from another instance', async () => {
    const { source, bus, service } = await setup();
    await service.get('grace_past_due_days');
    source.platform.set('grace_past_due_days', 18);

    bus.deliverFromAnotherInstance({ kind: 'all' });

    await expect(service.get('grace_past_due_days')).resolves.toBe(18);
  });

  it('does not cache a load that started before an invalidation', async () => {
    const { source, service } = await setup();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalLoad = source.loadPlatformSettings.bind(source);
    source.loadPlatformSettings = async () => {
      const value = await originalLoad();
      await gate;
      return value;
    };

    const staleRead = service.get('grace_past_due_days');
    await service.invalidate();
    source.platform.set('grace_past_due_days', 22);
    release?.();
    await staleRead;

    source.loadPlatformSettings = originalLoad;
    await expect(service.get('grace_past_due_days')).resolves.toBe(22);
  });

  it('throws a typed exception for a key missing from platform_settings', async () => {
    const { source, service } = await setup();
    source.platform.delete('grace_past_due_days');
    await expect(service.get('grace_past_due_days')).rejects.toBeInstanceOf(
      SettingNotFoundException,
    );
  });

  it('throws a typed exception for a wrongly typed stored value', async () => {
    const { source, service } = await setup();
    source.overrides.set(TENANT_A, new Map([['grace_past_due_days', 'fifteen']]));
    await expect(service.get('grace_past_due_days', TENANT_A)).rejects.toBeInstanceOf(
      InvalidSettingValueException,
    );
  });

  it('keeps working when the invalidation bus cannot subscribe', async () => {
    const source = new FakeSource();
    const bus = new FakeBus();
    bus.subscribe = () => Promise.reject(new Error('redis down'));
    const service = new SettingsService(source, bus, new ManualClock(), TTL_MS);

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    await expect(service.get('grace_past_due_days')).resolves.toBe(15);
  });
});
