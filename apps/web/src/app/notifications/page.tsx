import type { Metadata, Route } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { openHref } from '@/components/notifications/links';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api/fetch';
import { notificationInboxSchema } from '@/lib/api/schemas';
import { requireViewer } from '@/lib/auth/viewer';
import { markAllNotificationsRead } from '@/lib/notifications/actions';
import { chatTime } from '@/lib/chat/time';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { robots: { index: false, follow: false } };

const dayFormat = new Intl.DateTimeFormat('bn-BD', {
  day: 'numeric',
  month: 'short',
  timeZone: 'Asia/Dhaka',
});

/**
 * /notifications (ADR 060): the in-app inbox, the API's rendered Bengali
 * text, newest first. Each opens its page (marked read on the way).
 */
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const [{ cursor }, viewer, t] = await Promise.all([
    searchParams,
    requireViewer(),
    getTranslations('notifications'),
  ]);
  const page = await apiFetch({
    path: '/notifications',
    schema: notificationInboxSchema,
    query: cursor ? { cursor } : {},
    tenantId: viewer.tenantId,
    accessToken: viewer.session.accessToken,
  });

  return (
    <section className="mx-auto max-w-2xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <div className="flex items-center gap-3">
          {page.unreadCount > 0 && (
            <form action={markAllNotificationsRead}>
              <Button type="submit" variant="outline" size="sm">
                {t('readAll')}
              </Button>
            </form>
          )}
          <Link href={'/notifications/settings'} className="text-sm text-brand hover:underline">
            {t('settings')}
          </Link>
        </div>
      </div>
      {page.items.length === 0 ? (
        <p className="rounded-lg border border-border p-6 text-center text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <ul
          className="divide-y divide-border rounded-lg border border-border bg-card"
          data-testid="notification-list"
        >
          {page.items.map((item) => (
            <li key={item.id}>
              <a
                href={openHref(item)}
                className={cn('block p-4 hover:bg-muted', !item.read && 'bg-brand/5')}
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className={cn(!item.read && 'font-semibold')}>
                    {item.title ?? t('fallbackTitle')}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {dayFormat.format(new Date(item.createdAt))} · {chatTime(item.createdAt)}
                  </span>
                </span>
                {item.body && (
                  <span className="mt-1 block text-sm text-muted-foreground">{item.body}</span>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}
      {page.nextCursor && (
        <Link
          href={`/notifications?cursor=${page.nextCursor}` as Route}
          className="block text-center text-sm text-brand hover:underline"
        >
          {t('more')}
        </Link>
      )}
    </section>
  );
}
