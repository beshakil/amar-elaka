'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { resolveStyle, type MapLabelLanguage, type MapTheme } from '@amar-elaka/map-style';
import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { MapConfig } from '@/lib/api/schemas';
import { cn } from '@/lib/utils';
import { loadMapLibre } from './maplibre';

type MapLibre = typeof import('maplibre-gl');

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** The page's theme: `<html data-theme>` when the visitor chose one, else the OS setting. */
function readPageTheme(): MapTheme {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === 'light' || chosen === 'dark') return chosen;
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

function subscribePageTheme(onChange: () => void): () => void {
  const media = window.matchMedia(DARK_QUERY);
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  media.addEventListener('change', onChange);
  return () => {
    observer.disconnect();
    media.removeEventListener('change', onChange);
  };
}

export function usePageTheme(): MapTheme {
  return useSyncExternalStore(subscribePageTheme, readPageTheme, () => 'light');
}

/**
 * The style to load: ours over the self-hosted archive, else none (the map
 * says it is unavailable). Never a third-party style: CLAUDE.md map rules.
 */
function styleFor(
  config: MapConfig,
  theme: MapTheme,
  lang: MapLabelLanguage,
): StyleSpecification | null {
  if (!config.tiles) return null;
  return resolveStyle(theme, {
    tilesUrl: config.tiles.url,
    assetsBaseUrl: config.assetsBaseUrl,
    lang,
  });
}

export interface BaseMapProps {
  /** GET /map/config; null when the API couldn't say (the map shows a notice). */
  config: MapConfig | null;
  center: { lat: number; lng: number };
  zoom: number;
  /** Accessible name of the map region. */
  label: string;
  /** Overrides the `map_label_language` setting (the Bengali shaping debug page). */
  labelLanguage?: MapLabelLanguage;
  /** Overrides the page theme. */
  theme?: MapTheme;
  /** Once, when the map's style and first tiles have loaded (MapLibre `load`). */
  onReady?: (map: MapLibreMap, maplibregl: MapLibre) => void;
  /** After every style load (setStyle drops added sources/layers: re-add them here). */
  onStyleLoad?: (map: MapLibreMap) => void;
  className?: string;
  testId?: string;
}

/**
 * The Amar Elaka base map (ADR 043): MapLibre GL over our own Bangladesh
 * .pmtiles archive, styled by @amar-elaka/map-style, following the page's
 * light/dark theme. The attribution (Protomaps, © OpenStreetMap
 * contributors) comes with the style and is always shown, never collapsed.
 *
 * `data-map-state` (loading → ready | error), `data-map-errors` and
 * `data-map-loaded-style` (the theme:language last rendered to rest) let the
 * headless test and a debugging human see whether a style really loaded.
 */
export function BaseMap({
  config,
  center,
  zoom,
  label,
  labelLanguage,
  theme: themeOverride,
  onReady,
  onStyleLoad,
  className,
  testId = 'base-map',
}: BaseMapProps) {
  const t = useTranslations('map');
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const pageTheme = usePageTheme();
  const theme = themeOverride ?? pageTheme;
  const lang = labelLanguage ?? config?.labelLanguage ?? 'en';
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errors, setErrors] = useState(0);
  const [loadedStyle, setLoadedStyle] = useState<string | null>(null);

  const callbacks = useRef({ onReady, onStyleLoad });
  useEffect(() => {
    callbacks.current = { onReady, onStyleLoad };
  }, [onReady, onStyleLoad]);

  const style = config ? styleFor(config, theme, lang) : null;
  const styleKey = typeof style === 'string' ? style : style ? `${theme}:${lang}` : null;
  // The newest style, for the map created asynchronously (the theme can
  // change from the server's guess during hydration before it exists).
  const latest = useRef({ style, styleKey });
  useEffect(() => {
    latest.current = { style, styleKey };
  });
  const appliedKey = useRef<string | null>(null);

  // Built once; later style changes (theme, language) go through setStyle below.
  useEffect(() => {
    if (!container.current || style === null) return;
    let cancelled = false;
    void loadMapLibre()
      .then((maplibregl) => {
        if (cancelled || !container.current || latest.current.style === null) return;
        appliedKey.current = latest.current.styleKey;
        const instance = new maplibregl.Map({
          container: container.current,
          style: latest.current.style,
          center: [center.lng, center.lat],
          zoom,
          attributionControl: false,
        });
        instance.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-right');
        instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
        instance.on('style.load', () => callbacks.current.onStyleLoad?.(instance));
        instance.on('idle', () => setLoadedStyle(appliedKey.current));
        instance.once('load', () => {
          setState('ready');
          callbacks.current.onReady?.(instance, maplibregl);
        });
        instance.on('error', (event) => {
          setErrors((n) => n + 1);
          console.error('map error', event.error);
        });
        map.current = instance;
      })
      .catch((error: unknown) => {
        console.error('map failed to load', error);
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
    };
    // The map is created once per mount; `style` changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style === null]);

  useEffect(() => {
    if (!map.current || style === null || appliedKey.current === styleKey) return;
    appliedKey.current = styleKey;
    map.current.setStyle(style);
    // styleKey captures every input of `style`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleKey]);

  if (style === null) {
    return (
      <div
        role="status"
        data-testid={testId}
        data-map-state="unavailable"
        className={cn(
          'flex items-center justify-center rounded-lg border border-border bg-muted p-4 text-center text-sm text-muted-foreground',
          className,
        )}
      >
        {t('unavailable')}
      </div>
    );
  }

  return (
    <div
      ref={container}
      role="application"
      aria-label={label}
      data-testid={testId}
      data-map-state={state}
      data-map-errors={errors}
      data-map-loaded-style={loadedStyle ?? undefined}
      data-map-theme={theme}
      data-map-lang={lang}
      className={cn('overflow-hidden rounded-lg border border-border', className)}
    />
  );
}
