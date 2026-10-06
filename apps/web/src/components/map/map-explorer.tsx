'use client';

import type { GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent, Marker } from 'maplibre-gl';
import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type {
  MapClusterFeature,
  MapConfig,
  MapFeature,
  MapFeatures,
  MapPointFeature,
} from '@/lib/api/schemas';
import { addPinImages, pinColour, pinImageName, pinSvg } from '@/lib/map/pin-images';
import { mapViewQuery, movedEnough, type LatLngBox, type MapView } from '@/lib/map/view';
import { BaseMap } from './base-map';
import { MapPreviewPanel } from './map-preview-panel';

type MapLibre = typeof import('maplibre-gl');
type Point = { lat: number; lng: number };

const SOURCE = 'ae-features';
const CLUSTER_LAYER = 'ae-clusters';
const PIN_LAYER = 'ae-pins';

interface GeoFeature {
  type: 'Feature';
  id: number;
  properties: Record<string, unknown>;
  geometry: { type: 'Point'; coordinates: [number, number] };
}
const emptyCollection = { type: 'FeatureCollection' as const, features: [] as GeoFeature[] };

const lngLat = (f: MapFeature): Point => ({
  lng: f.geometry.coordinates[0]!,
  lat: f.geometry.coordinates[1]!,
});

function boundsOf(map: MapLibreMap): LatLngBox {
  const b = map.getBounds();
  return { minLng: b.getWest(), minLat: b.getSouth(), maxLng: b.getEast(), maxLat: b.getNorth() };
}

/** The visitor's location if the browser can give it; null when refused or unavailable. */
function currentPosition(): Promise<Point | null> {
  if (!('geolocation' in navigator)) return Promise.resolve(null);
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
      () => resolve(null),
    ),
  );
}

/** Whether location was already granted (then asking shows no prompt). */
async function locationGranted(): Promise<boolean> {
  try {
    const status = await navigator.permissions?.query({ name: 'geolocation' });
    return status?.state === 'granted';
  } catch {
    return false;
  }
}

/**
 * The area map (ADR 044, 045, 046) — the same Map tab as the app:
 *
 * * opens at the URL's view (a shared link), else at the visitor when
 *   location is already granted (no prompt on load), else the area's centre;
 * * features from GET /map/features for the toggled `map_kinds` and "open
 *   now" — on open, a toggle, a cluster click or "এই এলাকায় খুঁজুন"; panning
 *   only offers that button;
 * * pins are icons (style images); names are HTML markers on the nearest
 *   `map_pin_label_max` pins from `map_pin_label_min_zoom` — never map text;
 * * a pin opens the preview panel; map / list show the same results;
 * * the URL follows centre, zoom, kinds, open-now and the list view.
 */
export function MapExplorer({ config, initial }: { config: MapConfig | null; initial: MapView }) {
  const t = useTranslations('map.explorer');
  const format = useFormatter();
  const allKinds = config?.kinds.map((k) => k.code) ?? [];
  const kindOf = (code: string | null) => config?.kinds.find((k) => k.code === code);

  const map = useRef<MapLibreMap | null>(null);
  const maplibre = useRef<MapLibre | null>(null);
  const [kinds, setKinds] = useState<string[] | null>(initial.kinds);
  const [openNow, setOpenNow] = useState(initial.openNow);
  const [list, setList] = useState(initial.list);
  const [features, setFeatures] = useState<MapFeatures | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [offerSearch, setOfferSearch] = useState(false);
  const [selected, setSelected] = useState<MapPointFeature | null>(null);
  const [user, setUser] = useState<Point | null>(null);
  const [layersOpen, setLayersOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const fetched = useRef<{ box: LatLngBox; zoom: number } | null>(null);
  const fetchOnIdle = useRef(false);
  const request = useRef<AbortController | null>(null);
  const labels = useRef(new Map<string, Marker>());
  const latest = useRef({ features, kinds, openNow, list });
  useEffect(() => {
    latest.current = { features, kinds, openNow, list };
  });

  /** The URL follows the view (replaceState: no navigation, no history entries). */
  const syncUrl = useCallback(() => {
    const instance = map.current;
    if (!instance) return;
    const centre = instance.getCenter();
    const { kinds: k, openNow: o, list: l } = latest.current;
    const query = mapViewQuery({
      center: { lat: centre.lat, lng: centre.lng },
      zoom: instance.getZoom(),
      kinds: k,
      openNow: o,
      list: l,
    });
    window.history.replaceState(window.history.state, '', `${window.location.pathname}?${query}`);
  }, []);

  const toGeoJson = useCallback(
    (data: MapFeatures | null) => ({
      type: 'FeatureCollection' as const,
      features: (data?.features ?? []).map<GeoFeature>((feature, index) => {
        const icon = config?.kinds.find((k) => k.code === feature.properties.kind)?.icon ?? null;
        return {
          type: 'Feature',
          id: index,
          properties: {
            ...feature.properties,
            index,
            icon: pinImageName(icon),
            colour: pinColour(icon),
          },
          geometry: { type: 'Point', coordinates: [lngLat(feature).lng, lngLat(feature).lat] },
        };
      }),
    }),
    [config],
  );

  /** Bengali names as HTML on the nearest pins, only when zoomed in. */
  const updateLabels = useCallback(() => {
    const instance = map.current;
    const lib = maplibre.current;
    const client = config?.client;
    if (!instance || !lib || !client) return;
    const data = latest.current.features?.features ?? [];
    const keep = new Set<string>();
    if (instance.getZoom() >= client.pinLabelMinZoom) {
      const centre = instance.getCenter();
      const named = data
        .filter((f): f is MapPointFeature => !f.properties.cluster)
        .filter((f) => (f.properties.name_bn ?? f.properties.name_en) !== null)
        .map((f) => {
          const p = lngLat(f);
          return { f, d: (p.lat - centre.lat) ** 2 + (p.lng - centre.lng) ** 2 };
        })
        .sort((a, b) => a.d - b.d)
        .slice(0, client.pinLabelMax);
      for (const { f } of named) {
        const id = f.properties.id;
        keep.add(id);
        if (labels.current.has(id)) continue;
        const element = document.createElement('div');
        element.className =
          'pointer-events-none max-w-36 truncate rounded-full bg-background/90 px-2 py-0.5 text-xs text-foreground shadow';
        element.textContent = f.properties.name_bn ?? f.properties.name_en;
        element.dataset.testid = 'map-pin-label';
        const p = lngLat(f);
        labels.current.set(
          id,
          new lib.Marker({ element, anchor: 'top', offset: [0, 14] })
            .setLngLat([p.lng, p.lat])
            .addTo(instance),
        );
      }
    }
    for (const [id, marker] of labels.current) {
      if (!keep.has(id)) {
        marker.remove();
        labels.current.delete(id);
      }
    }
  }, [config]);

  const load = useCallback(async () => {
    const instance = map.current;
    if (!instance) return;
    const box = boundsOf(instance);
    const zoom = instance.getZoom();
    const { kinds: k, openNow: o } = latest.current;
    const params = new URLSearchParams({
      bbox: [box.minLng, box.minLat, box.maxLng, box.maxLat].map((n) => n.toFixed(5)).join(','),
      zoom: String(zoom),
    });
    // The toggles; until one is changed, every kind of map_kinds.
    const asked = k ?? allKinds;
    if (asked.length > 0) params.set('kinds', asked.join(','));
    if (o) params.set('open_now', 'true');
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setOfferSearch(false);
    try {
      const response = await fetch(`/api/map/features?${params.toString()}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as MapFeatures;
      fetched.current = { box, zoom };
      latest.current.features = body;
      setFeatures(body);
      setFailed(false);
      void instance.getSource<GeoJSONSource>(SOURCE)?.setData(toGeoJson(body));
      updateLabels();
    } catch (error) {
      if ((error as Error).name !== 'AbortError') setFailed(true);
    } finally {
      if (request.current === controller) setLoading(false);
    }
    // allKinds is derived from config, as toGeoJson is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toGeoJson, updateLabels]);

  const onReady = useCallback(
    (instance: MapLibreMap, lib: MapLibre) => {
      map.current = instance;
      maplibre.current = lib;
      instance.on('moveend', () => {
        syncUrl();
        if (fetchOnIdle.current) {
          fetchOnIdle.current = false;
          void load();
          return;
        }
        const last = fetched.current;
        const client = config?.client;
        if (last && client) {
          setOfferSearch(
            movedEnough({
              fetched: last.box,
              fetchedZoom: last.zoom,
              now: boundsOf(instance),
              nowZoom: instance.getZoom(),
              ratio: client.searchAreaMoveRatio,
            }),
          );
        }
        updateLabels();
      });
      const featureAt = (event: MapLayerMouseEvent) => {
        const index = event.features?.[0]?.properties?.index as number | undefined;
        return index === undefined ? undefined : latest.current.features?.features[index];
      };
      instance.on('click', CLUSTER_LAYER, (event) => {
        const item = featureAt(event);
        if (item?.properties.cluster) zoomInto(item as MapClusterFeature);
      });
      instance.on('click', PIN_LAYER, (event) => {
        const item = featureAt(event);
        if (item && !item.properties.cluster) setSelected(item as MapPointFeature);
      });
      for (const layer of [CLUSTER_LAYER, PIN_LAYER]) {
        instance.on('mouseenter', layer, () => (instance.getCanvas().style.cursor = 'pointer'));
        instance.on('mouseleave', layer, () => (instance.getCanvas().style.cursor = ''));
      }
      // One request on open: at the shared view, else at the visitor when
      // location is already granted, else at the area's centre.
      void (async () => {
        if (!initial.shared && (await locationGranted())) {
          const here = await currentPosition();
          if (here) {
            setUser(here);
            instance.jumpTo({ center: [here.lng, here.lat] });
          }
        }
        await load();
        syncUrl();
      })();
    },
    // Created once with the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /** Our images, source and layers; again after every style change (theme). */
  const onStyleLoad = useCallback(
    (instance: MapLibreMap) => {
      void (async () => {
        await addPinImages(instance, [...(config?.kinds.map((k) => k.icon) ?? []), null]);
        if (instance.getSource(SOURCE)) return;
        instance.addSource(SOURCE, {
          type: 'geojson',
          data: latest.current.features ? toGeoJson(latest.current.features) : emptyCollection,
        });
        instance.addLayer({
          id: CLUSTER_LAYER,
          type: 'circle',
          source: SOURCE,
          filter: ['==', ['get', 'cluster'], true],
          paint: {
            'circle-color': ['get', 'colour'],
            'circle-opacity': 0.85,
            'circle-radius': ['step', ['get', 'count'], 14, 10, 18, 50, 24, 200, 30],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff',
          },
        });
        instance.addLayer({
          id: 'ae-cluster-count',
          type: 'symbol',
          source: SOURCE,
          filter: ['==', ['get', 'cluster'], true],
          // Digits only: no Bengali shaping needed.
          layout: {
            'text-field': ['to-string', ['get', 'count']],
            'text-font': ['Noto Sans Medium'],
            'text-size': 12,
            'text-allow-overlap': true,
          },
          paint: { 'text-color': '#ffffff' },
        });
        instance.addLayer({
          id: PIN_LAYER,
          type: 'symbol',
          source: SOURCE,
          filter: ['==', ['get', 'cluster'], false],
          layout: { 'icon-image': ['get', 'icon'], 'icon-allow-overlap': true },
        });
      })();
    },
    [config, toGeoJson],
  );

  function zoomInto(item: MapClusterFeature) {
    const instance = map.current;
    if (!instance) return;
    // An explicit click: zoom in and ask for where it lands.
    fetchOnIdle.current = true;
    const p = lngLat(item);
    setList(false);
    instance.easeTo({ center: [p.lng, p.lat], zoom: item.properties.expansion_zoom });
  }

  async function locate(): Promise<Point | null> {
    const here = await currentPosition();
    if (here) setUser(here);
    else setNotice(t('locationDenied'));
    return here;
  }

  async function goToMe() {
    const here = await locate();
    if (!here || !map.current) return;
    fetchOnIdle.current = true;
    map.current.easeTo({ center: [here.lng, here.lat] });
  }

  // A change of toggles, open-now or view: the URL, and (toggles) a new answer.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    syncUrl();
    void load();
    // load/syncUrl are stable for the page's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kinds, openNow]);
  useEffect(() => {
    syncUrl();
    if (!list) map.current?.resize();
  }, [list, syncUrl]);

  useEffect(
    () => () => {
      for (const marker of labels.current.values()) marker.remove();
      labels.current.clear();
    },
    [],
  );

  const items = features?.features ?? [];
  const from = user ?? (map.current ? map.current.getCenter() : initial.center);
  const sorted = [...items].sort((a, b) => {
    const d = (f: MapFeature) => (lngLat(f).lat - from.lat) ** 2 + (lngLat(f).lng - from.lng) ** 2;
    return d(a) - d(b);
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label={t('viewMap')}
          className="flex rounded-md border border-border"
        >
          <Button
            size="sm"
            variant={list ? 'ghost' : 'primary'}
            aria-pressed={!list}
            data-testid="view-map"
            onClick={() => setList(false)}
          >
            {t('viewMap')}
          </Button>
          <Button
            size="sm"
            variant={list ? 'primary' : 'ghost'}
            aria-pressed={list}
            data-testid="view-list"
            onClick={() => setList(true)}
          >
            {t('viewList')}
          </Button>
        </div>
        <Button
          size="sm"
          variant="outline"
          aria-expanded={layersOpen}
          data-testid="map-layers"
          onClick={() => setLayersOpen((open) => !open)}
        >
          {t('layers')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-testid="map-my-location"
          onClick={() => void goToMe()}
        >
          {t('myLocation')}
        </Button>
      </div>

      {layersOpen && config && (
        <LayerPanel
          kinds={config.kinds}
          selected={kinds ?? allKinds}
          openNow={openNow}
          onApply={(nextKinds, nextOpen) => {
            setLayersOpen(false);
            setKinds(nextKinds.length === allKinds.length ? null : nextKinds);
            setOpenNow(nextOpen);
          }}
        />
      )}

      {features?.clipped && <p className="text-sm text-muted-foreground">{t('clipped')}</p>}
      {features?.truncated && <p className="text-sm text-muted-foreground">{t('truncated')}</p>}
      {openNow && features && features.open_now_skipped.length > 0 && (
        <p className="text-sm text-muted-foreground" data-testid="open-now-skipped">
          {t('openNowSkipped')}
        </p>
      )}
      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {t('loadFailed')}
        </p>
      )}

      <div className="relative">
        <div className={list ? 'invisible absolute inset-0' : undefined} aria-hidden={list}>
          <BaseMap
            config={config}
            center={initial.center}
            zoom={initial.zoom}
            label={t('title')}
            onReady={onReady}
            onStyleLoad={onStyleLoad}
            testId="area-map"
            className="h-[70vh] w-full"
          />
        </div>
        {loading && (
          <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 animate-pulse bg-primary" />
        )}
        {offerSearch && !list && (
          <div className="absolute inset-x-0 top-3 z-10 flex justify-center">
            <Button size="sm" data-testid="map-search-area" onClick={() => void load()}>
              {t('searchThisArea')}
            </Button>
          </div>
        )}
        {list && (
          <ul
            className="h-[70vh] divide-y divide-border overflow-y-auto rounded-lg border border-border"
            data-testid="map-list"
          >
            {sorted.length === 0 ? (
              <li className="p-4 text-sm text-muted-foreground">{t('empty')}</li>
            ) : (
              sorted.map((item) => (
                <li
                  key={
                    item.properties.cluster
                      ? `${item.properties.layer}:${item.properties.kind}:${item.geometry.coordinates.join(',')}`
                      : item.properties.id
                  }
                >
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-muted"
                    onClick={() =>
                      item.properties.cluster
                        ? zoomInto(item as MapClusterFeature)
                        : setSelected(item as MapPointFeature)
                    }
                  >
                    <span
                      aria-hidden
                      // Our own SVG (no user input).
                      dangerouslySetInnerHTML={{
                        __html: pinSvg(kindOf(item.properties.kind)?.icon, 22),
                      }}
                    />
                    {item.properties.cluster
                      ? t('clusterItem', {
                          count: format.number(item.properties.count),
                          kind: kindOf(item.properties.kind)?.label.bn ?? t('kindOther'),
                        })
                      : (item.properties.name_bn ?? item.properties.name_en ?? t('unnamed'))}
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
        {selected && (
          <div className="absolute inset-x-2 bottom-10 z-20 sm:inset-x-auto sm:start-2 sm:w-96">
            <MapPreviewPanel
              key={selected.properties.id}
              feature={selected}
              kind={kindOf(selected.properties.kind)}
              user={user}
              locate={locate}
              onClose={() => setSelected(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** The kind toggles with their pin icons, plus "open now" (at least one kind stays on). */
function LayerPanel({
  kinds,
  selected,
  openNow,
  onApply,
}: {
  kinds: MapConfig['kinds'];
  selected: string[];
  openNow: boolean;
  onApply: (kinds: string[], openNow: boolean) => void;
}) {
  const t = useTranslations('map.explorer');
  const [chosen, setChosen] = useState(() => new Set(selected));
  const [open, setOpen] = useState(openNow);
  return (
    <div
      data-testid="map-layers-panel"
      className="space-y-3 rounded-lg border border-border bg-background p-3"
    >
      <p className="text-sm font-medium">{t('layersTitle')}</p>
      <div className="flex flex-wrap gap-2">
        {kinds.map((kind) => (
          <Button
            key={kind.code}
            size="sm"
            variant={chosen.has(kind.code) ? 'primary' : 'outline'}
            aria-pressed={chosen.has(kind.code)}
            data-testid={`kind-${kind.code}`}
            onClick={() =>
              setChosen((current) => {
                const next = new Set(current);
                if (next.has(kind.code) && next.size > 1) next.delete(kind.code);
                else next.add(kind.code);
                return next;
              })
            }
          >
            <span
              aria-hidden
              className="me-1 inline-flex"
              // Our own SVG (no user input).
              dangerouslySetInnerHTML={{ __html: pinSvg(kind.icon, 18) }}
            />
            {kind.label.bn}
          </Button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="open-now"
          checked={open}
          onChange={(event) => setOpen(event.target.checked)}
        />
        {t('openNow')}
      </label>
      <Button
        size="sm"
        data-testid="map-layers-apply"
        onClick={() =>
          onApply(
            kinds.map((k) => k.code).filter((c) => chosen.has(c)),
            open,
          )
        }
      >
        {t('applyLayers')}
      </Button>
    </div>
  );
}
