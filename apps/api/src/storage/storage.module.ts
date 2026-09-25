import { Module } from '@nestjs/common';
import { S3StorageService } from './s3-storage.service';
import { STORAGE_SERVICE } from './storage.ports';

/** S3-compatible object storage (Contabo now, Backblaze B2 later — ADR 027). The media pipeline lives in src/media. */
@Module({
  providers: [{ provide: STORAGE_SERVICE, useClass: S3StorageService }],
  exports: [STORAGE_SERVICE],
})
export class StorageModule {}
