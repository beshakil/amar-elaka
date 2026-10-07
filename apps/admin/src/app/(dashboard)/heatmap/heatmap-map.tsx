'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { resolveStyle, type MapTheme } from '@amar-elaka/map-style';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import type { Heatmap, MapConfig } from '@/lib/api/schemas';
import { cellsToGeoJson } from '@/lib/map/heatmap';
import { loadMapLibre } from '@/lib/map/maplibre';

const SOURCE = 'heat';
const FILL = 'heat-fill';
const OUTLINE = 'heat-outline';

export interface Camera {
  center: [number, number];
  zoom: number;
}

function pageTheme(): MapTheme {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === 'light' || chosen === 'dark') return chosen;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * One heatmap: our base map (ADR 043) with the API's cells as squares,
 * coloured from transparent to `colour` by each cell's share of the densest.
 * `camera` and `onMove` keep it in step with its neighbour.
 */
export function HeatmapMap({
  config,
  heatmap,
  colour,
  label,
  camera,
  onMove,
  testId,
}: {
  config: MapConfig;
  heatmap: Heatmap;
  colour: string;
  label: string;
  camera: Camera;
  onMove: (camera: Camera) => void;
  testId: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const moving = useRef(false);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    const tiles = config.tiles;
    if (!container.current || !tiles) {
      setState('error');
      return;
    }
    let disposed = false;
    void loadMapLibre()
      .then((maplibregl) => {
        if (disposed || !container.current) return;
        const instance = new maplibregl.Map({
          container: container.current,
          style: resolveStyle(pageTheme(), {
            tilesUrl: tiles.url,
            assetsBaseUrl: config.assetsBaseUrl,
            lang: config.labelLanguage,
          }),
          center: camera.center,
          zoom: camera.zoom,
          attributionControl: { compact: false },
          dragRotate: false,
        });
        map.current = instance;
        instance.on('load', () => {
          instance.addSource(SOURCE, { type: 'geojson', data: cellsToGeoJson(heatmap.cells) });
          instance.addLayer({
            id: FILL,
            type: 'fill',
            source: SOURCE,
            paint: {
              'fill-color': colour,
              'fill-opacity': ['interpolate', ['linear'], ['get', 'intensity'], 0, 0.15, 1, 0.75],
            },
          });
          instance.addLayer({
            id: OUTLINE,
            type: 'line',
            source: SOURCE,
            paint: { 'line-color': colour, 'line-width': 0.5 },
          });
          setState('ready');
        });
        instance.on('error', () => setState((s) => (s === 'ready' ? s : 'error')));
        instance.on('moveend', () => {
          if (moving.current) {
            moving.current = false;
            return;
          }
          const c = instance.getCenter();
          onMove({ center: [c.lng, c.lat], zoom: instance.getZoom() });
        });
      })
      .catch(() => setState('error'));
    return () => {
      disposed = true;
      map.current?.remove();
      map.current = null;
    };
    // The map is created once; data and camera changes go through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  useEffect(() => {
    const source = map.current?.getSource(SOURCE);
    if (source && 'setData' in source) {
      (source as { setData: (d: unknown) => void }).setData(cellsToGeoJson(heatmap.cells));
    }
  }, [heatmap]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const c = instance.getCenter();
    if (
      Math.abs(c.lng - camera.center[0]) < 1e-6 &&
      Math.abs(c.lat - camera.center[1]) < 1e-6 &&
      Math.abs(instance.getZoom() - camera.zoom) < 1e-3
    ) {
      return;
    }
    moving.current = true;
    instance.jumpTo({ center: camera.center, zoom: camera.zoom });
  }, [camera]);

  return (
    <div
      ref={container}
      role="application"
      aria-label={label}
      data-testid={testId}
      data-map-state={state}
      data-cells={heatmap.cells.length}
      className="h-[60vh] w-full overflow-hidden rounded-lg border border-border"
    />
  );
}
