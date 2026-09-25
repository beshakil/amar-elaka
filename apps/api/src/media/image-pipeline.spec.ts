import sharp from 'sharp';
import { InvalidImageError, processImage, type ImagePipelineOptions } from './image-pipeline';

const options: ImagePipelineOptions = {
  maxInputPixels: 40_000_000,
  quality: 80,
  variantSizes: { thumb: 200, card: 600, full: 1200 },
};

const photo = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 20, g: 120, b: 200 } } });

describe('processImage', () => {
  it('writes thumb/card/full WebP variants by long edge', async () => {
    const input = await photo(2400, 1600).jpeg().toBuffer();
    const result = await processImage(input, 'image/jpeg', options);

    expect(result.original).toMatchObject({ width: 2400, height: 1600 });
    expect(
      Object.fromEntries(
        Object.entries(result.variants).map(([name, v]) => [name, [v.width, v.height]]),
      ),
    ).toEqual({ thumb: [200, 133], card: [600, 400], full: [1200, 800] });
    for (const variant of Object.values(result.variants)) {
      expect((await sharp(variant.data).metadata()).format).toBe('webp');
    }
    expect(Buffer.from(result.thumbhash, 'base64').length).toBeGreaterThan(4);
  });

  it('uses the long edge for portrait images and never enlarges small ones', async () => {
    const portrait = await processImage(
      await photo(900, 1800).png().toBuffer(),
      'image/png',
      options,
    );
    expect([portrait.variants.full.width, portrait.variants.full.height]).toEqual([600, 1200]);

    const small = await processImage(
      await photo(300, 150).webp().toBuffer(),
      'image/webp',
      options,
    );
    expect([small.variants.card.width, small.variants.full.width]).toEqual([300, 300]);
    expect(small.variants.thumb.width).toBe(200);
  });

  it('strips EXIF (GPS included) after applying its orientation', async () => {
    // Stored 400x200 but tagged "rotate 90°": it is really 200x400.
    const input = await photo(400, 200)
      .jpeg()
      .withExif({
        IFD0: { Make: 'TestCam' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '23/1 48/1 0/1' },
      })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const result = await processImage(input, 'image/jpeg', options);
    const meta = await sharp(result.original.data).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect([result.original.width, result.original.height]).toEqual([200, 400]);
    expect(meta.format).toBe('jpeg');
  });

  it('rejects corrupt data and images above the pixel limit', async () => {
    const jpeg = await photo(400, 400).jpeg().toBuffer();
    await expect(
      processImage(jpeg.subarray(0, jpeg.length / 2), 'image/jpeg', options),
    ).rejects.toThrow(InvalidImageError);
    await expect(
      processImage(jpeg, 'image/jpeg', { ...options, maxInputPixels: 100 * 100 }),
    ).rejects.toThrow(InvalidImageError);
  });
});
