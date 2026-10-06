'use client';

import { formatMoney } from '@amar-elaka/dynamic-form';
import type { GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent } from 'maplibre-gl';
import { useFormatter, useTranslations } from 'next-intl';
import type { Route } from 'next';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  MAP_LAYERS,
  type MapClusterFeature,
  type MapConfig,
  type MapFeature,
  type MapFeatures,
  type MapLayer,
  type MapPointFeature,
  type RouteAnswer,
} from '@/lib/api/schemas';
import { listingPath } from '@/lib/seo/slug';
import { BarikoiAttribution } from './barikoi-attribution';
import { BaseMap } from './base-map';

type RouteState = 'idle' | 'loading' | 'needsLocation' | 'limited' | 'failed';
interface Feature {
  type: 'Feature';
  id?: number;
  properties: Record<string, unknown>;
  geometry:
    | { type: 'Point'; coordinates: [number, number] }
    | { type: 'LineString'; coordinates: number[][] };
}
interface FeatureCollection {
  type: 'FeatureCollection';
  features: Feature[];
}
const POINTS_SOURCE = 'ae-points';
const ROUTE_SOURCE = 'ae-route';
// Presentation: one colour per layer, readable on both map themes.
const LAYER_COLOURS: Record<MapLayer, string> = {
  posts: '#d6336c',
  stores: '#1c7ed6',
  places: '#2f9e44',
  landmarks: '#f59f00',
  info: '#e03131',
};
const INITIAL_ZOOM = 13;
const FIT_PADDING_PX = 60;
const METERS_PER_KM = 1000;
const SECONDS_PER_MINUTE = 60;

const colourByLayer = [
  'match',
  ['get', 'layer'],
  ...MAP_LAYERS.slice(0, -1).flatMap((layer) => [layer, LAYER_COLOURS[layer]]),
  LAYER_COLOURS.info,
] as const;
const isLandmark = ['==', ['get', 'layer'], 'landmarks'] as const;

/**
 * The API's GeoJSON as is, each feature tagged with its index so a tap finds
 * the full feature again (MapLibre hands back flattened properties only).
 */
function featureCollection(features: MapFeature[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: features.map((feature, index) => ({
      type: 'Feature',
      id: index,
      properties: { ...feature.properties, index },
      geometry: {
        type: 'Point',
        coordinates: [feature.geometry.coordinates[0]!, feature.geometry.coordinates[1]!],
      },
    })),
  };
}

const lngLat = (feature: MapFeature) => ({
  lng: feature.geometry.coordinates[0]!,
  lat: feature.geometry.coordinates[1]!,
});

const emptyCollection: FeatureCollection = { type: 'FeatureCollection', features: [] };

/** Our layers over the base map; re-added after every style change (theme). */
function addLayers(map: MapLibreMap, points: FeatureCollection, route: FeatureCollection) {
  if (map.getSource(POINTS_SOURCE)) return;
  map.addSource(ROUTE_SOURCE, { type: 'geojson', data: route });
  map.addLayer({
    id: 'ae-route-line',
    type: 'line',
    source: ROUTE_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#1c7ed6', 'line-width': 5, 'line-opacity': 0.85 },
  });
  map.addSource(POINTS_SOURCE, { type: 'geojson', data: points });
  map.addLayer({
    id: 'ae-clusters',
    type: 'circle',
    source: POINTS_SOURCE,
    filter: ['==', ['get', 'cluster'], true],
    paint: {
      'circle-color': colourByLayer as never,
      'circle-opacity': 0.85,
      'circle-radius': ['step', ['get', 'count'], 14, 10, 18, 50, 24, 200, 30],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
    },
  });
  map.addLayer({
    id: 'ae-cluster-count',
    type: 'symbol',
    source: POINTS_SOURCE,
    filter: ['==', ['get', 'cluster'], true],
    layout: {
      'text-field': ['to-string', ['get', 'count']],
      'text-font': ['Noto Sans Medium'],
      'text-size': 12,
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#ffffff' },
  });
  map.addLayer({
    id: 'ae-points',
    type: 'circle',
    source: POINTS_SOURCE,
    filter: ['==', ['get', 'cluster'], false],
    paint: {
      'circle-color': colourByLayer as never,
      'circle-radius': ['case', isLandmark, 9, 7] as never,
      'circle-stroke-width': ['case', isLandmark, 3, 2] as never,
      'circle-stroke-color': '#ffffff',
    },
  });
}

/**
 * The area map (ADR 044, 045): our base map, with the API's GeoJSON features
 * (posts, stores, places, landmarks, info) clustered on the server for the
 * viewport after every pan or zoom has ENDED (never while moving). A cluster zooms in on a tap; a point opens its card;
 * a route is asked for only by the card's button, from the visitor's own
 * location (Barikoi, metered on the server).
 */
export function MapExplorer({
  config,
  center,
}: {
  config: MapConfig | null;
  center: { lat: number; lng: number };
}) {
  const t = useTranslations('map.explorer');
  const format = useFormatter();
  const map = useRef<MapLibreMap | null>(null);
  const [layers, setLayers] = useState<Set<MapLayer>>(() => new Set(MAP_LAYERS));
  const [openNow, setOpenNow] = useState(false);
  const [points, setPoints] = useState<MapFeatures | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<MapPointFeature | null>(null);
  const [route, setRoute] = useState<RouteAnswer | null>(null);
  const [routeState, setRouteState] = useState<RouteState>('idle');

  const latest = useRef({ points, route, layers, openNow });
  useEffect(() => {
    latest.current = { points, route, layers, openNow };
  });
  const request = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const instance = map.current;
    if (!instance) return;
    const bounds = instance.getBounds();
    const params = new URLSearchParams({
      bbox: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]
        .map((n) => n.toFixed(5))
        .join(','),
      zoom: String(instance.getZoom()),
      layers: [...latest.current.layers].join(','),
    });
    if (latest.current.openNow) params.set('open_now', 'true');
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const response = await fetch(`/api/map/features?${params.toString()}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as MapFeatures;
      setPoints(body);
      setFailed(false);
      void instance
        .getSource<GeoJSONSource>(POINTS_SOURCE)
        ?.setData(featureCollection(body.features));
    } catch (error) {
      if ((error as Error).name !== 'AbortError') setFailed(true);
    }
  }, []);

  // A new set of layers or filter is a new question for the same viewport.
  useEffect(() => {
    void load();
  }, [layers, openNow, load]);

  const onReady = useCallback(
    (instance: MapLibreMap) => {
      map.current = instance;
      instance.on('moveend', () => void load());
      instance.on('click', 'ae-clusters', (event: MapLayerMouseEvent) => {
        const index = event.features?.[0]?.properties?.index as number | undefined;
        const item = index === undefined ? undefined : latest.current.points?.features[index];
        if (item?.properties.cluster) {
          instance.easeTo({ center: lngLat(item), zoom: item.properties.expansion_zoom });
        }
      });
      instance.on('click', 'ae-points', (event: MapLayerMouseEvent) => {
        const index = event.features?.[0]?.properties?.index as number | undefined;
        const item = index === undefined ? undefined : latest.current.points?.features[index];
        if (item && !item.properties.cluster) {
          setSelected(item as MapPointFeature);
          setRoute(null);
          setRouteState('idle');
          void instance.getSource<GeoJSONSource>(ROUTE_SOURCE)?.setData(emptyCollection);
        }
      });
      for (const layer of ['ae-clusters', 'ae-points']) {
        instance.on('mouseenter', layer, () => (instance.getCanvas().style.cursor = 'pointer'));
        instance.on('mouseleave', layer, () => (instance.getCanvas().style.cursor = ''));
      }
      void load();
    },
    [load],
  );

  const onStyleLoad = useCallback((instance: MapLibreMap) => {
    const { points: current, route: currentRoute } = latest.current;
    addLayers(
      instance,
      current ? featureCollection(current.features) : emptyCollection,
      routeCollection(currentRoute),
    );
  }, []);

  function showRoute(mode: 'foot' | 'car') {
    const target = selected;
    if (!target) return;
    if (!('geolocation' in navigator)) {
      setRouteState('needsLocation');
      return;
    }
    setRouteState('loading');
    const fetchRoute = async (position: GeolocationPosition) => {
      const body = {
        from: { lat: position.coords.latitude, lng: position.coords.longitude },
        to: lngLat(target),
        mode,
      };
      try {
        const response = await fetch('/api/geo/route', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (response.status === 429) {
          setRouteState('limited');
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const answer = (await response.json()) as RouteAnswer;
        setRoute(answer);
        setRouteState('idle');
        const instance = map.current;
        void instance?.getSource<GeoJSONSource>(ROUTE_SOURCE)?.setData(routeCollection(answer));
        const line = answer.polyline;
        if (instance && line && line.length > 1) {
          const lngs = line.map((c) => c[0]!);
          const lats = line.map((c) => c[1]!);
          instance.fitBounds(
            [
              [Math.min(...lngs), Math.min(...lats)],
              [Math.max(...lngs), Math.max(...lats)],
            ],
            { padding: FIT_PADDING_PX },
          );
        }
      } catch {
        setRouteState('failed');
      }
    };
    navigator.geolocation.getCurrentPosition(
      (position) => void fetchRoute(position),
      () => setRouteState('needsLocation'),
    );
  }

  function distance(meters: number): string {
    return meters >= METERS_PER_KM
      ? t('km', { value: format.number(meters / METERS_PER_KM, { maximumFractionDigits: 1 }) })
      : t('meters', { value: format.number(Math.round(meters)) });
  }

  const card = selected?.properties;
  const name = card ? (card.name_bn ?? card.name_en) : null;
  const href =
    card?.layer === 'posts' && name
      ? listingPath(card.id, name)
      : card?.layer === 'stores' && card.slug
        ? `/store/${card.slug}`
        : null;

  function zoomInto(item: MapClusterFeature) {
    map.current?.easeTo({ center: lngLat(item), zoom: item.properties.expansion_zoom });
  }

  function select(item: MapPointFeature) {
    setSelected(item);
    setRoute(null);
    setRouteState('idle');
    void map.current?.getSource<GeoJSONSource>(ROUTE_SOURCE)?.setData(emptyCollection);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('show')}>
        {MAP_LAYERS.map((layer) => (
          <Button
            key={layer}
            size="sm"
            variant={layers.has(layer) ? 'primary' : 'outline'}
            aria-pressed={layers.has(layer)}
            data-testid={`layer-${layer}`}
            onClick={() =>
              setLayers((current) => {
                const next = new Set(current);
                if (next.has(layer) && next.size > 1) next.delete(layer);
                else next.add(layer);
                return next;
              })
            }
          >
            <span
              aria-hidden
              className="me-1 inline-block size-2.5 rounded-full"
              style={{ backgroundColor: LAYER_COLOURS[layer] }}
            />
            {t(layer)}
          </Button>
        ))}
        <Button
          size="sm"
          variant={openNow ? 'primary' : 'outline'}
          aria-pressed={openNow}
          data-testid="open-now"
          onClick={() => setOpenNow((current) => !current)}
        >
          {t('openNow')}
        </Button>
      </div>
      {points && points.open_now_skipped.length > 0 && (
        <p className="text-sm text-muted-foreground" data-testid="open-now-skipped">
          {t('openNowSkipped', {
            layers: points.open_now_skipped.map((layer) => t(layer)).join(', '),
          })}
        </p>
      )}
      {points?.clipped && <p className="text-sm text-muted-foreground">{t('clipped')}</p>}
      {points?.truncated && <p className="text-sm text-muted-foreground">{t('truncated')}</p>}
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {t('loadFailed')}
        </p>
      )}

      <div className="relative">
        <BaseMap
          config={config}
          center={center}
          zoom={INITIAL_ZOOM}
          label={t('title')}
          onReady={onReady}
          onStyleLoad={onStyleLoad}
          testId="area-map"
          className="h-[70vh] w-full"
        />
        {selected && (
          <section
            data-testid="map-card"
            className="absolute inset-x-2 bottom-10 z-10 space-y-2 rounded-lg border border-border bg-background p-3 shadow-lg sm:inset-x-auto sm:start-2 sm:w-80"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="font-semibold">{name ?? t('unnamed')}</h2>
                <p className="text-xs text-muted-foreground">{t(selected.properties.layer)}</p>
                {selected.properties.open_now !== null && (
                  <p className="text-xs">
                    {selected.properties.open_now ? t('isOpen') : t('isClosed')}
                  </p>
                )}
                {selected.properties.price && (
                  <p className="text-sm">৳ {formatMoney(selected.properties.price, 'bn')}</p>
                )}
              </div>
              <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
                {t('close')}
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {href && (
                <Button size="sm" asChild>
                  <Link href={href as Route}>{t('open')}</Link>
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => showRoute('foot')}>
                {t('routeWalk')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => showRoute('car')}>
                {t('routeCar')}
              </Button>
            </div>
            <div aria-live="polite" className="text-sm" data-testid="route-status">
              {routeState === 'loading' && t('routing')}
              {routeState === 'needsLocation' && t('routeNeedsLocation')}
              {routeState === 'limited' && t('routeLimited')}
              {routeState === 'failed' && t('routeFailed')}
              {routeState === 'idle' && route && route.durationSeconds !== null && (
                <>
                  {t('routeResult', {
                    distance: distance(route.distanceMeters),
                    minutes: format.number(
                      Math.max(1, Math.round(route.durationSeconds / SECONDS_PER_MINUTE)),
                    ),
                  })}
                  {route.source === 'barikoi' && <BarikoiAttribution />}
                </>
              )}
              {routeState === 'idle' && route && route.durationSeconds === null && (
                <>{t('routeStraight', { distance: distance(route.distanceMeters) })}</>
              )}
            </div>
          </section>
        )}
      </div>

      {points && (
        <details className="rounded-md border border-border p-3" data-testid="map-list">
          <summary className="cursor-pointer text-sm font-medium">{t('list')}</summary>
          {points.features.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <ul className="mt-2 divide-y divide-border">
              {points.features.map((item) => (
                <li
                  key={
                    item.properties.cluster
                      ? `${item.properties.layer}:${item.geometry.coordinates.join(',')}`
                      : item.properties.id
                  }
                >
                  <button
                    type="button"
                    className="w-full py-2 text-start text-sm hover:underline"
                    onClick={() =>
                      item.properties.cluster
                        ? zoomInto(item as MapClusterFeature)
                        : select(item as MapPointFeature)
                    }
                  >
                    {item.properties.cluster
                      ? t('clusterItem', {
                          count: format.number(item.properties.count),
                          kind: t(item.properties.layer),
                        })
                      : (item.properties.name_bn ?? item.properties.name_en ?? t('unnamed'))}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
    </div>
  );
}

function routeCollection(route: RouteAnswer | null): FeatureCollection {
  if (!route?.polyline) return emptyCollection;
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: route.polyline },
      },
    ],
  };
}
