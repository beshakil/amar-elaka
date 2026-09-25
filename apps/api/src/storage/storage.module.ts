import { Module } from '@nestjs/common';
import { S3StorageService } from './s3-storage.service';
import { STORAGE_SERVICE } from './storage.ports';

/** Object storage (MinIO in dev, R2/S3 in prod). The media pipeline lives in src/media. */
@Module({
  providers: [{ provide: STORAGE_SERVICE, useClass: S3StorageService }],
  exports: [STORAGE_SERVICE],
})
export class StorageModule {}
