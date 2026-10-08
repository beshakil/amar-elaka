import { Inject, Injectable } from '@nestjs/common';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { parseVariants } from '../media/media.types';
import { STORAGE_SERVICE, type StorageService } from '../storage/storage.ports';
import type { MapPreview, MapPreviewParams, MapPreviewQuery } from './map-preview.dto';
import { MapPreviewRepository } from './map-preview.repository';
import { MapFeatureNotFoundException } from './map.exceptions';

/** A post has one title: it is the Bengali name when written in Bengali (as map_features does). */
const BENGALI = /[ঀ-৿]/;

/**
 * The Map tab's preview sheet (ADR 046): photo, phones and address for one
 * tapped feature, read as an anonymous visitor of the feature's own tenant —
 * the same public-read policies as every other public page. Our own data
 * only; never a geo provider call.
 */
@Injectable()
export class MapPreviewService {
  constructor(
    private readonly repo: MapPreviewRepository,
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  async preview(params: MapPreviewParams, query: MapPreviewQuery): Promise<MapPreview> {
    const row = await this.context.run({ tenantId: query.tenant, role: 'anon' }, () =>
      this.tenantDb.transaction((tx) => this.repo.preview(tx, params.layer, params.id), {
        accessMode: 'read only',
      }),
    );
    if (!row) throw new MapFeatureNotFoundException();
    const variants = parseVariants(row.cover_variants);
    const title = row.title;
    return {
      layer: params.layer,
      id: params.id,
      tenantId: query.tenant,
      name:
        title !== null
          ? { bn: BENGALI.test(title) ? title : null, en: BENGALI.test(title) ? null : title }
          : { bn: row.name_bn, en: row.name_en },
      photo: variants
        ? {
            url: this.storage.getPublicUrl('media', variants.card.key),
            thumbhash: row.cover_thumbhash,
          }
        : null,
      // Posts and stores are called through their contact endpoints, which record the lead.
      phones: params.layer === 'posts' || params.layer === 'stores' ? [] : (row.phones ?? []),
      address: row.address,
    };
  }
}
