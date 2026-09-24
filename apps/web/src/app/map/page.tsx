import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { NoCoverage } from '@/components/no-coverage';
import { PlaceholderPage } from '@/components/placeholder-page';
import { currentTenantConfig, tenantConfigForChrome } from '@/lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  const [tenant, t] = await Promise.all([tenantConfigForChrome(), getTranslations('nav')]);
  return {
    title: t('map'),
    description: tenant?.nameBn,
    alternates: { canonical: '/map' },
  };
}

export default async function MapPage() {
  const tenant = await currentTenantConfig();
  if (!tenant) return <NoCoverage />;

  const t = await getTranslations('placeholder');
  const tNav = await getTranslations('nav');

  return (
    <PlaceholderPage
      title={tNav('map')}
      body={t('map')}
      breadcrumbs={[
        { name: tNav('home'), path: '/' },
        { name: tNav('map'), path: '/map' },
      ]}
    />
  );
}
