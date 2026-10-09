import { join } from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { mmToPoints, type PdfImagePage } from '../../common/files/pdf';
import { encodeQr } from '../../common/files/qr';
import { escapeMarkup } from '../../seo/og-image/og-image.templates';
import { COUNTER } from './counter-card.layout';
import { COUNTER_TEXT } from './counter-card.templates';

/** The bundled Bengali font (apps/api/assets/fonts), as the share cards use. */
const FONT_FILE = join(__dirname, '..', '..', '..', 'assets', 'fonts', 'NotoSansBengali.ttf');
const MM_PER_INCH = 25.4;
/** Opaque RGB: the printed page has no transparency. */
const RGB = 3;

/**
 * Draws the counter card's pages (ADR 057) at a print resolution: pure
 * presentation — geometry from COUNTER, text from COUNTER_TEXT. Listed in
 * architecture/no-hardcoded-numbers.spec.ts's INFRASTRUCTURE_PATHS.
 */
export class CounterCardRenderer {
  constructor(private readonly dpi: number) {}

  /** A drawn page as a PNG (the seller panel's preview). */
  static png(page: PdfImagePage): Promise<Buffer> {
    return sharp(page.rgb, {
      raw: { width: page.pixelWidth, height: page.pixelHeight, channels: RGB },
    })
      .png()
      .toBuffer();
  }

  private px(mm: number): number {
    return Math.round((mm / MM_PER_INCH) * this.dpi);
  }

  private async text(body: string, font: string, color: string, widthPx: number): Promise<Buffer> {
    return sharp({
      text: {
        text: `<span foreground="${color}">${escapeMarkup(body)}</span>`,
        font,
        fontfile: FONT_FILE,
        width: widthPx,
        dpi: this.dpi,
        align: 'centre',
        wrap: 'word',
        rgba: true,
      },
    })
      .png()
      .toBuffer();
  }

  /** The code as a black-on-white square of about `sizePx`, quiet zone included. */
  private async qr(url: string, sizePx: number): Promise<Buffer> {
    const modules = encodeQr(url);
    const span = modules.length + COUNTER.quietModules * 2;
    const scale = Math.max(1, Math.floor(sizePx / span));
    const side = span * scale;
    const pixels = Buffer.alloc(side * side, 0xff);
    modules.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (!dark) return;
        for (let dy = 0; dy < scale; dy++) {
          const start =
            ((y + COUNTER.quietModules) * scale + dy) * side + (x + COUNTER.quietModules) * scale;
          pixels.fill(0, start, start + scale);
        }
      }),
    );
    return sharp(pixels, { raw: { width: side, height: side, channels: 1 } })
      .png()
      .toBuffer();
  }

  private async page(
    widthMm: number,
    heightMm: number,
    layers: OverlayOptions[],
  ): Promise<PdfImagePage> {
    const width = this.px(widthMm);
    const height = this.px(heightMm);
    const rgb = await sharp({ create: { width, height, channels: RGB, background: '#ffffff' } })
      .composite(layers)
      .removeAlpha()
      .raw()
      .toBuffer();
    return {
      widthPt: mmToPoints(widthMm),
      heightPt: mmToPoints(heightMm),
      rgb,
      pixelWidth: width,
      pixelHeight: height,
    };
  }

  /** Stacks blocks top-down, each centred; returns the layers. */
  private async stack(
    widthPx: number,
    startPx: number,
    gapPx: number,
    blocks: Buffer[],
  ): Promise<OverlayOptions[]> {
    const layers: OverlayOptions[] = [];
    let y = startPx;
    for (const input of blocks) {
      const meta = await sharp(input).metadata();
      layers.push({ input, left: Math.round((widthPx - (meta.width ?? 0)) / 2), top: y });
      y += (meta.height ?? 0) + gapPx;
    }
    return layers;
  }

  async a5(name: string, tenantName: string, url: string): Promise<PdfImagePage> {
    const L = COUNTER.a5Layout;
    const { widthMm, heightMm } = COUNTER.a5;
    const width = this.px(widthMm);
    const inner = this.px(widthMm - L.paddingMm * 2);
    const band = await sharp({
      create: { width, height: this.px(L.bandMm), channels: RGB, background: COUNTER.green },
    })
      .png()
      .toBuffer();
    const brand = await this.text(COUNTER_TEXT.brand(tenantName), L.brandFont, '#ffffff', inner);
    const brandHeight = (await sharp(brand).metadata()).height ?? 0;
    const body = await this.stack(width, this.px(L.bandMm + L.paddingMm), this.px(L.gapMm), [
      await this.text(name, L.nameFont, COUNTER.ink, inner),
      await this.text(COUNTER_TEXT.lead, L.leadFont, COUNTER.green, inner),
      await this.qr(url, this.px(L.qrMm)),
      await this.text(url, L.urlFont, COUNTER.muted, inner),
      await this.text(COUNTER_TEXT.hint, L.hintFont, COUNTER.muted, inner),
    ]);
    return this.page(widthMm, heightMm, [
      { input: band, left: 0, top: 0 },
      {
        input: brand,
        left: this.px(L.paddingMm),
        top: Math.round((this.px(L.bandMm) - brandHeight) / 2),
      },
      ...body,
    ]);
  }

  async sticker(name: string, url: string, sideMm: number): Promise<PdfImagePage> {
    const L = COUNTER.sticker;
    const width = this.px(sideMm);
    const inner = this.px(sideMm - L.paddingMm * 2);
    const blocks = [
      await this.text(name, L.nameFont, COUNTER.ink, inner),
      await this.qr(url, Math.round(width * L.qrShare)),
      await this.text(COUNTER_TEXT.stickerLead, L.leadFont, COUNTER.green, inner),
    ];
    // Centred on the sticker, top to bottom as well.
    const gap = this.px(L.gapMm);
    let total = gap * (blocks.length - 1);
    for (const block of blocks) total += (await sharp(block).metadata()).height ?? 0;
    const layers = await this.stack(
      width,
      Math.max(this.px(L.paddingMm), Math.round((width - total) / 2)),
      gap,
      blocks,
    );
    return this.page(sideMm, sideMm, layers);
  }
}
