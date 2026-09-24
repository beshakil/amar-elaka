import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { NoCoverage } from '@/components/no-coverage';
import { PlaceholderPage } from '@/components/placeholder-page';
import { currentTenantConfig, tenantConfigForChrome } from '@/lib/tenant';

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const tenant = await tenantConfigForChrome();

  return {
    title: id,
    description: tenant?.nameBn,
    alternates: { canonical: `/listing/${id}` },
    // Nothing real is served here yet; keep placeholders out of the index.
    robots: { index: false, follow: true },
  };
}

export default async function ListingPage({ params }: Props) {
  const { id } = await params;
  const tenant = await currentTenantConfig();
  if (!tenant) return <NoCoverage />;

  const t = await getTranslations('placeholder');
  const tNav = await getTranslations('nav');

  return (
    <PlaceholderPage
      title={id}
      body={t('listing')}
      breadcrumbs={[
        { name: tNav('home'), path: '/' },
        { name: id, path: `/listing/${id}` },
      ]}
    />
  );
}
