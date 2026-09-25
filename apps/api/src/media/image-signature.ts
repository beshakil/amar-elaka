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

export type SniffedMediaType = SniffedImageType | 'application/pdf' | 'video/mp4' | 'video/webm';

// settings-exempt: file-format signatures ("%PDF-", ISO-BMFF "ftyp" at offset 4, EBML header)
const PDF = ascii('%PDF-');
const FTYP = ascii('ftyp');
// settings-exempt: see above
const FTYP_OFFSET = 4;
// settings-exempt: see above
const EBML = [0x1a, 0x45, 0xdf, 0xa3];

/**
 * The type a media kind's bytes really are, or undefined when they aren't
 * something that kind accepts (media-kind.constants.ts).
 */
export function sniffMediaType(
  kind: 'image' | 'video' | 'document',
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
  }
}
