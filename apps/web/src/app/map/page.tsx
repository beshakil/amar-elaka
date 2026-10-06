import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import { MapExplorerLazy } from '@/components/map/map-explorer-lazy';
import { NoCoverage } from '@/components/no-coverage';
import { pickMessages } from '@/lib/i18n-messages';
import { loadMapConfig } from '@/lib/map/config';
import { parseMapView } from '@/lib/map/view';
import { currentTenantConfig, tenantConfigForChrome } from '@/lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  const [tenant, t] = await Promise.all([tenantConfigForChrome(), getTranslations('nav')]);
  return {
    title: t('map'),
    description: tenant?.nameBn,
    alternates: { canonical: '/map' },
  };
}

// The opening zoom of an area map: a neighbourhood on a phone screen.
const DEFAULT_ZOOM = 14;

/**
 * The area map (ADR 044–046): every map_kinds toggle around the visitor (or
 * the area's centre), clustered by the API, on our self-hosted base map (ADR
 * 043). The URL holds the view (centre, zoom, kinds, open now, list), so a
 * map can be shared; the map itself is a lazy chunk of this page only.
 */
export default async function MapPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [tenant, config, messages, params] = await Promise.all([
    currentTenantConfig(),
    loadMapConfig(),
    getMessages(),
    searchParams,
  ]);
  if (!tenant) return <NoCoverage />;
  const t = await getTranslations('map.explorer');

  return (
    <main id="main" className="mx-auto max-w-6xl space-y-4 px-4 py-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <NextIntlClientProvider messages={pickMessages(messages, ['map'])}>
        <MapExplorerLazy
          config={config}
          initial={parseMapView(params, { center: tenant.mapCenter, zoom: DEFAULT_ZOOM })}
        />
      </NextIntlClientProvider>
    </main>
  );
}
