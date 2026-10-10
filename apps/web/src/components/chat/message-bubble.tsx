'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertCircle, Check, CheckCheck, Clock, MapPin } from 'lucide-react';
import { formatMoney } from '@amar-elaka/dynamic-form';
import type { ChatMessage } from '@/lib/api/schemas';
import { chatTime } from '@/lib/chat/time';
import { errorKey, type DeliveryState, type PendingMessage } from '@/lib/chat/thread';
import { cn } from '@/lib/utils';

function Ticks({ state }: { state: DeliveryState }) {
  const t = useTranslations('chat.status');
  const label = t(state);
  const common = 'size-4 shrink-0';
  const icon =
    state === 'sending' ? (
      <Clock className={common} aria-hidden />
    ) : state === 'failed' ? (
      <AlertCircle className={cn(common, 'text-destructive')} aria-hidden />
    ) : state === 'sent' ? (
      <Check className={common} aria-hidden />
    ) : (
      // Read stands apart from delivered in the brand's second colour, as in the app.
      <CheckCheck
        className={cn(common, state === 'read' && 'text-amber-600 dark:text-amber-400')}
        aria-hidden
      />
    );
  return (
    <span title={label} data-testid={`ticks-${state}`} className="inline-flex">
      {icon}
      <span className="sr-only">{label}</span>
    </span>
  );
}

interface BubbleContent {
  kind: ChatMessage['kind'];
  body: string | null;
  imageUrl?: string | null;
  fullImageUrl?: string | null;
  location?: { lat: number; lng: number } | null;
  listing?: ChatMessage['listing'];
  systemEvent?: string | null;
}

function Content({ c }: { c: BubbleContent }) {
  const t = useTranslations('chat');
  switch (c.kind) {
    case 'image':
      return c.imageUrl ? (
        <a href={c.fullImageUrl ?? c.imageUrl} target="_blank" rel="noopener noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element -- a signed, short-lived storage URL */}
          <img
            src={c.imageUrl}
            alt={t('photo')}
            className="max-h-72 w-full rounded-md object-cover"
          />
        </a>
      ) : (
        <span>{t('photo')}</span>
      );
    case 'location':
      return c.location ? (
        <Link
          href={`/map?lat=${c.location.lat}&lng=${c.location.lng}&z=17` as Route}
          className="inline-flex items-center gap-1 underline"
        >
          <MapPin className="size-4" aria-hidden />
          {t('openMap')}
        </Link>
      ) : (
        <span>{t('location')}</span>
      );
    case 'listing_card':
      if (!c.listing || c.listing.state === 'listing_removed') {
        return <span className="italic">{t('listingRemoved')}</span>;
      }
      return (
        <Link href={`/listing/${c.listing.postId}` as Route} className="block space-y-1">
          <span className="block font-medium">{c.listing.title}</span>
          {c.listing.price !== null && (
            <span className="block">৳ {formatMoney(c.listing.price, 'bn')}</span>
          )}
        </Link>
      );
    case 'system':
      return <span className="italic">{t('systemLocked')}</span>;
    default:
      return <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{c.body}</p>;
  }
}

/**
 * One message in a thread (ADR 060): mine on the right in the brand's colour
 * with ticks, theirs on the left. Long Bengali wraps inside the bubble (never
 * clipped), mixed Bengali and English run in one paragraph.
 */
export function MessageBubble({
  message,
  mine,
  state,
}: {
  message: ChatMessage;
  mine: boolean;
  state?: DeliveryState | undefined;
}) {
  if (message.kind === 'system') {
    return (
      <div className="my-2 text-center text-xs text-muted-foreground" data-testid="system-message">
        <Content c={message} />
      </div>
    );
  }
  return (
    <Frame
      mine={mine}
      at={message.createdAt}
      state={mine ? state : undefined}
      testId={`message-${message.id}`}
    >
      <Content
        c={{
          ...message,
          imageUrl: message.image?.card.url ?? null,
          fullImageUrl: message.image?.full.url ?? null,
        }}
      />
    </Frame>
  );
}

/** Mine, not on the server yet: sending (a clock), or refused with the reason and what to do. */
export function PendingBubble({
  pending,
  onRetry,
  onDiscard,
  onEdit,
}: {
  pending: PendingMessage;
  onRetry: () => void;
  onDiscard: () => void;
  onEdit?: (() => void) | undefined;
}) {
  const t = useTranslations('chat');
  const c = pending.content;
  const failed = pending.state === 'failed';
  return (
    <div data-testid={`pending-${pending.clientMessageId}`}>
      <Frame mine at={pending.createdAt} state={failed ? 'failed' : 'sending'} failed={failed}>
        <Content
          c={{
            kind: c.kind,
            body: c.kind === 'text' ? c.body : null,
            imageUrl: pending.previewUrl ?? null,
            location: c.kind === 'location' ? { lat: c.lat, lng: c.lng } : null,
          }}
        />
      </Frame>
      {failed && (
        <div className="ml-auto max-w-[80%] space-y-1 text-right text-xs" role="alert">
          <p className="text-destructive">{t(`errors.${errorKey(pending.errorCode)}`)}</p>
          <div className="flex justify-end gap-3">
            {onEdit && (
              <button type="button" className="font-medium text-brand underline" onClick={onEdit}>
                {t('edit')}
              </button>
            )}
            {pending.errorCode !== 'CHAT_CONTACT_INFO_BLOCKED' && (
              <button type="button" className="font-medium text-brand underline" onClick={onRetry}>
                {t('retry')}
              </button>
            )}
            <button type="button" className="font-medium text-brand underline" onClick={onDiscard}>
              {t('discard')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Frame({
  mine,
  at,
  state,
  failed,
  testId,
  children,
}: {
  mine: boolean;
  at: string;
  state?: DeliveryState | undefined;
  failed?: boolean;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('my-1 flex', mine ? 'justify-end' : 'justify-start')} data-testid={testId}>
      <div
        className={cn(
          'max-w-[80%] rounded-2xl px-3 py-2 text-[15px] leading-relaxed',
          mine
            ? 'rounded-br-sm bg-brand/15 text-foreground'
            : 'rounded-bl-sm bg-muted text-foreground',
          failed && 'bg-destructive/10',
        )}
      >
        {children}
        <span className="mt-1 flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
          {chatTime(at)}
          {state && <Ticks state={state} />}
        </span>
      </div>
    </div>
  );
}
