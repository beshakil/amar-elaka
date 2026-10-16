import { Inject, Injectable } from '@nestjs/common';
import { parseVariants } from '../media/media.types';
import { SettingsService } from '../settings/settings.service';
import { STORAGE_SERVICE, type StorageService } from '../storage/storage.ports';
import type { Attachment, InfoCard } from './dto/info-engine.dto';
import type { AttachmentRow } from './info-engine.repository';

/**
 * Attachments as the apps open them (ADR 065): a photo by its public
 * variant; a document (a notice's PDF, private) by a short-lived signed link
 * (notice_attachment_url_ttl_seconds).
 */
@Injectable()
export class InfoMedia {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly settings: SettingsService,
  ) {}

  async resolve(rows: readonly AttachmentRow[]): Promise<Attachment[]> {
    const ttl = await this.settings.get('notice_attachment_url_ttl_seconds');
    const out: Attachment[] = [];
    for (const row of rows) {
      const variants = parseVariants(row.variants);
      if (row.kind_code === 'image' && variants) {
        out.push({
          id: row.id,
          kind: 'image',
          mimeType: row.mime_type,
          url: this.storage.getPublicUrl('media', variants.full.key),
          thumbhash: row.thumbhash,
        });
      } else if (row.kind_code === 'document') {
        out.push({
          id: row.id,
          kind: 'document',
          mimeType: row.mime_type,
          url: await this.storage.presignDownload('documents', row.storage_key, ttl),
          thumbhash: null,
        });
      }
    }
    return out;
  }

  /** A card's photo: the card-size public variant. */
  cardImage(variants: unknown, thumbhash: string | null): InfoCard['image'] {
    const parsed = parseVariants(variants);
    return parsed ? { url: this.storage.getPublicUrl('media', parsed.card.key), thumbhash } : null;
  }
}
