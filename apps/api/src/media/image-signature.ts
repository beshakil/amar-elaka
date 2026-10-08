/**
 * Identifies an image by its first bytes ("magic bytes"), never by the
 * Content-Type a client declared: a script renamed to .jpg, or an HTML page
 * uploaded as image/png, is rejected here. Only the formats the pipeline
 * accepts are recognised; everything else is `undefined`.
 */

export type SniffedImageType = 'image/jpeg' | 'image/png' | 'image/webp';

// settings-exempt: file-format signatures (JPEG/PNG/WebP specifications), not business rules
const JPEG = [0xff, 0xd8, 0xff];
// settings-exempt: see above
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF = 'RIFF';
const WEBP = 'WEBP';
// settings-exempt: "WEBP" sits at byte offset 8 of a RIFF container
const WEBP_OFFSET = 8;

/** How many leading bytes sniffImageType needs. */
// settings-exempt: covers the longest signature above (RIFF header + "WEBP" = 12 bytes)
export const IMAGE_SIGNATURE_BYTES = 16;

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.length >= offset + signature.length &&
  signature.every((byte, index) => bytes[offset + index] === byte);

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

export function sniffImageType(bytes: Uint8Array): SniffedImageType | undefined {
  if (startsWith(bytes, JPEG)) return 'image/jpeg';
  if (startsWith(bytes, PNG)) return 'image/png';
  if (startsWith(bytes, ascii(RIFF)) && startsWith(bytes, ascii(WEBP), WEBP_OFFSET)) {
    return 'image/webp';
  }
  return undefined;
}

export type SniffedMediaType =
  | SniffedImageType
  | 'application/pdf'
  | 'video/mp4'
  | 'video/webm'
  | 'application/zip'
  | 'text/csv';

// settings-exempt: file-format signatures ("%PDF-", ISO-BMFF "ftyp" at offset 4, EBML header)
const PDF = ascii('%PDF-');
const FTYP = ascii('ftyp');
// settings-exempt: see above
const FTYP_OFFSET = 4;
// settings-exempt: see above
const EBML = [0x1a, 0x45, 0xdf, 0xa3];
// settings-exempt: the ZIP local file header signature "PK\x03\x04"
const ZIP_LOCAL = [0x50, 0x4b, 0x03, 0x04];

/** No NUL bytes and valid UTF-8 (a cut multi-byte character at the end is fine): a CSV, not a binary. */
function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * The type a media kind's bytes really are, or undefined when they aren't
 * something that kind accepts (media-kind.constants.ts).
 */
export function sniffMediaType(
  kind: 'image' | 'video' | 'document' | 'import',
  bytes: Uint8Array,
): SniffedMediaType | undefined {
  const image = sniffImageType(bytes);
  switch (kind) {
    case 'image':
      return image;
    case 'document':
      if (startsWith(bytes, PDF)) return 'application/pdf';
      return image === 'image/webp' ? undefined : image;
    case 'video':
      if (startsWith(bytes, FTYP, FTYP_OFFSET)) return 'video/mp4';
      if (startsWith(bytes, EBML)) return 'video/webm';
      return undefined;
    case 'import':
      // An XLSX workbook is a ZIP too; the import job tells them apart by content.
      if (startsWith(bytes, ZIP_LOCAL)) return 'application/zip';
      return looksLikeText(bytes) ? 'text/csv' : undefined;
  }
}
