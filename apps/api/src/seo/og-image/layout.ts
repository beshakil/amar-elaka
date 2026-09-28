/**
 * The OG card's pixel layout (ADR 039): Open Graph's 1200×630 canvas, where
 * each block sits, font sizes and colours. Presentation only — listed in
 * architecture/no-hardcoded-numbers.spec.ts's INFRASTRUCTURE_PATHS.
 */
export const OG = {
  width: 1200,
  height: 630,
  photoWidth: 480,
  padding: 56,
  /** Text column width: canvas − photo − padding on both sides. */
  textWidth: 1200 - 480 - 56 * 2,
  background: '#0f5132',
  accent: '#ffd166',
  muted: '#d7eadf',
  soldBackground: '#b3261e',
  /** Largest size that fits the block wins; a long title steps down. */
  title: {
    top: 72,
    maxHeight: 250,
    fonts: ['Noto Sans Bengali Bold 60', 'Noto Sans Bengali Bold 50', 'Noto Sans Bengali Bold 42'],
  },
  /** Space between the flowing blocks: title, price, area. */
  gap: 28,
  price: { font: 'Noto Sans Bengali Bold 62' },
  area: { width: 600, font: 'Noto Sans Bengali 32' },
  brand: { bottom: 56, font: 'Noto Sans Bengali Bold 32' },
  sold: {
    top: 36,
    left: 1200 - 480 + 28,
    font: 'Noto Sans Bengali Bold 28',
    paddingX: 22,
    paddingY: 10,
  },
  /** Bump to re-render every cached card after a design change. */
  version: 1,
  /** Hex characters of the content hash in the cached file's name. */
  hashChars: 16,
} as const;
