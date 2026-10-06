'use client';

import dynamic from 'next/dynamic';

/**
 * LocationPicker as its own chunk (ADR 046): MapLibre and the map styles load
 * only when a page shows the picker (post editor, later store setup and place
 * marking), never with the rest of the page.
 */
export const LocationPickerLazy = dynamic(
  () => import('./location-picker').then((module) => module.LocationPicker),
  {
    ssr: false,
    loading: () => (
      <div
        data-testid="location-picker-loading"
        className="h-96 w-full animate-pulse rounded-lg border border-border bg-muted"
      />
    ),
  },
);
