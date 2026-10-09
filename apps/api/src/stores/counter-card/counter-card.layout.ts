/**
 * The shop-counter card's print layout (ADR 057), in millimetres and points
 * so it scales to any print resolution. Presentation only — listed in
 * architecture/no-hardcoded-numbers.spec.ts's INFRASTRUCTURE_PATHS.
 */
export const COUNTER = {
  /** ISO 216 A5, portrait. */
  a5: { widthMm: 148, heightMm: 210 },
  green: '#0f5132',
  ink: '#1b1b1b',
  muted: '#5b6b62',
  a5Layout: {
    bandMm: 26,
    paddingMm: 12,
    brandFont: 'Noto Sans Bengali Bold 16',
    nameFont: 'Noto Sans Bengali Bold 30',
    leadFont: 'Noto Sans Bengali 15',
    urlFont: 'Noto Sans Bengali 10',
    hintFont: 'Noto Sans Bengali 12',
    qrMm: 96,
    gapMm: 6,
  },
  sticker: {
    paddingMm: 6,
    nameFont: 'Noto Sans Bengali Bold 13',
    leadFont: 'Noto Sans Bengali 10',
    /** Of the sticker's width. */
    qrShare: 0.62,
    gapMm: 3,
  },
  /** Light modules around the code, as the QR standard requires. */
  quietModules: 4,
} as const;
