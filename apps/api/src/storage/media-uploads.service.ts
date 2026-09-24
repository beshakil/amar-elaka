import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { mediaAssets } from '../database/schema/content';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { TenantRequiredException } from '../database/tenant.exceptions';
import { SettingsService } from '../settings/settings.service';
import type { CreateUploadDto } from './dto/create-upload.dto';
import { MEDIA_KIND_POLICIES } from './media-kind.constants';
import {
  MediaAssetNotFoundException,
  UnsupportedContentTypeException,
  UploadTooLargeException,
} from './storage.exceptions';
import { STORAGE_SERVICE, type PresignedUpload, type StorageService } from './storage.ports';

export interface CreateUploadResult {
  id: string;
  upload: PresignedUpload;
  storageKey: string;
}

@Injectable()
export class MediaUploadsService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly settings: SettingsService,
    private readonly tenantDb: TenantDb,
    private readonly tenantContext: TenantContext,
  ) {}

  async create(input: CreateUploadDto): Promise<CreateUploadResult> {
    const { tenantId, userId } = this.tenantContext.require();
    if (!tenantId || !userId) throw new TenantRequiredException();

    const policy = MEDIA_KIND_POLICIES[input.kind];
    if (!policy.allowedContentTypes.includes(input.contentType)) {
      throw new UnsupportedContentTypeException();
    }

    const maxBytes = await this.settings.get('media_max_upload_bytes', tenantId);
    if (input.byteSize > maxBytes) {
      throw new UploadTooLargeException();
    }

    const storageKey = `${tenantId}/${input.kind}/${randomUUID()}`;
    const upload = await this.storage.presignUpload(
      policy.bucket,
      storageKey,
      input.contentType,
      input.byteSize,
    );

    const [row] = await this.tenantDb.transaction((tx) =>
      tx
        .insert(mediaAssets)
        .values({
          tenantId,
          uploadedByUserId: userId,
          kindCode: input.kind,
          visibilityCode: policy.visibilityCode,
          storageKey,
          mimeType: input.contentType,
          byteSize: input.byteSize,
          checksumSha256: input.checksumSha256,
        })
        .returning({ id: mediaAssets.id }),
    );

    return { id: row!.id, upload, storageKey };
  }

  async confirm(id: string): Promise<{ status: 'ready' }> {
    const { tenantId } = this.tenantContext.require();
    if (!tenantId) throw new TenantRequiredException();

    const [row] = await this.tenantDb.transaction((tx) =>
      tx
        .update(mediaAssets)
        .set({ statusCode: 'ready' })
        .where(and(eq(mediaAssets.id, id), eq(mediaAssets.tenantId, tenantId)))
        .returning({ id: mediaAssets.id }),
    );

    if (!row) throw new MediaAssetNotFoundException();
    return { status: 'ready' };
  }
}
