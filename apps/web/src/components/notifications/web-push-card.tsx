'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { BellRing } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  disableWebPush,
  dismissWebPushOffer,
  enableWebPush,
  refreshWebPush,
  shouldOfferWebPush,
  webPushState,
  type WebPushState,
} from '@/lib/notifications/web-push';

const noSubscription = () => () => {};

/**
 * Web Push, offered (ADR 060): our Bengali reason first, the browser's own
 * prompt only after "চালু করুন". In a thread it shows after the user's first
 * message (`variant="offer"`, hidden once answered or "not now"); on the
 * settings page it is the switch for this browser (`variant="settings"`).
 */
export function WebPushCard({ variant = 'offer' }: { variant?: 'offer' | 'settings' }) {
  const t = useTranslations('notifications.push');
  // What this browser says (null while server-rendering), until the user changes it here.
  const initialState = useSyncExternalStore(noSubscription, webPushState, () => null);
  const initialOffer = useSyncExternalStore(noSubscription, shouldOfferWebPush, () => false);
  const [changed, setState] = useState<WebPushState | null>(null);
  const [dismissed, setOffer] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const state = changed ?? initialState;
  const offer = dismissed ?? initialOffer;

  useEffect(() => {
    void refreshWebPush();
  }, []);

  if (state === null || state === 'unavailable') return null;
  if (variant === 'offer' && !offer) return null;

  async function enable() {
    setBusy(true);
    setError(false);
    try {
      setState(await enableWebPush());
      setOffer(false);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    await disableWebPush();
    setState(webPushState());
    setBusy(false);
  }

  return (
    <div
      className="m-2 rounded-lg border border-border bg-muted/40 p-4"
      data-testid="web-push-card"
    >
      <div className="flex items-start gap-3">
        <BellRing className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden />
        <div className="space-y-2">
          {state === 'enabled' ? (
            <p className="text-sm">{t('enabled')}</p>
          ) : state === 'denied' ? (
            <p className="text-sm">{t('denied')}</p>
          ) : state === 'unsupported' ? (
            <p className="text-sm">{t('unsupported')}</p>
          ) : (
            <>
              <p className="font-medium">{t('title')}</p>
              <p className="text-sm text-muted-foreground">{t('body')}</p>
            </>
          )}
          {error && (
            <p role="status" className="text-sm text-destructive">
              {t('failed')}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {state === 'off' && (
              <Button
                size="sm"
                onClick={() => void enable()}
                disabled={busy}
                data-testid="web-push-enable"
              >
                {t('enable')}
              </Button>
            )}
            {state === 'off' && variant === 'offer' && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  dismissWebPushOffer();
                  setOffer(false);
                }}
              >
                {t('notNow')}
              </Button>
            )}
            {state === 'enabled' && variant === 'settings' && (
              <Button size="sm" variant="outline" onClick={() => void disable()} disabled={busy}>
                {t('disable')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
