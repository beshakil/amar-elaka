/**
 * Client-side compression before upload, matching the mobile app: the long
 * edge at most 1200px (the API's largest variant, media_variant_full_px, so
 * nothing useful is thrown away), WebP at quality 0.8. Re-encoding through a
 * canvas also drops EXIF — location included — before the file leaves the
 * device; the server strips it again regardless.
 */
export const UPLOAD_COMPRESSION = {
  maxLongEdge: 1200,
  quality: 0.8,
  contentType: 'image/webp',
} as const;

/** Types the picker offers; the server checks the real bytes. */
export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** The photo could not be decoded (not an image, or corrupt). */
export class ImageDecodeError extends Error {
  constructor(cause?: unknown) {
    super('The file could not be read as an image.', { cause });
    this.name = 'ImageDecodeError';
  }
}

/** Size that fits the long edge within `maxLongEdge`, never enlarged. */
export function fitWithin(
  width: number,
  height: number,
  maxLongEdge: number = UPLOAD_COMPRESSION.maxLongEdge,
): { width: number; height: number } {
  const scale = Math.min(1, maxLongEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function isAcceptedImage(file: Blob): boolean {
  return (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type);
}

/**
 * Decodes (honouring EXIF orientation), scales down and re-encodes as WebP.
 * A browser that can't encode WebP silently hands back PNG; that would be
 * bigger than the original, so fall back to JPEG, which the API also accepts.
 */
export async function compressImage(
  file: Blob,
  options: { maxLongEdge: number; quality: number } = UPLOAD_COMPRESSION,
): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (cause) {
    throw new ImageDecodeError(cause);
  }
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, options.maxLongEdge);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new ImageDecodeError('no 2d canvas');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);

    const webp = await toBlob(canvas, UPLOAD_COMPRESSION.contentType, options.quality);
    if (webp.type === UPLOAD_COMPRESSION.contentType) return webp;
    return await toBlob(canvas, 'image/jpeg', options.quality);
  } finally {
    bitmap.close();
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new ImageDecodeError('encode failed'))),
      type,
      quality,
    ),
  );
}
