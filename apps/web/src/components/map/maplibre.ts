type MapLibre = typeof import('maplibre-gl');

let loading: Promise<MapLibre> | null = null;

/**
 * MapLibre GL and the PMTiles protocol, loaded once and only in the browser
 * (both touch `window`). The base map is one .pmtiles archive read by HTTP
 * range requests (ADR 043): `pmtiles://<url>` in a style goes through this
 * protocol. The worker is served from public/maplibre/<version>/ — webpack
 * can't follow MapLibre's own worker URL (scripts/copy-maplibre-worker.mjs).
 */
export function loadMapLibre(): Promise<MapLibre> {
  loading ??= (async () => {
    const [maplibregl, { Protocol }] = await Promise.all([
      import('maplibre-gl'),
      import('pmtiles'),
    ]);
    maplibregl.setWorkerUrl(`/maplibre/${maplibregl.getVersion()}/maplibre-gl-worker.mjs`);
    maplibregl.addProtocol('pmtiles', new Protocol({ metadata: true }).tile);
    return maplibregl;
  })();
  loading.catch(() => {
    loading = null; // a failed chunk load can be retried by the next map
  });
  return loading;
}
