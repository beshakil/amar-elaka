'use client';

import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { BanListItem } from '@/lib/api/schemas';
import { liftBan } from './actions';

export function BansClient({ items, canLift }: { items: BanListItem[]; canLift: boolean }) {
  const t = useTranslations('bans');
  if (items.length === 0) {
    return (
      <p
        className="rounded-md border p-6 text-center text-muted-foreground"
        data-testid="bans-empty"
      >
        {t('empty')}
      </p>
    );
  }
  return (
    <ul className="space-y-3" data-testid="bans-list">
      {items.map((item) => (
        <BanCard key={item.id} item={item} canLift={canLift} />
      ))}
    </ul>
  );
}

function BanCard({ item, canLift }: { item: BanListItem; canLift: boolean }) {
  const t = useTranslations('bans');
  const tError = useTranslations('apiError');
  const format = useFormatter();
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function lift() {
    setBusy(true);
    setError(null);
    const result = await liftBan(item.id, reason);
    setBusy(false);
    if (result.ok) router.refresh();
    else setError(tError(result.messageKey));
  }

  return (
    <li className="rounded-md border p-4" data-testid={`ban-${item.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{item.displayName ?? t('unnamed')}</span>
        <span className="rounded bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
          {t(`severity.${item.severity}`)}
        </span>
        <span className="rounded bg-muted px-2 py-0.5 text-xs">
          {t(`reason.${item.reasonCode}`)}
        </span>
        <span className="rounded bg-muted px-2 py-0.5 text-xs">
          {t('step', { step: item.escalationStep })}
        </span>
        {item.status !== 'active' && (
          <span className="rounded bg-muted px-2 py-0.5 text-xs">{t(`status.${item.status}`)}</span>
        )}
        {item.openAppeal && (
          <span className="rounded bg-amber-500/10 px-2 py-0.5 text-xs">{t('openAppeal')}</span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">{item.reference}</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm">{item.reasonText}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {item.permanent
          ? t('permanent')
          : t('until', {
              when: format.dateTime(new Date(item.expiresAt ?? item.startsAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              }),
            })}
        {item.bannedByName ? ` · ${t('by', { name: item.bannedByName })}` : ''}
        {item.evidence.length > 0
          ? ` · ${t('evidenceCount', { count: item.evidence.length })}`
          : ''}
      </p>
      {item.revokeReason && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t('liftedBecause', { reason: item.revokeReason })}
        </p>
      )}
      {canLift && item.status === 'active' && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="min-w-64 flex-1 text-sm">
            {t('liftReason')}
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 block w-full rounded-md border bg-background p-2"
            />
          </label>
          <Button
            variant="outline"
            disabled={busy || !reason.trim()}
            onClick={() => void lift()}
            data-testid="ban-lift"
          >
            {t('lift')}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}
