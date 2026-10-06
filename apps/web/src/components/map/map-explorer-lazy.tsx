'use client';

import dynamic from 'next/dynamic';

/**
 * The area map, as its own chunk (ADR 046): MapLibre, PMTiles, the styles
 * and the explorer load only on /map, never in another page's bundle.
 */
export const MapExplorerLazy = dynamic(
  () => import('./map-explorer').then((module) => module.MapExplorer),
  {
    ssr: false,
    loading: () => (
      <div
        data-testid="area-map-loading"
        className="h-[70vh] w-full animate-pulse rounded-lg border border-border bg-muted"
      />
    ),
  },
);
