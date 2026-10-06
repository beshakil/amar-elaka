/**
 * The /map page's view in its URL (ADR 046), so a map can be shared:
 * `?lat=23.75&lng=90.37&z=15&kinds=hospital,pharmacy&open=1&view=list`.
 * Every value is checked; anything malformed falls back to the default.
 */

export interface MapView {
  center: { lat: number; lng: number };
  zoom: number;
  /** map_kinds codes; null = every kind (the default). */
  kinds: string[] | null;
  openNow: boolean;
  list: boolean;
  /** Whether the URL named a place (then the page doesn't jump to the visitor). */
  shared: boolean;
}

export type LatLngBox = { minLng: number; minLat: number; maxLng: number; maxLat: number };

// Facts of the coordinate system and of web map zoom levels, not settings.
const MAX_LAT = 90;
const MAX_LNG = 180;
const MAX_ZOOM = 22;
const MIN_ZOOM = 3;
/** ~1 m: more digits only make the link longer. */
const URL_DECIMALS = 5;
const ZOOM_DECIMALS = 2;
const KIND_CODE = /^[a-z][a-z0-9_]*$/;
const MAX_KINDS = 50;

const num = (value: string | undefined | null): number | null => {
  if (value == null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export function parseMapView(
  params: Record<string, string | string[] | undefined>,
  fallback: { center: { lat: number; lng: number }; zoom: number },
): MapView {
  const one = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const lat = num(one('lat'));
  const lng = num(one('lng'));
  const zoom = num(one('z'));
  const placed =
    lat !== null && lng !== null && Math.abs(lat) <= MAX_LAT && Math.abs(lng) <= MAX_LNG;
  const kinds = (one('kinds') ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => KIND_CODE.test(k))
    .slice(0, MAX_KINDS);
  return {
    center: placed ? { lat, lng } : fallback.center,
    zoom: zoom !== null && zoom >= MIN_ZOOM && zoom <= MAX_ZOOM ? zoom : fallback.zoom,
    kinds: kinds.length > 0 ? [...new Set(kinds)] : null,
    openNow: one('open') === '1',
    list: one('view') === 'list',
    shared: placed,
  };
}

/** The query string for a view (without `?`); defaults are left out. */
export function mapViewQuery(view: Omit<MapView, 'shared'>): string {
  const params = new URLSearchParams({
    lat: view.center.lat.toFixed(URL_DECIMALS),
    lng: view.center.lng.toFixed(URL_DECIMALS),
    z: String(Number(view.zoom.toFixed(ZOOM_DECIMALS))),
  });
  if (view.kinds) params.set('kinds', view.kinds.join(','));
  if (view.openNow) params.set('open', '1');
  if (view.list) params.set('view', 'list');
  return params.toString();
}

/**
 * Whether "এই এলাকায় খুঁজুন" is offered (same rule as the app): the camera
 * rests at another zoom level, or moved more than `ratio`
 * (map_search_area_move_ratio) of the fetched viewport's width or height.
 */
export function movedEnough(input: {
  fetched: LatLngBox;
  fetchedZoom: number;
  now: LatLngBox;
  nowZoom: number;
  ratio: number;
}): boolean {
  const { fetched, now, ratio } = input;
  if (Math.floor(input.fetchedZoom) !== Math.floor(input.nowZoom)) return true;
  const width = fetched.maxLng - fetched.minLng;
  const height = fetched.maxLat - fetched.minLat;
  const dx = (now.minLng + now.maxLng - (fetched.minLng + fetched.maxLng)) / 2;
  const dy = (now.minLat + now.maxLat - (fetched.minLat + fetched.maxLat)) / 2;
  return Math.abs(dx) > width * ratio || Math.abs(dy) > height * ratio;
}
