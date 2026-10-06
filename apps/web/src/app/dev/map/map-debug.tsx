'use client';

import type { MapLabelLanguage, MapTheme } from '@amar-elaka/map-style';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { useTranslations } from 'next-intl';
import { useCallback, useRef, useState } from 'react';
import { BaseMap } from '@/components/map/base-map';
import { Button } from '@/components/ui/button';
import type { MapConfig } from '@/lib/api/schemas';

/**
 * The names to check: conjuncts (ক্র, ন্ড, ব্র + া + হ্ম + ণ), vowel signs
 * before and after the consonant (ি, ে, ো), and Bengali digits. Real places,
 * at their real coordinates. Mirrored in the app's MapDebugScreen.
 */
export const SHAPING_SAMPLES = [
  { name: 'ক্রিসেন্ট লেক', lat: 23.7629, lng: 90.3787 },
  { name: 'শ্যামলী', lat: 23.7746, lng: 90.3655 },
  { name: 'ধানমন্ডি ২৭', lat: 23.7556, lng: 90.3747 },
  { name: 'চট্টগ্রাম', lat: 22.3569, lng: 91.7832 },
  { name: 'ব্রাহ্মণবাড়িয়া', lat: 23.9571, lng: 91.1119 },
  { name: 'কক্সবাজার', lat: 21.4272, lng: 92.0058 },
] as const;

const SOURCE = 'shaping-samples';
const ALL_BOUNDS: [[number, number], [number, number]] = [
  [90.2, 21.2],
  [92.2, 24.1],
];
const DHAKA = { center: [90.374, 23.764] as [number, number], zoom: 13.5 };

const samplesGeoJson = {
  type: 'FeatureCollection' as const,
  features: SHAPING_SAMPLES.map((s) => ({
    type: 'Feature' as const,
    properties: { label: s.name },
    geometry: { type: 'Point' as const, coordinates: [s.lng, s.lat] },
  })),
};

/** Our six labels as their own layers, on top of the base map (re-added after every style change). */
function addSamples(map: MapLibreMap): void {
  if (map.getSource(SOURCE)) return;
  map.addSource(SOURCE, { type: 'geojson', data: samplesGeoJson });
  map.addLayer({
    id: `${SOURCE}-dots`,
    type: 'circle',
    source: SOURCE,
    paint: {
      'circle-radius': 5,
      'circle-color': '#d6336c',
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
    },
  });
  map.addLayer({
    id: `${SOURCE}-labels`,
    type: 'symbol',
    source: SOURCE,
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 22,
      'text-anchor': 'top',
      'text-offset': [0, 0.6],
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: { 'text-color': '#111111', 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
  });
}

export function MapDebug({ config }: { config: MapConfig | null }) {
  const t = useTranslations('map.debug');
  const [theme, setTheme] = useState<MapTheme>('light');
  const [lang, setLang] = useState<MapLabelLanguage>('bn');
  const map = useRef<MapLibreMap | null>(null);

  const onReady = useCallback((instance: MapLibreMap) => {
    map.current = instance;
    instance.fitBounds(ALL_BOUNDS, { padding: 40, duration: 0 });
  }, []);

  return (
    <main id="main" className="mx-auto max-w-5xl space-y-4 px-4 py-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      <p className="text-sm" data-testid="label-setting">
        {t('setting', { lang: config?.labelLanguage ?? '—' })}
      </p>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>{t('theme')}:</span>
        {(['light', 'dark'] as const).map((value) => (
          <Button
            key={value}
            size="sm"
            variant={theme === value ? 'primary' : 'outline'}
            aria-pressed={theme === value}
            data-testid={`theme-${value}`}
            onClick={() => setTheme(value)}
          >
            {t(value)}
          </Button>
        ))}
        <span className="ms-4">{t('labels')}:</span>
        {(['bn', 'en'] as const).map((value) => (
          <Button
            key={value}
            size="sm"
            variant={lang === value ? 'primary' : 'outline'}
            aria-pressed={lang === value}
            data-testid={`lang-${value}`}
            onClick={() => setLang(value)}
          >
            {t(value)}
          </Button>
        ))}
        <span className="ms-4" />
        <Button
          size="sm"
          variant="outline"
          onClick={() => map.current?.fitBounds(ALL_BOUNDS, { padding: 40 })}
        >
          {t('fitAll')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => map.current?.easeTo(DHAKA)}>
          {t('dhaka')}
        </Button>
      </div>

      <BaseMap
        config={config}
        center={{ lat: 23.2, lng: 91.1 }}
        zoom={6.5}
        label={t('mapLabel')}
        theme={theme}
        labelLanguage={lang}
        onReady={onReady}
        onStyleLoad={addSamples}
        className="h-[60vh] w-full"
      />

      <section>
        <h2 className="mb-2 text-sm font-semibold">{t('reference')}</h2>
        <ul className="grid grid-cols-2 gap-2 text-2xl sm:grid-cols-3" data-testid="html-reference">
          {SHAPING_SAMPLES.map((s) => (
            <li key={s.name} className="rounded-md border border-border p-2">
              {s.name}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
