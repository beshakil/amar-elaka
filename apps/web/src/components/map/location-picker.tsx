'use client';

import type { Map as MapLibreMap } from 'maplibre-gl';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type {
  GeocodeResult,
  GeoAreaName,
  MapConfig,
  PointAreas,
  ReverseGeocode,
} from '@/lib/api/schemas';
import { BarikoiAttribution } from './barikoi-attribution';
import { BaseMap } from './base-map';

export type GeoPoint = { lat: number; lng: number };

/** What the visitor chose: the point, our area name, and the address text as kept or edited. */
export interface PickedLocation {
  point: GeoPoint;
  /** Union, upazila, district from our geo_areas — always free. */
  areaLabel: string | null;
  /** The address text the visitor confirmed (possibly edited, possibly empty). */
  addressText: string;
}

/** What a caller saves as the place's label: the confirmed text, else the area. */
export const pickedLabel = (picked: PickedLocation): string | null =>
  picked.addressText.trim() !== '' ? picked.addressText.trim() : picked.areaLabel;

/** A lookup's answer; `offline` when the network (not the API) failed. */
export type GeoAnswer<T> = { ok: true; data: T } | { ok: false; offline: boolean };

/** The geo endpoints the picker calls (the caller decides how: server actions, routes…). */
export interface PickerGeo {
  /** GET /locations/lookup — our own areas, free. */
  areasAt: (lat: number, lng: number) => Promise<GeoAnswer<PointAreas>>;
  /** GET /geo/reverse?purpose= — the street address (billed fields per purpose). */
  reverse: (lat: number, lng: number) => Promise<GeoAnswer<ReverseGeocode>>;
  /** GET /geo/autocomplete — our places first, then Barikoi. */
  autocomplete: (query: string, near: GeoPoint | null) => Promise<GeoAnswer<GeocodeResult[]>>;
}

const INITIAL_ZOOM = 16;
/** A millionth of a degree (~0.1 m): the camera settled where it was sent. */
const SAME_POINT = 1e-6;

const PIN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="48" viewBox="0 0 32 44"><path d="M16 0C7.2 0 0 7.2 0 16c0 12 16 28 16 28s16-16 16-28C32 7.2 24.8 0 16 0z" fill="currentColor"/><circle cx="16" cy="16" r="6" fill="#fff"/></svg>';

/** Union, upazila, district (nearest first) in Bengali. */
export function areaLabel(areas: GeoAreaName[]): string | null {
  const names = areas
    .filter((a) => a.level !== 'country' && a.level !== 'division')
    .slice(-3)
    .reverse()
    .map((a) => a.name.bn ?? a.name.en);
  return names.length > 0 ? names.join(', ') : null;
}

function currentPosition(): Promise<GeoPoint | null> {
  if (!('geolocation' in navigator)) return Promise.resolve(null);
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
    ),
  );
}

async function locationGranted(): Promise<boolean> {
  try {
    return (await navigator.permissions?.query({ name: 'geolocation' }))?.state === 'granted';
  } catch {
    return false;
  }
}

/**
 * Reusable "where is it?" picker (ADR 046) — the same behaviour as the app's:
 *
 * * the pin is fixed in the middle; the map moves under it;
 * * when the camera stops and stays still for `geo_picker_idle_debounce_ms`
 *   (GET /map/config), the point is looked up ONCE: our own area at once,
 *   the street address from /geo/reverse?purpose= when it arrives — frames
 *   and repeated moveends cost nothing extra;
 * * address search (/geo/autocomplete, debounced, minimum length from
 *   settings), our places first; a picked result costs no reverse call;
 * * "আমার লোকেশন"; the address text is editable and is what gets saved;
 * * when the geo endpoints fail, the pin and the area name are enough.
 */
export function LocationPicker({
  config,
  initial,
  center,
  geo,
  onChange,
  onPointSettled,
  children,
}: {
  config: MapConfig | null;
  /** A saved point (a draft's); null = the visitor (if already allowed), else [center]. */
  initial: GeoPoint | null;
  center: GeoPoint;
  geo: PickerGeo;
  onChange: (picked: PickedLocation) => void;
  /** Each newly settled point, for the caller's own checks (a boundary warning). */
  onPointSettled?: (point: GeoPoint) => void;
  /** Caller content under the address (warnings, a required notice). */
  children?: React.ReactNode;
}) {
  const t = useTranslations('map.picker');
  const client = config?.client;
  const map = useRef<MapLibreMap | null>(null);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const movedTo = useRef<GeoPoint | null>(null);
  const lookup = useRef(0);
  const edited = useRef(false);

  const [point, setPoint] = useState<GeoPoint | null>(null);
  const [area, setArea] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [fromBarikoi, setFromBarikoi] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeocodeResult[] | null>(null);

  const latest = useRef({ geo, onChange, onPointSettled, point, area, address });
  useEffect(() => {
    latest.current = { geo, onChange, onPointSettled, point, area, address };
  });

  const emit = (next: Partial<{ point: GeoPoint; area: string | null; address: string }>) => {
    const p = next.point ?? latest.current.point;
    if (!p) return;
    latest.current.onChange({
      point: p,
      areaLabel: next.area !== undefined ? next.area : latest.current.area,
      addressText: next.address ?? latest.current.address,
    });
  };

  /** One stop, one lookup; the latest stop wins. */
  const settle = useCallback(async (at: GeoPoint, knownAddress?: string) => {
    const id = ++lookup.current;
    const { geo: g } = latest.current;
    edited.current = false;
    setPoint(at);
    setArea(null);
    setAddress(knownAddress ?? '');
    setFromBarikoi(false);
    setDegraded(false);
    setNotice(null);
    setLookingUp(knownAddress === undefined);
    latest.current.point = at;
    latest.current.area = null;
    latest.current.address = knownAddress ?? '';
    emit({ point: at, area: null, address: knownAddress ?? '' });
    latest.current.onPointSettled?.(at);

    void g.areasAt(at.lat, at.lng).then((answer) => {
      if (id !== lookup.current || !answer.ok) return;
      const label = areaLabel(answer.data.areas);
      setArea(label);
      latest.current.area = label;
      emit({ area: label });
    });
    if (knownAddress !== undefined) return;

    const answer = await g.reverse(at.lat, at.lng);
    if (id !== lookup.current) return;
    setLookingUp(false);
    if (!answer.ok) {
      setNotice(answer.offline ? t('offline') : t('addressFailed'));
      return;
    }
    setDegraded(answer.data.degraded);
    const found = answer.data.address;
    if (!latest.current.area) {
      const label = areaLabel(answer.data.areas);
      setArea(label);
      latest.current.area = label;
    }
    if (found && !edited.current) {
      const text = found.labelBn ?? found.label;
      setAddress(text);
      setFromBarikoi(found.source === 'barikoi');
      latest.current.address = text;
    }
    emit({});
    // emit/t read refs and stable translations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The page moves the camera (start, GPS, a search result): settled now, no debounce. */
  const moveTo = useCallback(
    (at: GeoPoint, knownAddress?: string) => {
      if (idle.current) clearTimeout(idle.current);
      movedTo.current = at;
      map.current?.easeTo({
        center: [at.lng, at.lat],
        zoom: Math.max(map.current.getZoom(), INITIAL_ZOOM),
      });
      void settle(at, knownAddress);
    },
    [settle],
  );

  const onReady = useCallback(
    (instance: MapLibreMap) => {
      map.current = instance;
      instance.on('movestart', () => {
        if (idle.current) clearTimeout(idle.current);
      });
      instance.on('moveend', () => {
        const c = instance.getCenter();
        const at = { lat: c.lat, lng: c.lng };
        const sent = movedTo.current;
        if (
          sent &&
          Math.abs(sent.lat - at.lat) < SAME_POINT &&
          Math.abs(sent.lng - at.lng) < SAME_POINT
        ) {
          return;
        }
        if (idle.current) clearTimeout(idle.current);
        idle.current = setTimeout(() => {
          movedTo.current = at;
          void settle(at);
        }, client?.pickerIdleDebounceMs ?? 0);
      });
      void (async () => {
        if (initial) return moveTo(initial);
        const here = (await locationGranted()) ? await currentPosition() : null;
        moveTo(here ?? center);
      })();
    },
    // Wired once, with the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(
    () => () => {
      if (idle.current) clearTimeout(idle.current);
      if (searchTimer.current) clearTimeout(searchTimer.current);
    },
    [],
  );

  async function goToMyLocation() {
    const here = await currentPosition();
    if (here) moveTo(here);
    else setNotice(t('locationDenied'));
  }

  function onSearch(text: string) {
    setQuery(text);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = text.trim();
    if (!q || (client && [...q].length < client.autocompleteMinChars)) {
      setResults(null);
      return;
    }
    searchTimer.current = setTimeout(() => {
      void latest.current.geo.autocomplete(q, latest.current.point).then((answer) => {
        // Our own places first, whatever order they came in.
        setResults(
          answer.ok
            ? [
                ...answer.data.filter((r) => r.source !== 'barikoi'),
                ...answer.data.filter((r) => r.source === 'barikoi'),
              ]
            : [],
        );
      });
    }, client?.autocompleteDebounceMs ?? 0);
  }

  return (
    <div className="space-y-3" data-testid="location-picker">
      <div className="space-y-1">
        <Input
          placeholder={t('searchLabel')}
          aria-label={t('searchLabel')}
          value={query}
          data-testid="location-search"
          onChange={(event) => onSearch(event.target.value)}
        />
        {results && (
          <ul
            className="divide-y divide-border rounded-md border border-border"
            data-testid="location-results"
          >
            {results.length === 0 ? (
              <li className="p-3 text-sm">{t('searchEmpty')}</li>
            ) : (
              results.map((r) => (
                <li key={`${r.source}:${r.location.lat},${r.location.lng},${r.label}`}>
                  <button
                    type="button"
                    className="w-full p-3 text-start text-sm hover:bg-muted"
                    onClick={() => {
                      setResults(null);
                      setQuery('');
                      moveTo(r.location, r.labelBn ?? r.label);
                    }}
                  >
                    {r.labelBn ?? r.label}
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
        {results?.some((r) => r.source === 'barikoi') && <BarikoiAttribution />}
      </div>

      <div className="relative">
        <BaseMap
          config={config}
          center={initial ?? center}
          zoom={INITIAL_ZOOM}
          label={t('hint')}
          onReady={onReady}
          testId="location-map"
          className="h-80 w-full"
        />
        {/* The pin stays centred; its tip marks the point. */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-full text-destructive"
          // Our own SVG (no user input).
          dangerouslySetInnerHTML={{ __html: PIN_SVG }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="absolute bottom-8 end-2 bg-background"
          data-testid="location-my-location"
          onClick={() => void goToMyLocation()}
        >
          {t('myLocation')}
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">{t('hint')}</p>
      {area && (
        <p className="text-sm font-medium" data-testid="location-area">
          {t('area')}: {area}
        </p>
      )}
      {point && (
        <label className="block space-y-1 text-sm">
          <span>{lookingUp ? t('lookingUp') : t('addressLabel')}</span>
          <Input
            value={address}
            data-testid="location-address"
            onChange={(event) => {
              edited.current = true;
              // The text is now the visitor's, not Barikoi's.
              setFromBarikoi(false);
              setAddress(event.target.value);
              latest.current.address = event.target.value;
              emit({ address: event.target.value });
            }}
          />
        </label>
      )}
      {fromBarikoi && <BarikoiAttribution />}
      {degraded && <p className="text-sm text-muted-foreground">{t('degraded')}</p>}
      {notice && (
        <p className="text-sm text-muted-foreground" data-testid="location-notice">
          {notice}
        </p>
      )}
      {children}
    </div>
  );
}
