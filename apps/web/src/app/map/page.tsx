import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import { MapExplorer } from '@/components/map/map-explorer';
import { NoCoverage } from '@/components/no-coverage';
import { pickMessages } from '@/lib/i18n-messages';
import { loadMapConfig } from '@/lib/map/config';
import { currentTenantConfig, tenantConfigForChrome } from '@/lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  const [tenant, t] = await Promise.all([tenantConfigForChrome(), getTranslations('nav')]);
  return {
    title: t('map'),
    description: tenant?.nameBn,
    alternates: { canonical: '/map' },
  };
}

/**
 * The area map (ADR 044): posts, stores and places around the tenant's
 * centre, clustered by the API, on our self-hosted base map (ADR 043).
 */
export default async function MapPage() {
  const [tenant, config, messages] = await Promise.all([
    currentTenantConfig(),
    loadMapConfig(),
    getMessages(),
  ]);
  if (!tenant) return <NoCoverage />;
  const t = await getTranslations('map.explorer');

  return (
    <main id="main" className="mx-auto max-w-6xl space-y-4 px-4 py-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <NextIntlClientProvider messages={pickMessages(messages, ['map'])}>
        <MapExplorer config={config} center={tenant.mapCenter} />
      </NextIntlClientProvider>
    </main>
  );
}
