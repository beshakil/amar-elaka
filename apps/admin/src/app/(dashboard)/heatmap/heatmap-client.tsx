'use client';

import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Label } from '@/components/ui/label';
import type { Heatmap, MapConfig } from '@/lib/api/schemas';
import { cellsCenter } from '@/lib/map/heatmap';
import type { Camera } from './heatmap-map';

// MapLibre touches `window`: client only.
const HeatmapMap = dynamic(() => import('./heatmap-map').then((m) => m.HeatmapMap), {
  ssr: false,
  loading: () => <div className="h-[60vh] w-full animate-pulse rounded-lg bg-muted" />,
});

// Presentation only (not platform behaviour): the two layers' colours and the start zoom.
const DEMAND_COLOUR = '#dc2626';
const SUPPLY_COLOUR = '#2563eb';
const START_ZOOM = 12;

/**
 * Demand and supply side by side, on maps that move together, with a
 * category filter (a plain GET: the page reloads its two heatmaps).
 */
export function HeatmapClient({
  config,
  demand,
  supply,
  category,
  categories,
}: {
  config: MapConfig;
  demand: Heatmap;
  supply: Heatmap;
  category: string | null;
  categories: { slug: string; name: string }[];
}) {
  const t = useTranslations('heatmap');
  const router = useRouter();
  const center = cellsCenter([...demand.cells, ...supply.cells]);
  const [camera, setCamera] = useState<Camera>({
    center: center ? [center.lng, center.lat] : [90.4125, 23.8103],
    zoom: START_ZOOM,
  });

  if (!config.tiles) {
    return <p className="text-sm text-muted-foreground">{t('noBaseMap')}</p>;
  }

  const panel = (heatmap: Heatmap, colour: string, kind: 'demand' | 'supply') => (
    <section className="flex flex-col gap-2" aria-labelledby={`heatmap-${kind}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 id={`heatmap-${kind}`} className="text-base font-semibold">
          <span
            className="mr-2 inline-block size-3 rounded-sm"
            style={{ backgroundColor: colour }}
          />
          {t(`${kind}.title`)}
        </h2>
        <span className="text-xs text-muted-foreground">
          {t('cellCount', { count: heatmap.cells.length })}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {kind === 'demand' ? t('demand.help', { days: demand.windowDays }) : t('supply.help')}
      </p>
      <HeatmapMap
        config={config}
        heatmap={heatmap}
        colour={colour}
        label={t(`${kind}.title`)}
        camera={camera}
        onMove={setCamera}
        testId={`heatmap-${kind}`}
      />
    </section>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('privacy', { min: demand.minCellCount })}
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="heatmap-category">{t('category')}</Label>
          <select
            id="heatmap-category"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={category ?? ''}
            onChange={(e) =>
              router.push(e.target.value ? `/heatmap?category=${e.target.value}` : '/heatmap')
            }
          >
            <option value="">{t('allCategories')}</option>
            {categories.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {category && <p className="text-xs text-muted-foreground">{t('storesNotInCategory')}</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        {panel(demand, DEMAND_COLOUR, 'demand')}
        {panel(supply, SUPPLY_COLOUR, 'supply')}
      </div>
    </div>
  );
}
