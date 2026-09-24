import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';

/** Shown when the hostname resolved to no tenant — never a blank page. */
export async function NoCoverage() {
  const t = await getTranslations('noCoverage');

  return (
    <section className="mx-auto max-w-xl py-12 text-center">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="mt-3 text-muted-foreground">{t('body')}</p>
      <Button asChild className="mt-6">
        <Link href="/areas">{t('action')}</Link>
      </Button>
    </section>
  );
}
