import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { InfoListPage, pick } from '@/components/info/info-page';

const MODES = ['bus', 'train', 'launch', 'ferry', 'cng_stand'] as const;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('infoEngine.hub');
  return {
    title: t('transport'),
    description: t('transportBody'),
    alternates: { canonical: '/info/transport' },
  };
}

/** Transport (ADR 065): bus, train, launch, ferry and CNG stand routes near the area. */
export default async function TransportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations('infoEngine');
  const mode = pick((await searchParams).mode, MODES);
  return (
    <InfoListPage
      title={t('hub.transport')}
      path="/info/transport"
      api="/info/transport/routes"
      filter={{
        param: 'mode',
        active: mode,
        options: [
          { label: t('all'), value: null },
          ...MODES.map((m) => ({ label: t(`badges.${m}`), value: m })),
        ],
      }}
    />
  );
}
