import { z } from 'zod';

/** The WebP variants the worker writes for every public image, smallest first. */
export const variantKeys = ['thumb', 'card', 'full'] as const;
export type VariantName = (typeof variantKeys)[number];

const storedVariant = z.object({
  key: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().positive(),
});
export type StoredVariant = z.infer<typeof storedVariant>;

/** `media_assets.variants` once an image is processed. */
const storedVariants = z.object({ thumb: storedVariant, card: storedVariant, full: storedVariant });
export type StoredVariants = z.infer<typeof storedVariants>;

/** The stored variants, or undefined for an unprocessed asset (or a non-image). */
export function parseVariants(value: unknown): StoredVariants | undefined {
  const result = storedVariants.safeParse(value);
  return result.success ? result.data : undefined;
}

/** Every object key an asset owns: the original plus its variants. */
export function assetObjectKeys(storageKey: string, variants: unknown): string[] {
  const parsed = parseVariants(variants);
  return [storageKey, ...(parsed ? variantKeys.map((name) => parsed[name].key) : [])];
}

export function variantKey(storageKey: string, name: VariantName): string {
  return `${storageKey}.${name}.webp`;
}
