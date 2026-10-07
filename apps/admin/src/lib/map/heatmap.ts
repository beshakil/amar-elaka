const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export interface HeatCell {
  geohash: string;
  lat: number;
  lng: number;
  count: number;
}

/** A geohash's cell as [minLng, minLat, maxLng, maxLat] (the standard bit interleaving). */
export function geohashBounds(geohash: string): [number, number, number, number] {
  let lat: [number, number] = [-90, 90];
  let lng: [number, number] = [-180, 180];
  let even = true;
  for (const char of geohash.toLowerCase()) {
    const value = BASE32.indexOf(char);
    if (value < 0) throw new Error(`not a geohash: ${geohash}`);
    for (let bit = 4; bit >= 0; bit--) {
      const on = (value >> bit) & 1;
      const range = even ? lng : lat;
      const mid = (range[0] + range[1]) / 2;
      if (even) lng = on ? [mid, lng[1]] : [lng[0], mid];
      else lat = on ? [mid, lat[1]] : [lat[0], mid];
      even = !even;
    }
  }
  return [lng[0], lat[0], lng[1], lat[1]];
}

/**
 * The API's cells as GeoJSON squares for a MapLibre fill layer. `intensity`
 * (0–1, the cell's share of the densest cell) drives the colour, so demand
 * and supply each use their whole scale; `count` is shown on hover.
 */
export function cellsToGeoJson(cells: readonly HeatCell[]) {
  const max = cells.reduce((m, c) => Math.max(m, c.count), 0);
  return {
    type: 'FeatureCollection' as const,
    features: cells.map((cell) => {
      const [w, s, e, n] = geohashBounds(cell.geohash);
      return {
        type: 'Feature' as const,
        id: cell.geohash,
        properties: { count: cell.count, intensity: max > 0 ? cell.count / max : 0 },
        geometry: {
          type: 'Polygon' as const,
          coordinates: [
            [
              [w, s],
              [e, s],
              [e, n],
              [w, n],
              [w, s],
            ],
          ],
        },
      };
    }),
  };
}

/** Where to look first: the middle of all cells, or null with none. */
export function cellsCenter(cells: readonly HeatCell[]): { lat: number; lng: number } | null {
  if (cells.length === 0) return null;
  const sum = cells.reduce((acc, c) => ({ lat: acc.lat + c.lat, lng: acc.lng + c.lng }), {
    lat: 0,
    lng: 0,
  });
  return { lat: sum.lat / cells.length, lng: sum.lng / cells.length };
}
