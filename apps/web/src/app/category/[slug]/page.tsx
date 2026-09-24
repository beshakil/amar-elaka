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
  const category = tenant?.enabledCategories.find((item) => item.slug === slug);
  const title = category?.nameBn ?? slug;

  return {
    title,
    description: tenant ? `${tenant.nameBn} — ${title}` : title,
    alternates: { canonical: `/category/${slug}` },
  };
}

export default async function CategoryPage({ params }: Props) {
  const { slug } = await params;
  const tenant = await currentTenantConfig();
  if (!tenant) return <NoCoverage />;

  const t = await getTranslations('placeholder');
  const tNav = await getTranslations('nav');
  const category = tenant.enabledCategories.find((item) => item.slug === slug);

  return (
    <PlaceholderPage
      title={category?.nameBn ?? slug}
      body={t('category', { slug: category?.nameBn ?? slug })}
      breadcrumbs={[
        { name: tNav('home'), path: '/' },
        { name: category?.nameBn ?? slug, path: `/category/${slug}` },
      ]}
    />
  );
}
