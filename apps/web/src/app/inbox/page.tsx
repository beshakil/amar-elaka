import type { Metadata, Route } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Archive, ArchiveRestore } from 'lucide-react';
import { formatMoney, localizeDigits } from '@amar-elaka/dynamic-form';
import type { Conversation } from '@/lib/api/schemas';
import { requireViewer } from '@/lib/auth/viewer';
import { setArchived } from '@/lib/chat/actions';
import { chatInbox } from '@/lib/chat/load';
import { counterpartName } from '@/lib/chat/thread';
import { chatTime } from '@/lib/chat/time';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * /inbox (ADR 060): every conversation the member is in, any area, newest
 * activity first — the post's photo, who, the last message, the unread
 * badge, and archive (the app's swipe, as a button). `?archived=1` lists the
 * archive; `?cursor=` pages on. The open thread is live; this list is fresh
 * on every visit.
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string; cursor?: string }>;
}) {
  const [query, viewer, t] = await Promise.all([
    searchParams,
    requireViewer(),
    getTranslations('chat'),
  ]);
  const archived = query.archived === '1';
  const page = await chatInbox(viewer, { archived, cursor: query.cursor });

  return (
    <section className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{archived ? t('archive') : t('title')}</h1>
        <Link
          href={archived ? '/inbox' : '/inbox?archived=1'}
          className="text-sm text-brand hover:underline"
          data-testid="chat-open-archive"
        >
          {archived ? t('backToInbox') : t('openArchive')}
        </Link>
      </div>

      {page.items.length === 0 ? (
        <p
          className="rounded-lg border border-border p-6 text-center text-muted-foreground"
          data-testid="chat-empty"
        >
          {archived ? t('archiveEmpty') : t('empty')}
        </p>
      ) : (
        <ul
          className="divide-y divide-border rounded-lg border border-border bg-card"
          data-testid="chat-list"
        >
          {page.items.map((c) => (
            <li key={c.id} className="flex items-center gap-2 pr-2">
              <Row conversation={c} t={t} />
              <form action={setArchived}>
                <input type="hidden" name="conversationId" value={c.id} />
                <input type="hidden" name="archived" value={archived ? 'false' : 'true'} />
                <button
                  type="submit"
                  className="rounded-md p-2 text-muted-foreground hover:bg-muted"
                  aria-label={archived ? t('unarchive') : t('archiveAction')}
                  title={archived ? t('unarchive') : t('archiveAction')}
                  data-testid={`archive-${c.id}`}
                >
                  {archived ? (
                    <ArchiveRestore className="size-4" aria-hidden />
                  ) : (
                    <Archive className="size-4" aria-hidden />
                  )}
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      {page.nextCursor && (
        <Link
          href={
            `/inbox?${new URLSearchParams({ ...(archived ? { archived: '1' } : {}), cursor: page.nextCursor })}` as Route
          }
          className="block text-center text-sm text-brand hover:underline"
        >
          {t('more')}
        </Link>
      )}
    </section>
  );
}

function Row({
  conversation: c,
  t,
}: {
  conversation: Conversation;
  t: Awaited<ReturnType<typeof getTranslations<'chat'>>>;
}) {
  const unread = c.unreadCount > 0;
  const last = c.lastMessage;
  const preview = last
    ? last.kind === 'image'
      ? t('photo')
      : last.kind === 'location'
        ? t('location')
        : last.kind === 'listing_card'
          ? t('listing')
          : last.kind === 'system'
            ? t('systemLocked')
            : (last.body ?? '')
    : t('noMessagesYet');
  const mine = last?.senderMemberId === c.me.memberId;
  return (
    <Link
      href={`/inbox/${c.id}` as Route}
      className="flex min-w-0 flex-1 items-center gap-3 p-3 hover:bg-muted"
      data-testid={`conversation-${c.id}`}
    >
      {c.post?.cover ? (
        // eslint-disable-next-line @next/next/no-img-element -- storage host is not known at build time
        <img src={c.post.cover.url} alt="" className="size-12 shrink-0 rounded-md object-cover" />
      ) : (
        <span className="flex size-12 shrink-0 items-center justify-center rounded-md bg-muted font-semibold">
          {counterpartName(c, { buyer: t('buyer'), seller: t('seller') }).slice(0, 1)}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className={cn('truncate', unread && 'font-semibold')}>
            {counterpartName(c, { buyer: t('buyer'), seller: t('seller') })}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{chatTime(c.activityAt)}</span>
        </span>
        {c.post && (
          <span className="block truncate text-xs text-muted-foreground">
            {c.post.title}
            {c.post.price !== null && ` · ৳ ${formatMoney(c.post.price, 'bn')}`}
          </span>
        )}
        <span className="flex items-center justify-between gap-2">
          <span
            className={cn('truncate text-sm', unread ? 'text-foreground' : 'text-muted-foreground')}
          >
            {mine ? t('you', { text: preview }) : preview}
          </span>
          {unread && (
            <span
              className="shrink-0 rounded-full bg-brand px-2 text-xs leading-5 text-brand-foreground"
              aria-label={t('unread', { count: localizeDigits(String(c.unreadCount), 'bn') })}
              data-testid={`conversation-unread-${c.id}`}
            >
              {localizeDigits(String(c.unreadCount), 'bn')}
            </span>
          )}
        </span>
      </span>
    </Link>
  );
}
