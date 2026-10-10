'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { localizeDigits } from '@amar-elaka/dynamic-form';
import type { NotificationItem } from '@/lib/api/schemas';
import { recentNotifications, unreadNotifications } from '@/lib/notifications/actions';
import { cn } from '@/lib/utils';
import { openHref } from './links';

// Presentation: the badge stops counting here ("৯+").
const BADGE_MAX = 9;

/**
 * The header's bell (ADR 060), for a signed-in visitor: the unread count, and on a click the newest
 * notifications — each opens its page through /notifications/open (marked
 * read on the way). The count refreshes when a web push arrives while the
 * site is in front (the service worker hands it to the page) and when the
 * tab comes back into view.
 */
export function NotificationBell() {
  const t = useTranslations('notificationBell');
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const refresh = () => {
      void unreadNotifications().then((answer) => answer.ok && setUnread(answer.data));
    };
    const onMessage = (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type === 'amar-elaka:push') {
        refresh();
        setItems(null);
      }
    };
    const onVisible = () => document.visibilityState === 'visible' && refresh();
    // Asked from the browser, so a page's HTML (often cached) never waits on it.
    refresh();
    navigator.serviceWorker?.addEventListener('message', onMessage);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      navigator.serviceWorker?.removeEventListener('message', onMessage);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next || items !== null) return;
    setFailed(false);
    const answer = await recentNotifications();
    if (answer.ok) {
      setItems(answer.data.items);
      setUnread(answer.data.unreadCount);
    } else {
      setFailed(true);
    }
  }

  const badge =
    unread > BADGE_MAX
      ? `${localizeDigits(String(BADGE_MAX), 'bn')}+`
      : localizeDigits(String(unread), 'bn');
  return (
    <div className="relative" ref={root}>
      <button
        type="button"
        onClick={() => void toggle()}
        className="relative rounded-md p-1.5 hover:bg-muted"
        aria-label={unread > 0 ? `${t('label')} — ${t('unread', { count: badge })}` : t('label')}
        aria-expanded={open}
        data-testid="notification-bell"
      >
        <Bell className="size-5" aria-hidden />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-destructive px-1 text-center text-[10px] leading-4 text-white">
            {badge}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-80 max-w-[90vw] rounded-lg border border-border bg-card shadow-lg">
          {failed ? (
            <p className="p-4 text-sm text-muted-foreground">{t('failed')}</p>
          ) : items === null ? (
            <p className="p-4 text-sm text-muted-foreground">…</p>
          ) : items.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <ul className="max-h-96 divide-y divide-border overflow-y-auto">
              {items.map((item) => (
                <li key={item.id}>
                  <a
                    href={openHref(item)}
                    className={cn('block px-4 py-3 hover:bg-muted', !item.read && 'bg-brand/5')}
                  >
                    <span className={cn('block text-sm', !item.read && 'font-semibold')}>
                      {item.title ?? item.body ?? t('label')}
                    </span>
                    {item.title && item.body && (
                      <span className="line-clamp-2 block text-xs text-muted-foreground">
                        {item.body}
                      </span>
                    )}
                  </a>
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-between border-t border-border px-4 py-2 text-sm">
            <Link href={'/notifications'} className="text-brand hover:underline">
              {t('seeAll')}
            </Link>
            <Link
              href={'/notifications/settings'}
              className="text-muted-foreground hover:underline"
            >
              {t('settings')}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
