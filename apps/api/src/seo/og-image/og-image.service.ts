import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { TenantContext } from '../../database/tenant-context';
import { TenantDb } from '../../database/tenant-db';
import { parseVariants } from '../../media/media.types';
import { STORAGE_SERVICE, type StorageService } from '../../storage/storage.ports';
import { OgImageNotFoundException } from '../seo.exceptions';
import { SeoRepository, type OgRow } from '../seo.repository';
import { OG } from './layout';
import { escapeMarkup, OG_TEXT, ogPriceLine } from './og-image.templates';

/** The bundled Bengali font (apps/api/assets/fonts): Pango shapes conjuncts with it. */
const FONT_FILE = join(__dirname, '..', '..', '..', 'assets', 'fonts', 'NotoSansBengali.ttf');
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * A listing's share image (ADR 039): cover photo, Bengali title, price,
 * area and the tenant's brand, 1200×630. Rendered with sharp — libvips'
 * Pango/HarfBuzz text shapes Bengali correctly, which Satori (next/og)
 * can't — and kept in storage under a hash of what it shows, so a post is
 * rendered once per version and every later request is a storage read.
 */
@Injectable()
export class OgImageService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: SeoRepository,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  async png(postId: string): Promise<Buffer> {
    const status = await this.tenantDb.transaction((tx) => this.repo.listingStatus(tx, postId), {
      accessMode: 'read only',
    });
    if (!status || (status.state !== 'live' && status.state !== 'sold')) {
      throw new OgImageNotFoundException();
    }
    // Read as a visitor of the owning tenant: only what the public may see.
    const data = await this.context.run({ tenantId: status.tenant_id, role: 'anon' }, () =>
      this.tenantDb.transaction((tx) => this.repo.ogData(tx, postId), { accessMode: 'read only' }),
    );
    if (!data) throw new OgImageNotFoundException();

    const coverKey = parseVariants(data.cover_variants)?.full.key ?? null;
    const key = `og/${postId}/${versionOf(data, coverKey)}.png`;
    if (await this.storage.head('media', key)) return this.storage.getObject('media', key);

    const cover = coverKey ? await this.storage.getObject('media', coverKey) : null;
    const png = await render(data, cover);
    await this.storage.putObject('media', key, png, 'image/png', CACHE_CONTROL);
    return png;
  }
}

function versionOf(data: OgRow, coverKey: string | null): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        OG.version,
        data.title,
        data.price,
        data.price_type_code,
        data.status_code,
        data.area_bn,
        data.tenant_name_bn,
        coverKey,
      ]),
    )
    .digest('hex')
    .slice(0, OG.hashChars);
}

async function text(markup: string, font: string, width: number): Promise<Buffer> {
  return sharp({
    text: { text: markup, font, fontfile: FONT_FILE, width, rgba: true, wrap: 'word' },
  })
    .png()
    .toBuffer();
}

/** The title at the largest listed size that fits its block (never scaled up). */
async function fittedTitle(markup: string, width: number): Promise<Buffer> {
  const [largest, ...smaller] = OG.title.fonts;
  let rendered = await text(markup, largest, width);
  for (const font of [null, ...smaller]) {
    if (font) rendered = await text(markup, font, width);
    const { height = 0 } = await sharp(rendered).metadata();
    if (height <= OG.title.maxHeight) return rendered;
  }
  // Still too long at the smallest size: cut the overflow off the bottom.
  const { width: actual = width } = await sharp(rendered).metadata();
  return sharp(rendered)
    .extract({ left: 0, top: 0, width: actual, height: OG.title.maxHeight })
    .png()
    .toBuffer();
}

// settings-exempt: pixel formats — RGBA for the transparent sold pill, RGB for the opaque canvas
const RGBA = 4;
// settings-exempt: see above
const RGB = 3;

async function render(data: OgRow, cover: Buffer | null): Promise<Buffer> {
  const textWidth = OG.textWidth;
  const layers: OverlayOptions[] = [];

  if (cover) {
    const photo = await sharp(cover).resize(OG.photoWidth, OG.height, { fit: 'cover' }).toBuffer();
    layers.push({ input: photo, left: OG.width - OG.photoWidth, top: 0 });
  }
  const span = (color: string, body: string) =>
    `<span foreground="${color}">${escapeMarkup(body)}</span>`;

  // Title, price and area flow down from the top; the brand sits at the bottom.
  let y: number = OG.title.top;
  const flow = async (input: Buffer) => {
    layers.push({ input, left: OG.padding, top: y });
    y += ((await sharp(input).metadata()).height ?? 0) + OG.gap;
  };
  await flow(await fittedTitle(span('#ffffff', data.title), textWidth));
  await flow(
    await text(
      span(OG.accent, ogPriceLine(data.price, data.price_type_code)),
      OG.price.font,
      textWidth,
    ),
  );
  const where = [data.area_bn, data.tenant_name_bn].filter(Boolean).join(', ');
  await flow(await text(span(OG.muted, where), OG.area.font, OG.area.width));
  const brand = await text(
    span('#ffffff', `${OG_TEXT.brand} · ${data.tenant_name_bn}`),
    OG.brand.font,
    textWidth,
  );
  const brandHeight = (await sharp(brand).metadata()).height ?? 0;
  layers.push({ input: brand, left: OG.padding, top: OG.height - OG.brand.bottom - brandHeight });

  if (data.status_code === 'sold') {
    const label = await text(span('#ffffff', OG_TEXT.sold), OG.sold.font, textWidth);
    const meta = await sharp(label).metadata();
    const pill = await sharp({
      create: {
        width: (meta.width ?? 0) + OG.sold.paddingX + OG.sold.paddingX,
        height: (meta.height ?? 0) + OG.sold.paddingY + OG.sold.paddingY,
        channels: RGBA,
        background: OG.soldBackground,
      },
    })
      .composite([{ input: label, left: OG.sold.paddingX, top: OG.sold.paddingY }])
      .png()
      .toBuffer();
    layers.push({ input: pill, left: OG.sold.left, top: OG.sold.top });
  }

  return sharp({
    create: { width: OG.width, height: OG.height, channels: RGB, background: OG.background },
  })
    .composite(layers)
    .png()
    .toBuffer();
}
