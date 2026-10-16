'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { resolveStyle, type MapTheme } from '@amar-elaka/map-style';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import type { AgentSubmission, MapConfig } from '@/lib/api/schemas';
import { loadMapLibre } from '@/lib/map/maplibre';

const SOURCE = 'submissions';
// Presentation only: one colour per agent, from this palette (no business meaning).
const PALETTE = [
  '#2563eb',
  '#dc2626',
  '#16a34a',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#4b5563',
];

function pageTheme(): MapTheme {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === 'light' || chosen === 'dark') return chosen;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function agentColour(agentIds: readonly string[], agentId: string): string {
  const i = Math.max(0, agentIds.indexOf(agentId));
  return PALETTE[i % PALETTE.length]!;
}

function toGeoJson(items: readonly AgentSubmission[], agentIds: readonly string[]) {
  return {
    type: 'FeatureCollection' as const,
    features: items.map((s) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [s.location.lng, s.location.lat] },
      properties: {
        id: s.id,
        colour: agentColour(agentIds, s.agentId),
        flagged: s.fraudFlags.length > 0 ? 1 : 0,
      },
    })),
  };
}

/**
 * The day's submissions on our base map (ADR 043): a dot per capture in its
 * agent's colour, ringed when flagged; a click selects it in the list.
 */
export function SubmissionsMap({
  config,
  items,
  agentIds,
  label,
  onSelect,
}: {
  config: MapConfig;
  items: AgentSubmission[];
  agentIds: string[];
  label: string;
  onSelect: (id: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
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
        // Shown only with submissions (the page says "none" otherwise): centred on them.
        const first = items[0]!.location;
        const instance = new maplibregl.Map({
          container: container.current,
          style: resolveStyle(pageTheme(), {
            tilesUrl: tiles.url,
            assetsBaseUrl: config.assetsBaseUrl,
            lang: config.labelLanguage,
          }),
          center: [first.lng, first.lat],
          zoom: 14,
          attributionControl: { compact: false },
          dragRotate: false,
        });
        map.current = instance;
        instance.on('load', () => {
          instance.addSource(SOURCE, { type: 'geojson', data: toGeoJson(items, agentIds) });
          instance.addLayer({
            id: 'submission-dots',
            type: 'circle',
            source: SOURCE,
            paint: {
              'circle-radius': 7,
              'circle-color': ['get', 'colour'],
              'circle-stroke-color': ['case', ['==', ['get', 'flagged'], 1], '#f59e0b', '#ffffff'],
              'circle-stroke-width': ['case', ['==', ['get', 'flagged'], 1], 4, 2],
            },
          });
          instance.on('click', 'submission-dots', (e) => {
            const id = e.features?.[0]?.properties?.id as string | undefined;
            if (id) onSelect(id);
          });
          if (items.length > 1) {
            const lngs = items.map((s) => s.location.lng);
            const lats = items.map((s) => s.location.lat);
            instance.fitBounds(
              [
                [Math.min(...lngs), Math.min(...lats)],
                [Math.max(...lngs), Math.max(...lats)],
              ],
              { padding: 40, maxZoom: 16, duration: 0 },
            );
          }
          setState('ready');
        });
        instance.on('error', () => setState((s) => (s === 'ready' ? s : 'error')));
      })
      .catch(() => setState('error'));
    return () => {
      disposed = true;
      map.current?.remove();
      map.current = null;
    };
    // Created once per page load: a new day or agent is a new page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  return (
    <div
      ref={container}
      role="application"
      aria-label={label}
      data-state={state}
      data-testid="agent-submissions-map"
      className="h-[45vh] w-full rounded-lg border bg-muted"
    />
  );
}
