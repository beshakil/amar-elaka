import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { InfoListPage } from '@/components/info/info-page';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('infoEngine.hub');
  return {
    title: t('outages'),
    description: t('outagesBody'),
    alternates: { canonical: '/info/outages' },
  };
}

/**
 * Load-shedding and outages (ADR 065): the area team's schedule and, once
 * enough neighbours report, unscheduled ones — by locality, expiring by
 * themselves. Reporting is in the app.
 */
export default async function OutagesPage() {
  const t = await getTranslations('infoEngine');
  return (
    <InfoListPage
      title={t('hub.outages')}
      path="/info/outages"
      api="/info/outages"
      intro={<p className="mt-2 text-sm text-muted-foreground">{t('inApp')}</p>}
    />
  );
}
