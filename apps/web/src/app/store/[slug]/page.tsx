import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { NoCoverage } from '@/components/no-coverage';
import { PlaceholderPage } from '@/components/placeholder-page';
import { currentTenantConfig, tenantConfigForChrome } from '@/lib/tenant';

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const tenant = await tenantConfigForChrome();

  return {
    title: slug,
    description: tenant?.nameBn,
    alternates: { canonical: `/store/${slug}` },
    // Nothing real is served here yet; keep placeholders out of the index.
    robots: { index: false, follow: true },
  };
}

export default async function StorePage({ params }: Props) {
  const { slug } = await params;
  const tenant = await currentTenantConfig();
  if (!tenant) return <NoCoverage />;

  const t = await getTranslations('placeholder');
  const tNav = await getTranslations('nav');

  return (
    <PlaceholderPage
      title={slug}
      body={t('store', { slug })}
      breadcrumbs={[
        { name: tNav('home'), path: '/' },
        { name: slug, path: `/store/${slug}` },
      ]}
    />
  );
}
