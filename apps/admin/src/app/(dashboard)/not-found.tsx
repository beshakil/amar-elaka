import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';

/**
 * Where a dashboard page gate (`requireGrant`, `requirePlatformAdmin` in a
 * segment layout) lands: inside the dashboard shell, so the sidebar and topbar
 * stay. Next sends a thrown notFound() as a 404 with this tree in the RSC
 * payload and renders it on hydration — React cannot server-render an error
 * boundary's fallback — which is fine for a dashboard that needs JS anyway.
 */
export default async function DashboardNotFound() {
  const t = await getTranslations('notFound');

  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="mt-3 text-muted-foreground">{t('body')}</p>
      <Button asChild className="mt-6">
        <Link href="/">{t('action')}</Link>
      </Button>
    </div>
  );
}
