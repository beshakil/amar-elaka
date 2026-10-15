import type { Route } from 'next';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api/fetch';
import { verificationQueueSchema } from '@/lib/api/schemas';
import { requireGrant } from '@/lib/auth/guards';
import { ModerationTabs } from '../moderation-tabs';

/**
 * The Verifications tab (ADR 062): this area's open identity and business
 * requests, oldest first. A duplicate NID (the same number on another
 * account) and a requested field visit are marked; each opens its evidence.
 */
export default async function VerificationQueuePage() {
  const viewer = await requireGrant({ module: 'verifications', action: 'approve' });
  const [page, t, format] = await Promise.all([
    apiFetch({
      path: '/verifications/queue',
      schema: verificationQueueSchema,
      tenantId: viewer.session.tenantId,
      accessToken: viewer.session.accessToken,
    }),
    getTranslations('verification'),
    getFormatter(),
  ]);
  return (
    <>
      <ModerationTabs active="verifications" />
      <h1 className="mb-1 text-xl font-semibold">{t('pageTitle')}</h1>
      <p className="mb-4 text-sm text-muted-foreground">{t('description')}</p>
      {page.items.length === 0 ? (
        <p
          className="rounded-md border p-6 text-center text-muted-foreground"
          data-testid="verification-empty"
        >
          {t('empty')}
        </p>
      ) : (
        <ul className="divide-y rounded-md border" data-testid="verification-queue">
          {page.items.map((item) => (
            <li key={item.id}>
              <Link
                href={`/moderation/verifications/${item.id}` as Route}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 p-4 hover:bg-muted"
                data-testid={`verification-${item.id}`}
              >
                <span className="min-w-40 font-medium">{item.subjectName ?? t('unnamed')}</span>
                <span className="rounded bg-muted px-2 py-0.5 text-xs">
                  {t(`level.${item.level}`)}
                </span>
                {item.nidLast3 && (
                  <span className="text-xs text-muted-foreground">
                    {t('nidLast3', { digits: item.nidLast3 })}
                  </span>
                )}
                {item.nidDuplicate && (
                  <span className="rounded bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
                    {t('duplicateNid')}
                  </span>
                )}
                {item.visitStatus === 'requested' && (
                  <span className="rounded bg-amber-500/10 px-2 py-0.5 text-xs">
                    {t('visitRequested')}
                  </span>
                )}
                <span className="ml-auto text-xs text-muted-foreground">
                  {format.dateTime(new Date(item.createdAt), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
