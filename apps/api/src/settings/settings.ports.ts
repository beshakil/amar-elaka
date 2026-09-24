import { z } from 'zod';

/** Where settings come from: `platform_settings` rows and per-tenant overrides. */
export interface SettingsSource {
  loadPlatformSettings(): Promise<ReadonlyMap<string, unknown>>;
  loadTenantOverrides(tenantId: string): Promise<ReadonlyMap<string, unknown>>;
}

export const InvalidationScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('tenant'), tenantId: z.string().uuid() }),
]);

export type InvalidationScope = z.infer<typeof InvalidationScopeSchema>;

/** Cluster-wide cache invalidation, so every API instance drops stale settings. */
export interface SettingsInvalidationBus {
  publish(scope: InvalidationScope): Promise<void>;
  subscribe(handler: (scope: InvalidationScope) => void): Promise<void>;
}

export interface SettingsClock {
  now(): number;
}

export const SETTINGS_SOURCE = Symbol('SETTINGS_SOURCE');
export const SETTINGS_INVALIDATION_BUS = Symbol('SETTINGS_INVALIDATION_BUS');
export const SETTINGS_CLOCK = Symbol('SETTINGS_CLOCK');
export const SETTINGS_CACHE_TTL_MS = Symbol('SETTINGS_CACHE_TTL_MS');

export const systemClock: SettingsClock = { now: () => Date.now() };
