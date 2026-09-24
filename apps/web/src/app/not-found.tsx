import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';

export default async function NotFound() {
  const t = await getTranslations('notFound');

  return (
    <section className="mx-auto max-w-xl py-12 text-center">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="mt-3 text-muted-foreground">{t('body')}</p>
      <Button asChild className="mt-6">
        <Link href="/">{t('action')}</Link>
      </Button>
    </section>
  );
}
