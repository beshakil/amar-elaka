import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { InfoListPage, pick } from '@/components/info/info-page';

const CATEGORIES = ['local', 'community', 'advisory'] as const;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('infoEngine.hub');
  return {
    title: t('notices'),
    description: t('noticesBody'),
    alternates: { canonical: '/info/notices' },
  };
}

/**
 * Notices (ADR 065): union/pourashava, school, mosque committee and
 * community notices — janaza and condolence too, after a moderator —
 * each within its validity window.
 */
export default async function NoticesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations('infoEngine');
  const category = pick((await searchParams).category, CATEGORIES);
  return (
    <InfoListPage
      title={category === 'community' ? t('hub.community') : t('hub.notices')}
      path="/info/notices"
      api="/info/notices"
      filter={{
        param: 'category',
        active: category,
        options: [
          { label: t('all'), value: null },
          ...CATEGORIES.map((c) => ({ label: t(`notices.${c}`), value: c })),
        ],
      }}
    />
  );
}
