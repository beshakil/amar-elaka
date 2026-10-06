import type { BoundingBox } from '../locations/geo/geodesic';

/**
 * Web Mercator tile maths (the slippy-map scheme every map library uses):
 * which 256 px tiles cover a box at a zoom, a tile range's bounds, and a
 * point snapped to the clustering grid. Pure, so it is unit-tested alone.
 */

const TILE_PX = 256; // settings-exempt: the tile size of the slippy-map scheme
const MAX_MERCATOR_LAT = 85.0511287798066; // settings-exempt: Web Mercator's latitude limit
const DEGREES_AROUND = 360; // settings-exempt: degrees of longitude in a circle
const HALF_TURN = 180; // settings-exempt: degrees in half a circle
const HALF = 0.5; // settings-exempt: the middle of a pixel cell
const FOUR = 4; // settings-exempt: the 4π of the Mercator y formula

export interface TileRange {
  zoom: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const clampLat = (lat: number) => Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));

/** Fractional world pixel x/y of a point at `zoom`. */
export function worldPixel(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const size = TILE_PX * 2 ** zoom;
  const sin = Math.sin((clampLat(lat) * Math.PI) / HALF_TURN);
  return {
    x: ((lng + HALF_TURN) / DEGREES_AROUND) * size,
    y: (HALF - Math.log((1 + sin) / (1 - sin)) / (FOUR * Math.PI)) * size,
  };
}

function pixelToLngLat(x: number, y: number, zoom: number): { lat: number; lng: number } {
  const size = TILE_PX * 2 ** zoom;
  const lng = (x / size) * DEGREES_AROUND - HALF_TURN;
  const n = Math.PI - (2 * Math.PI * y) / size;
  const lat = (HALF_TURN / Math.PI) * Math.atan(Math.sinh(n));
  return { lat, lng };
}

/** The tiles covering a box at `zoom`. */
export function tilesCovering(box: BoundingBox, zoom: number): TileRange {
  const last = 2 ** zoom - 1;
  const nw = worldPixel(box.maxLat, box.minLng, zoom);
  const se = worldPixel(box.minLat, box.maxLng, zoom);
  const tile = (px: number) => Math.min(last, Math.max(0, Math.floor(px / TILE_PX)));
  return { zoom, minX: tile(nw.x), maxX: tile(se.x), minY: tile(nw.y), maxY: tile(se.y) };
}

/** The box a tile range covers exactly. */
export function tileRangeBounds(range: TileRange): BoundingBox {
  const nw = pixelToLngLat(range.minX * TILE_PX, range.minY * TILE_PX, range.zoom);
  const se = pixelToLngLat((range.maxX + 1) * TILE_PX, (range.maxY + 1) * TILE_PX, range.zoom);
  return { minLng: nw.lng, minLat: se.lat, maxLng: se.lng, maxLat: nw.lat };
}

/** A point moved to the centre of its clustering cell (`cellPx` screen pixels at `zoom`). */
export function snapToCell(
  point: { lat: number; lng: number },
  zoom: number,
  cellPx: number,
): { lat: number; lng: number } {
  const cell = TILE_PX / Math.max(1, Math.round(TILE_PX / cellPx));
  const px = worldPixel(point.lat, point.lng, zoom);
  return pixelToLngLat(
    (Math.floor(px.x / cell) + HALF) * cell,
    (Math.floor(px.y / cell) + HALF) * cell,
    zoom,
  );
}

/** The middle of a box. */
export function boxCenter(box: BoundingBox): { lat: number; lng: number } {
  return { lat: (box.minLat + box.maxLat) / 2, lng: (box.minLng + box.maxLng) / 2 };
}
