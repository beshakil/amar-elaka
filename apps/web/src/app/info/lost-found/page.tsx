import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { InfoListPage, pick } from '@/components/info/info-page';

const KINDS = ['lost', 'found'] as const;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('infoEngine.hub');
  return {
    title: t('lostFound'),
    description: t('lostFoundBody'),
    alternates: { canonical: '/info/lost-found' },
  };
}

/** Lost & found (ADR 065): people, pets and items near the area, moderated. */
export default async function LostFoundPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations('infoEngine');
  const kind = pick((await searchParams).kind, KINDS);
  return (
    <InfoListPage
      title={t('hub.lostFound')}
      path="/info/lost-found"
      api="/info/lost-found"
      intro={<p className="mt-2 text-sm text-muted-foreground">{t('inApp')}</p>}
      filter={{
        param: 'kind',
        active: kind,
        options: [
          { label: t('all'), value: null },
          ...KINDS.map((k) => ({ label: t(`lostFound.${k}`), value: k })),
        ],
      }}
    />
  );
}
