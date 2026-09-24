import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { PgSettingsSource } from './pg-settings.source';
import { RedisSettingsInvalidationBus } from './redis-settings-invalidation.bus';
import {
  SETTINGS_CACHE_TTL_MS,
  SETTINGS_CLOCK,
  SETTINGS_INVALIDATION_BUS,
  SETTINGS_SOURCE,
  systemClock,
} from './settings.ports';
import { SettingsService } from './settings.service';

@Module({
  providers: [
    SettingsService,
    { provide: SETTINGS_SOURCE, useClass: PgSettingsSource },
    { provide: SETTINGS_INVALIDATION_BUS, useClass: RedisSettingsInvalidationBus },
    { provide: SETTINGS_CLOCK, useValue: systemClock },
    {
      provide: SETTINGS_CACHE_TTL_MS,
      inject: [APP_CONFIG],
      useFactory: (env: Env) => env.SETTINGS_CACHE_TTL_MS,
    },
  ],
  exports: [SettingsService],
})
export class SettingsModule {}
