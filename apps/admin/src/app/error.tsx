'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

/**
 * Catches a render/data failure anywhere below the layout, so a request that
 * cannot reach the API shows Bengali copy and a retry rather than a blank page
 * or a raw exception.
 */
export default function Error({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('error');
  const router = useRouter();
  const [isRetrying, startTransition] = useTransition();

  // The failure is almost always in a Server Component (the API was
  // unreachable), and `reset()` alone only re-renders on the client with the
  // same failed server payload. Refreshing re-runs the server render; reset
  // then clears the boundary once the new payload is in.
  function retry() {
    startTransition(() => {
      router.refresh();
      reset();
    });
  }

  return (
    <section className="mx-auto max-w-xl py-12 text-center">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="mt-3 text-muted-foreground">{t('body')}</p>
      <Button onClick={retry} disabled={isRetrying} className="mt-6">
        {t('retry')}
      </Button>
    </section>
  );
}
