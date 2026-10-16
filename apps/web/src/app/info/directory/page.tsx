import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { InfoListPage, pick } from '@/components/info/info-page';

const KINDS = ['health', 'pharmacy', 'education'] as const;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('infoEngine.hub');
  return {
    title: t('directory'),
    description: t('directoryBody'),
    alternates: { canonical: '/info/directory' },
  };
}

/**
 * Directories (ADR 065): hospitals, clinics and diagnostic centres,
 * pharmacies (24-hour flagged), schools, colleges and madrasas — places,
 * nearest first; a tap opens them on the map.
 */
export default async function DirectoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations('infoEngine');
  const kind = pick((await searchParams).kind, KINDS) ?? 'health';
  return (
    <InfoListPage
      title={t('hub.directory')}
      path="/info/directory"
      api="/info/directory"
      filter={{
        param: 'kind',
        active: kind,
        options: KINDS.map((k) => ({ label: t(`directory.${k}`), value: k })),
      }}
    />
  );
}
