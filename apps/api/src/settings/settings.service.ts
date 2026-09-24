import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ExpiringLoadCache } from './expiring-load-cache';
import { InvalidSettingValueException, SettingNotFoundException } from './settings.exceptions';
import {
  SETTINGS_CACHE_TTL_MS,
  SETTINGS_CLOCK,
  SETTINGS_INVALIDATION_BUS,
  SETTINGS_SOURCE,
  type InvalidationScope,
  type SettingsClock,
  type SettingsInvalidationBus,
  type SettingsSource,
} from './settings.ports';
import { SETTING_DEFINITIONS, type SettingKey, type SettingValue } from './settings.registry';

const PLATFORM_CACHE_KEY = 'platform';

/**
 * Typed read access to `platform_settings` with per-tenant overrides from
 * `tenant_settings.setting_overrides` (docs/specs/schema.md §13.34).
 *
 * Values are cached for the configured TTL and invalidated locally and across
 * instances via the invalidation bus. There are deliberately no fallback
 * defaults in code: a missing or mistyped value throws.
 */
@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);
  private readonly platformCache: ExpiringLoadCache<ReadonlyMap<string, unknown>>;
  private readonly tenantCache: ExpiringLoadCache<ReadonlyMap<string, unknown>>;

  constructor(
    @Inject(SETTINGS_SOURCE) private readonly source: SettingsSource,
    @Inject(SETTINGS_INVALIDATION_BUS) private readonly bus: SettingsInvalidationBus,
    @Inject(SETTINGS_CLOCK) clock: SettingsClock,
    @Inject(SETTINGS_CACHE_TTL_MS) cacheTtlMs: number,
  ) {
    this.platformCache = new ExpiringLoadCache(cacheTtlMs, clock);
    this.tenantCache = new ExpiringLoadCache(cacheTtlMs, clock);
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.bus.subscribe((scope) => this.applyInvalidation(scope));
    } catch (error) {
      // Without the bus, cached values are still bounded by the TTL, so the
      // API can serve requests; other instances' changes just arrive later.
      this.logger.warn(
        { err: error },
        'Settings invalidation bus unavailable; relying on cache TTL',
      );
    }
  }

  async get<K extends SettingKey>(key: K, tenantId?: string): Promise<SettingValue<K>> {
    const raw = await this.resolveRaw(key, tenantId);
    const parsed = SETTING_DEFINITIONS[key].safeParse(raw);
    if (!parsed.success) {
      throw new InvalidSettingValueException(key, tenantId, parsed.error);
    }
    return parsed.data;
  }

  /** Drops cached values here and on every other instance. Omit `tenantId` to drop everything. */
  async invalidate(tenantId?: string): Promise<void> {
    const scope: InvalidationScope =
      tenantId === undefined ? { kind: 'all' } : { kind: 'tenant', tenantId };
    this.applyInvalidation(scope);
    await this.bus.publish(scope);
  }

  private async resolveRaw(key: SettingKey, tenantId: string | undefined): Promise<unknown> {
    if (tenantId !== undefined) {
      const overrides = await this.tenantCache.get(tenantId, () =>
        this.source.loadTenantOverrides(tenantId),
      );
      if (overrides.has(key)) {
        return overrides.get(key);
      }
    }

    const platform = await this.platformCache.get(PLATFORM_CACHE_KEY, () =>
      this.source.loadPlatformSettings(),
    );
    if (!platform.has(key)) {
      throw new SettingNotFoundException(key);
    }
    return platform.get(key);
  }

  private applyInvalidation(scope: InvalidationScope): void {
    if (scope.kind === 'all') {
      this.platformCache.invalidate();
      this.tenantCache.invalidate();
      return;
    }
    this.tenantCache.invalidate(scope.tenantId);
  }
}
