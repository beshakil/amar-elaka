import type { Metadata } from 'next';
import type { Route } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { CloudSun, Sprout, Tractor } from 'lucide-react';
import { InfoShell } from '@/components/info/info-page';
import { NoCoverage } from '@/components/no-coverage';
import { infoServices } from '@/lib/info/engine';
import { currentTenantConfig } from '@/lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('infoEngine.hub');
  return { title: t('agri'), description: t('agriBody'), alternates: { canonical: '/info/agri' } };
}

/**
 * Farming (ADR 065), for rural areas: the input price board (the bazar
 * board's agri side), the area team's weather and farming advisories, and
 * equipment rental — which is ordinary posts in the agriculture category.
 */
export default async function AgriPage() {
  const tenant = await currentTenantConfig();
  if (!tenant) return <NoCoverage />;
  const [t, services] = await Promise.all([getTranslations('infoEngine'), infoServices(tenant)]);
  const links = [
    { href: '/info/bazar?board=agri', icon: Sprout, label: t('agri.prices') },
    { href: '/info/notices?category=advisory', icon: CloudSun, label: t('agri.advisories') },
    ...(tenant.enabledCategories.some((c) => c.slug === 'agriculture')
      ? [{ href: '/category/agriculture', icon: Tractor, label: t('agri.equipment') }]
      : []),
  ];
  return (
    <InfoShell title={t('hub.agri')} path="/info/agri">
      {services.agri ? (
        <ul className="mt-6 grid gap-3 sm:grid-cols-3">
          {links.map(({ href, icon: Icon, label }) => (
            <li key={href}>
              <Link
                href={href as Route}
                className="flex items-center gap-3 rounded-lg border border-border p-4 hover:bg-muted"
              >
                <Icon className="size-6 text-brand" aria-hidden />
                <span className="font-semibold">{label}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-muted-foreground">{t('agri.disabled')}</p>
      )}
    </InfoShell>
  );
}
