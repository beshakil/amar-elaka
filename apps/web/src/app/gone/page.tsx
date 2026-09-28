import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('seo');
  return { title: { absolute: t('goneTitle') }, robots: { index: false, follow: true } };
}

/**
 * What a listing that is gone for good shows — served with HTTP 410 by
 * middleware.ts (expired, removed, deleted or scrubbed; ADR 039), so search
 * engines drop it faster than a 404 would make them.
 */
export default async function GonePage() {
  const t = await getTranslations('gone');
  return (
    <section className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="mt-3 text-muted-foreground">{t('body')}</p>
      <Link href="/" className="mt-6 inline-block text-brand hover:underline">
        {t('home')}
      </Link>
    </section>
  );
}
