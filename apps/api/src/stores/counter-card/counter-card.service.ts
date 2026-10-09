import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { imagePdf, type PdfImagePage } from '../../common/files/pdf';
import { ShareService } from '../../engagement/share.service';
import { SettingsService } from '../../settings/settings.service';
import { StoreNotFoundException } from '../stores.exceptions';
import { StoreScope } from '../store-scope';
import { CounterCardRenderer } from './counter-card.render';
import { COUNTER_TEXT } from './counter-card.templates';

export const COUNTER_CARD_SIZES = ['a5', 'sticker'] as const;
export type CounterCardSize = (typeof COUNTER_CARD_SIZES)[number];

const STORE_ROW = z.object({
  slug: z.string(),
  name_bn: z.string(),
  tenant_slug: z.string(),
  tenant_name_bn: z.string(),
});

/**
 * The shop-counter card (ADR 057): the store's name, its WhatsApp catalog as
 * a QR code and a printed link, as a print-ready PDF — A5, or a square
 * sticker of `store_counter_sticker_mm`. Drawn by sharp/Pango (shaped
 * Bengali, like the share cards) at `store_counter_card_dpi`, stored
 * losslessly so the code scans.
 */
@Injectable()
export class CounterCardService {
  constructor(
    private readonly scope: StoreScope,
    private readonly share: ShareService,
    private readonly settings: SettingsService,
  ) {}

  /** The catalog link the code opens: the store's page on its tenant's host. */
  catalogUrl(tenantSlug: string, storeSlug: string): string {
    return `${this.share.siteFor(tenantSlug)}/store/${storeSlug}/catalog`;
  }

  async pdf(storeId: string, size: CounterCardSize): Promise<{ filename: string; body: Buffer }> {
    const { slug, page } = await this.draw(storeId, size);
    return { filename: COUNTER_TEXT.filename(slug, size), body: imagePdf([page]) };
  }

  /** The same page as a PNG: the seller panel's preview of what will print. */
  async png(storeId: string, size: CounterCardSize): Promise<Buffer> {
    const { page } = await this.draw(storeId, size);
    return CounterCardRenderer.png(page);
  }

  private async draw(
    storeId: string,
    size: CounterCardSize,
  ): Promise<{ slug: string; page: PdfImagePage }> {
    const { tenantId } = await this.scope.asPoster(storeId);
    const store = await this.scope.read(tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        select s.slug, s.name_bn, t.slug as tenant_slug, t.name_bn as tenant_name_bn
        from public.stores s join public.tenants t on t.id = s.tenant_id
        where s.tenant_id = public.current_tenant_id() and s.id = ${storeId}::uuid and s.deleted_at is null`);
      return z
        .array(STORE_ROW)
        .max(1)
        .parse([...rows])[0];
    });
    if (!store) throw new StoreNotFoundException();
    const [dpi, stickerMm] = await Promise.all([
      this.settings.get('store_counter_card_dpi', tenantId),
      this.settings.get('store_counter_sticker_mm', tenantId),
    ]);
    const url = this.catalogUrl(store.tenant_slug, store.slug);
    const card = new CounterCardRenderer(dpi);
    const page =
      size === 'a5'
        ? await card.a5(store.name_bn, store.tenant_name_bn, url)
        : await card.sticker(store.name_bn, url, stickerMm);
    return { slug: store.slug, page };
  }
}
