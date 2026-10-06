import type { Map as MapLibreMap } from 'maplibre-gl';

/**
 * The map's pins as style images (ADR 046): icons only — a coloured disc
 * with a white glyph per map_kinds icon key, drawn from inline SVG and added
 * with `addImage`, so every pin is one GPU symbol. Names are HTML, never map
 * text (MapLibre can't shape Bengali; ADR 043).
 *
 * Same keys and colours as the app (apps/mobile/lib/core/map/map_pin_images.dart).
 */

// 24×24 glyphs, white on the disc.
const GLYPHS: Record<string, string> = {
  hospital: '<path d="M10 5h4v5h5v4h-5v5h-4v-5H5v-4h5z"/>',
  pharmacy:
    '<path d="M8.5 3.5a5 5 0 0 1 7.07 0l4.93 4.93a5 5 0 0 1-7.07 7.07L8.5 10.57a5 5 0 0 1 0-7.07zm-5 5l7.07 7.07-2.12 2.12A5 5 0 0 1 1.38 10.62z"/>',
  food: '<path d="M7 3h2v6a2 2 0 0 1-1 1.73V21H6V10.73A2 2 0 0 1 5 9V3h2v5h0zm9 0c2 0 3 2 3 5s-1 4-2 4.5V21h-2V3z"/>',
  gas: '<path d="M12 2s6 5.5 6 11a6 6 0 0 1-12 0c0-3 1.5-5 3-6.5 0 2 1 3.5 2.5 3.5C11 7 12 2 12 2z"/>',
  bank: '<path d="M12 2 2 7v2h20V7zM4 11h3v7H4zm6.5 0h3v7h-3zM17 11h3v7h-3zM2 20h20v2H2z"/>',
  bus: '<path d="M5 4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v13h-1v2h-3v-2H9v2H6v-2H5zm2 2v5h10V6zm1 7.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm8 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/>',
  shop: '<path d="M4 4h16l1.5 5a3 3 0 0 1-5.25 2 3 3 0 0 1-4.5 0 3 3 0 0 1-4.5 0A3 3 0 0 1 2.5 9zM5 13.5V21h5v-5h4v5h5v-7.5a4.9 4.9 0 0 1-2.75.5 5 5 0 0 1-4.25-1.4A5 5 0 0 1 5 13.5z"/>',
  listing: '<path d="M3 3h8l10 10-8 8L3 11zm4.5 2.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/>',
};
const DEFAULT_GLYPH = '<circle cx="12" cy="12" r="4"/>';

/** Presentation: one colour per icon, readable on both map themes. */
export const PIN_COLOURS: Record<string, string> = {
  hospital: '#e03131',
  pharmacy: '#2f9e44',
  food: '#f08c00',
  gas: '#1971c2',
  bank: '#5f3dc4',
  bus: '#0c8599',
  shop: '#1c7ed6',
  listing: '#d6336c',
};
export const DEFAULT_PIN_COLOUR = '#495057';

export const pinColour = (icon: string | null | undefined): string =>
  (icon && PIN_COLOURS[icon]) || DEFAULT_PIN_COLOUR;

/** Style image name for an icon key (null = the generic pin). */
export const pinImageName = (icon: string | null | undefined): string =>
  `ae-pin-${icon ?? 'default'}`;

/** The pin as an SVG document (also used inline in the panel and the layer list). */
export function pinSvg(icon: string | null | undefined, size = 30): string {
  const glyph = (icon && GLYPHS[icon]) || DEFAULT_GLYPH;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 30 30">` +
    `<circle cx="15" cy="15" r="14" fill="#fff"/>` +
    `<circle cx="15" cy="15" r="12" fill="${pinColour(icon)}"/>` +
    `<g transform="translate(5.4 5.4) scale(0.8)" fill="#fff">${glyph}</g></svg>`
  );
}

/** Adds every pin image the given icon keys need (again after each style load). */
export async function addPinImages(
  map: MapLibreMap,
  icons: Iterable<string | null>,
): Promise<void> {
  const ratio = Math.max(1, Math.round(window.devicePixelRatio || 1));
  await Promise.all(
    [...new Set(icons)].map(async (icon) => {
      const name = pinImageName(icon);
      if (map.hasImage(name)) return;
      const image = new Image(30 * ratio, 30 * ratio);
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(pinSvg(icon, 30 * ratio))}`;
      await image.decode();
      if (!map.hasImage(name)) map.addImage(name, image, { pixelRatio: ratio });
    }),
  );
}
