import sharp, { type OutputInfo, type Sharp } from 'sharp';
import type { SniffedImageType } from './image-signature';
import { variantKeys, type VariantName } from './media.types';
import { rgbaToThumbHash, THUMBHASH_MAX_SIZE } from './thumbhash';

/**
 * The image work of the media worker, as a pure function (bytes in, bytes
 * out) so it's testable without storage or a database:
 *
 *   - decode under a pixel limit (decompression bombs) and fail on corrupt data;
 *   - rotate by EXIF orientation, then re-encode the original in its own format
 *     with no metadata at all (sharp drops EXIF/XMP/IPTC unless asked to keep it);
 *   - WebP variants whose long edge is at most each size, never enlarged;
 *   - a ThumbHash placeholder.
 */

export interface ImagePipelineOptions {
  maxInputPixels: number;
  quality: number;
  variantSizes: Record<VariantName, number>;
}

export interface ProcessedImage {
  original: { data: Buffer; width: number; height: number };
  variants: Record<VariantName, { data: Buffer; width: number; height: number }>;
  thumbhash: string;
}

/** The bytes aren't a decodable image (or exceed the pixel limit). */
export class InvalidImageError extends Error {}

export async function processImage(
  input: Buffer,
  type: SniffedImageType,
  options: ImagePipelineOptions,
): Promise<ProcessedImage> {
  const decode = (): Sharp =>
    sharp(input, { limitInputPixels: options.maxInputPixels, failOn: 'error' }).rotate();

  let original: { data: Buffer; info: OutputInfo };
  try {
    original = await encodeLike(decode(), type, options.quality);
  } catch (error) {
    throw new InvalidImageError(`not a decodable image: ${String(error)}`);
  }

  const variants = {} as ProcessedImage['variants'];
  for (const name of variantKeys) {
    const size = options.variantSizes[name];
    const { data, info } = await decode()
      .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: options.quality })
      .toBuffer({ resolveWithObject: true });
    variants[name] = { data, width: info.width, height: info.height };
  }

  const { data: rgba, info } = await decode()
    .resize({ width: THUMBHASH_MAX_SIZE, height: THUMBHASH_MAX_SIZE, fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    original: { data: original.data, width: original.info.width, height: original.info.height },
    variants,
    thumbhash: Buffer.from(rgbaToThumbHash(info.width, info.height, rgba)).toString('base64'),
  };
}

function encodeLike(image: Sharp, type: SniffedImageType, quality: number) {
  const encoded =
    type === 'image/png'
      ? image.png()
      : type === 'image/webp'
        ? image.webp({ quality })
        : image.jpeg({ quality, mozjpeg: true });
  return encoded.toBuffer({ resolveWithObject: true });
}
