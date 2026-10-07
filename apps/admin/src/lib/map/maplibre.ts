type MapLibre = typeof import('maplibre-gl');

let loading: Promise<MapLibre> | null = null;

/**
 * MapLibre GL and the PMTiles protocol, loaded once and only in the browser
 * (both touch `window`) — as in apps/web. The base map is our own .pmtiles
 * archive (ADR 043). The worker is served from public/maplibre/<version>/
 * (scripts/copy-maplibre-worker.mjs): webpack can't follow MapLibre's own.
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
    loading = null;
  });
  return loading;
}
