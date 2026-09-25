import sharp, { type Sharp } from 'sharp';
import { rgbaToThumbHash } from './thumbhash';

/**
 * Expected hashes come from the reference implementation (npm `thumbhash`
 * 0.1.1, evanw/thumbhash) run on the same pixels; the port must match it
 * byte for byte, alpha included.
 */
async function rgba(image: Sharp) {
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

describe('ThumbHash', () => {
  it('matches the reference encoder on an opaque image', async () => {
    const { width, height, data } = await rgba(
      sharp({
        create: { width: 100, height: 60, channels: 3, background: { r: 200, g: 40, b: 90 } },
      }).composite([
        {
          input: Buffer.from(
            '<svg width="100" height="60"><circle cx="30" cy="30" r="20" fill="#0a6"/></svg>',
          ),
        },
      ]),
    );
    expect(Buffer.from(rgbaToThumbHash(width, height, data)).toString('base64')).toBe(
      'mrgCDJSwz3d3iIi+Roiwdw979w==',
    );
  });

  it('matches the reference encoder with transparency', async () => {
    const { width, height, data } = await rgba(
      sharp({
        create: {
          width: 40,
          height: 100,
          channels: 4,
          background: { r: 10, g: 120, b: 250, alpha: 0.5 },
        },
      }),
    );
    expect(Buffer.from(rgbaToThumbHash(width, height, data)).toString('base64')).toBe(
      'XyKBAgAIeYh4B7iIkIqIB09rdYh2d3c=',
    );
  });

  it('refuses input larger than 100x100', () => {
    expect(() => rgbaToThumbHash(101, 10, new Uint8Array(101 * 10 * 4))).toThrow();
  });
});
