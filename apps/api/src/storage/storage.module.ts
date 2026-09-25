import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { LocalStorageRoutes } from './local/local-storage.routes';
import { LocalStorageService } from './local/local-storage.service';
import { S3StorageService } from './s3-storage.service';
import { STORAGE_SERVICE, type StorageService } from './storage.ports';

/**
 * Object storage behind one port (ADR 027, 028). STORAGE_DRIVER picks the
 * implementation: `local` (a directory — dev, and the first production on a
 * Coolify volume) or `s3` (Contabo Object Storage, Backblaze B2, …). The media
 * pipeline lives in src/media and never knows which one runs.
 */
@Module({
  providers: [
    {
      provide: STORAGE_SERVICE,
      inject: [APP_CONFIG],
      useFactory: (env: Env): StorageService =>
        env.STORAGE_DRIVER === 's3' ? new S3StorageService(env) : new LocalStorageService(env),
    },
    LocalStorageRoutes,
  ],
  exports: [STORAGE_SERVICE],
})
export class StorageModule {}
