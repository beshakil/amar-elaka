'use client';

import { MessageCircle, Phone } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { localizeDigits } from '@amar-elaka/dynamic-form';
import { Button } from '@/components/ui/button';

interface Reveal {
  channel: string;
  phone: string;
  href: string;
}

/**
 * Call / WhatsApp on a listing page (ADR 039). The number is not in the
 * page: a tap asks this site's /api/posts/<id>/contact, which records the
 * lead through the API exactly as the app does, and only then is the
 * number shown (desktop) or dialled / WhatsApp opened (phone).
 */
export function ContactActions({
  postId,
  channels,
  sold,
  loginPath,
}: {
  postId: string;
  channels: string[];
  sold: boolean;
  loginPath: string;
}) {
  const t = useTranslations('listing.contact');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Reveal | null>(null);

  if (sold) return <p className="text-sm text-muted-foreground">{t('soldNoContact')}</p>;
  if (!channels.includes('call') && !channels.includes('whatsapp')) {
    return <p className="text-sm text-muted-foreground">{t('unavailable')}</p>;
  }

  async function reveal(channel: 'call' | 'whatsapp') {
    setBusy(channel);
    setError(null);
    try {
      const response = await fetch(`/api/posts/${postId}/contact`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        code?: string;
        details?: { max?: number };
      } & Partial<Reveal>;
      if (!response.ok) {
        if (body.code === 'CONTACT_LOGIN_REQUIRED' || response.status === 401) {
          window.location.assign(loginPath);
          return;
        }
        setError(
          body.code === 'CONTACT_LIMIT_REACHED'
            ? t('limit', { max: localizeDigits(String(body.details?.max ?? ''), 'bn') })
            : body.code === 'CONTACT_CHANNEL_UNAVAILABLE'
              ? t('channelOff')
              : body.code === 'CONTACT_OWN_POST'
                ? t('ownPost')
                : t('failed'),
        );
        return;
      }
      const result = body as Reveal;
      if (channel === 'whatsapp') {
        window.open(result.href, '_blank', 'noopener');
        return;
      }
      // A phone dials straight away; a computer shows the number to call.
      if (window.matchMedia('(pointer: coarse)').matches) {
        window.location.href = result.href;
      }
      setShown(result);
    } catch {
      setError(t('failed'));
    } finally {
      setBusy(null);
    }
  }

  const local = shown ? shown.phone.replace(/^\+88/, '') : null;
  return (
    <div className="space-y-3" data-testid="contact-actions">
      <div className="flex flex-wrap gap-2">
        {channels.includes('call') && (
          <Button onClick={() => void reveal('call')} disabled={busy !== null}>
            <Phone className="size-4" aria-hidden />
            {busy === 'call' ? t('revealing') : t('showNumber')}
          </Button>
        )}
        {channels.includes('whatsapp') && (
          <Button
            variant="outline"
            onClick={() => void reveal('whatsapp')}
            disabled={busy !== null}
          >
            <MessageCircle className="size-4" aria-hidden />
            {busy === 'whatsapp' ? t('revealing') : t('whatsapp')}
          </Button>
        )}
      </div>
      {shown && local && (
        <p className="rounded-md border border-border p-3" data-testid="revealed-number">
          <span className="block text-sm text-muted-foreground">{t('numberIs')}</span>
          <a href={shown.href} className="text-lg font-semibold text-brand">
            {localizeDigits(local, 'bn')}
          </a>
        </p>
      )}
      {error && (
        <p role="status" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
