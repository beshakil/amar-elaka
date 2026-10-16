import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { InfoListPage, pick } from '@/components/info/info-page';

const CATEGORIES = [
  'identity',
  'certificate',
  'land',
  'license',
  'social_safety',
  'agriculture',
  'education',
  'health',
  'utility',
] as const;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('infoEngine.hub');
  return { title: t('gov'), description: t('govBody'), alternates: { canonical: '/info/gov' } };
}

/** The government service guide (ADR 065): this area's offices, documents, fees and steps. */
export default async function GovServicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations('infoEngine');
  const category = pick((await searchParams).category, CATEGORIES);
  return (
    <InfoListPage
      title={t('hub.gov')}
      path="/info/gov"
      api="/info/gov-services"
      filter={{
        param: 'category',
        active: category,
        options: [
          { label: t('all'), value: null },
          ...CATEGORIES.filter((c) => t.has(`badges.${c}`)).map((c) => ({
            label: t(`badges.${c}`),
            value: c,
          })),
        ],
      }}
    />
  );
}
