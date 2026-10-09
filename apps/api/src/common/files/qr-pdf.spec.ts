import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { imagePdf, mmToPoints } from './pdf';
import { QrCapacityError, encodeQr } from './qr';

/**
 * The QR encoder and the PDF writer (ADR 057). The QR matrices below were
 * decoded back to their text by an independent decoder (OpenCV 5's
 * QRCodeDetector) when this test was written; their hashes pin that output,
 * so any change to the encoder must be re-verified the same way.
 */

const hash = (m: boolean[][]) =>
  createHash('sha256')
    .update(m.map((row) => row.map((d) => (d ? '1' : '0')).join('')).join('\n'))
    .digest('hex');

describe('encodeQr', () => {
  it.each([
    ['a', 1, 'e8ab680854e4019c4ac89bd0e19dfe1f7e967f3cafd048091b3e3ec474b6f431'],
    [
      'https://mirpur.amarelaka.com/store/rahim-electronics-1/catalog',
      4,
      'a81f0d279d044e7428b682536c737aff3e0c15d9b81e1aefe6d279dec40023c7',
    ],
    ['HELLO WORLD 12345', 2, '1b3f913409fb20764835f49e691d3b38a9a9be2efc42825e922dce3e91351b54'],
    ['বাংলা ইউনিকোড টেক্সট', 4, '1c3fcfdefa741063ec1e2f5424b4af7da38786d9b2fb1e3b2a1e3d088f3be5dc'],
    // Version 7+: the version information blocks.
    ['x'.repeat(120), 7, 'b91b7e904d3e58a975798fdfb7444272ea2003b536350a6486d8dd7edd238cfe'],
    // Version 10: two block groups, 16-bit character count.
    [
      'https://savar.amarelaka.com/store/' + 'a'.repeat(150),
      10,
      '02389b16d297cdaae33b725e281cb6b550de56aec12df9b8a8f7b3f4e62de629',
    ],
  ])('%#: the smallest version, the verified matrix', (text, version, expected) => {
    const matrix = encodeQr(text);
    expect(matrix).toHaveLength(version * 4 + 17);
    expect(matrix.every((row) => row.length === matrix.length)).toBe(true);
    expect(hash(matrix)).toBe(expected);
  });

  it('draws the three finders and the dark module', () => {
    const m = encodeQr('a');
    const size = m.length;
    for (const [x, y] of [
      [0, 0],
      [size - 7, 0],
      [0, size - 7],
    ] as const) {
      expect(m[y]![x]).toBe(true); // outer ring
      expect(m[y + 1]![x + 1]).toBe(false); // light ring
      expect(m[y + 3]![x + 3]).toBe(true); // centre
    }
    expect(m[size - 8]![8]).toBe(true);
  });

  it('refuses text too long for version 10', () => {
    expect(() => encodeQr('x'.repeat(300))).toThrow(QrCapacityError);
  });
});

describe('imagePdf', () => {
  it('writes a valid single-image page: objects at their xref offsets, the pixels lossless', () => {
    const rgb = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    const pdf = imagePdf([
      { widthPt: mmToPoints(148), heightPt: mmToPoints(210), rgb, pixelWidth: 2, pixelHeight: 2 },
    ]);
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/MediaBox [0 0 419.53 595.28]');

    const startxref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
    const offsets = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) =>
      Number(m[1]),
    );
    expect(offsets).toHaveLength(5);
    offsets.forEach((offset, i) =>
      expect(text.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`),
    );

    const start = pdf.indexOf('stream\n', pdf.indexOf('/Subtype /Image')) + 'stream\n'.length;
    const length = Number(/\/Image[^>]*\/Length (\d+)/.exec(text)![1]);
    expect(inflateSync(pdf.subarray(start, start + length))).toEqual(rgb);
  });
});
