import { deflateSync } from 'node:zlib';

/** Points per inch: PDF's unit. */
const POINTS_PER_INCH = 72;
const MM_PER_INCH = 25.4;

export const mmToPoints = (mm: number) => (mm * POINTS_PER_INCH) / MM_PER_INCH;

export interface PdfImagePage {
  /** Page size in points. */
  widthPt: number;
  heightPt: number;
  /** Raw 8-bit RGB pixels, row by row, filling the whole page. */
  rgb: Buffer;
  pixelWidth: number;
  pixelHeight: number;
}

/**
 * A minimal PDF 1.4 (ADR 057): one page per image, each image filling its
 * page, stored losslessly (FlateDecode) so a QR code's edges stay sharp in
 * print. The text is already drawn into the image (Bengali shaped by
 * Pango), so the PDF needs no fonts.
 */
export function imagePdf(pages: readonly PdfImagePage[]): Buffer {
  const objects: Buffer[] = [];
  const add = (body: Buffer | string) =>
    objects.push(typeof body === 'string' ? Buffer.from(body, 'latin1') : body);
  const stream = (dict: string, data: Buffer) =>
    Buffer.concat([
      Buffer.from(`${dict.replace(/>>$/, `/Length ${data.length} >>`)}\nstream\n`, 'latin1'),
      data,
      Buffer.from('\nendstream', 'latin1'),
    ]);

  // 1 catalog, 2 pages; then page, image, contents per page.
  const pageIds = pages.map((_, i) => 3 + i * 3);
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  );
  pages.forEach((page, i) => {
    const id = pageIds[i]!;
    const w = page.widthPt.toFixed(2);
    const h = page.heightPt.toFixed(2);
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
        `/Resources << /XObject << /Im${i} ${id + 1} 0 R >> >> /Contents ${id + 2} 0 R >>`,
    );
    add(
      stream(
        `<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} /Height ${page.pixelHeight} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode >>`,
        deflateSync(page.rgb),
      ),
    );
    add(stream('<< >>', Buffer.from(`q ${w} 0 0 ${h} 0 0 cm /Im${i} Do Q`, 'latin1')));
  });

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let length = parts[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(length);
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    parts.push(chunk);
    length += chunk.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}
