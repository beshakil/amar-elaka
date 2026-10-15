'use client';

import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { AppealQueueItem } from '@/lib/api/schemas';
import { decideAppeal } from '../bans/actions';

/**
 * One appeal at a time: the ban (with its internal reason and evidence),
 * the person's statement, and the decision. On the area's queue "uphold"
 * only recommends it to the platform (the area never judges its own ban
 * finally); on the platform's it is final.
 */
export function AppealsClient({
  items,
  scope,
}: {
  items: AppealQueueItem[];
  scope: 'area' | 'platform';
}) {
  const t = useTranslations('appeals');
  if (items.length === 0) {
    return (
      <p
        className="rounded-md border p-6 text-center text-muted-foreground"
        data-testid="appeals-empty"
      >
        {t('empty')}
      </p>
    );
  }
  return (
    <ul className="space-y-3" data-testid="appeals-queue">
      {items.map((item) => (
        <AppealCard key={item.id} item={item} scope={scope} />
      ))}
    </ul>
  );
}

function AppealCard({ item, scope }: { item: AppealQueueItem; scope: 'area' | 'platform' }) {
  const t = useTranslations('appeals');
  const tBan = useTranslations('bans');
  const tError = useTranslations('apiError');
  const format = useFormatter();
  const router = useRouter();
  const [note, setNote] = useState('');
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  async function decide(decision: 'grant' | 'reduce' | 'uphold') {
    setBusy(true);
    setError(null);
    const result = await decideAppeal(scope, item.id, {
      decision,
      ...(note.trim() ? { note } : {}),
      ...(decision === 'reduce' && until
        ? { reducedUntil: new Date(`${until}T23:59:59+06:00`).toISOString() }
        : {}),
    });
    setBusy(false);
    if (result.ok) router.refresh();
    else setError(tError(result.messageKey));
  }

  return (
    <li className="rounded-md border p-4" data-testid={`appeal-${item.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{item.appellantName ?? tBan('unnamed')}</span>
        <span className="rounded bg-muted px-2 py-0.5 text-xs">{t(`kind.${item.kind}`)}</span>
        <span className="rounded bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
          {t(`severity.${item.severity}`)}
        </span>
        <span className="rounded bg-muted px-2 py-0.5 text-xs">{t(`channel.${item.channel}`)}</span>
        {item.areaName && <span className="text-xs text-muted-foreground">{item.areaName}</span>}
        <span className="ml-auto text-xs text-muted-foreground">
          {item.reference} → {item.targetReference}
        </span>
      </div>
      {item.escalationReason && (
        <p className="mt-2 rounded bg-amber-500/10 p-2 text-sm">
          {t(`escalated.${item.escalationReason}`)}
          {item.tenantNote ? ` — “${item.tenantNote}”` : ''}
        </p>
      )}
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <section aria-label={t('theBan')} className="rounded bg-muted/50 p-3 text-sm">
          <h3 className="mb-1 text-xs font-medium uppercase text-muted-foreground">
            {t('theBan')}
          </h3>
          <p className="whitespace-pre-wrap">{item.reasonText}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {item.permanent
              ? tBan('permanent')
              : item.expiresAt
                ? tBan('until', { when: when(item.expiresAt) })
                : ''}
            {item.evidence.length > 0
              ? ` · ${tBan('evidenceCount', { count: item.evidence.length })}`
              : ''}
          </p>
        </section>
        <section aria-label={t('statement')} className="rounded border p-3 text-sm">
          <h3 className="mb-1 text-xs font-medium uppercase text-muted-foreground">
            {t('statement')}
          </h3>
          <p className="whitespace-pre-wrap">{item.statement}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {when(item.submittedAt)}
            {scope === 'area' && item.escalateAt
              ? ` · ${t('decideBy', { when: when(item.escalateAt) })}`
              : ''}
          </p>
        </section>
      </div>
      <label className="mt-3 block text-sm">
        {t('note')}
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          className="mt-1 w-full rounded-md border bg-background p-2"
        />
      </label>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Button disabled={busy} onClick={() => void decide('grant')} data-testid="appeal-grant">
          {t('grant')}
        </Button>
        <label className="text-sm">
          {t('reduceUntil')}
          <input
            type="date"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            className="mt-1 block rounded-md border bg-background p-2"
          />
        </label>
        <Button
          variant="outline"
          disabled={busy || !until}
          onClick={() => void decide('reduce')}
          data-testid="appeal-reduce"
        >
          {t('reduce')}
        </Button>
        <Button
          variant="outline"
          className="text-destructive"
          disabled={busy || (scope === 'area' && !note.trim())}
          onClick={() => void decide('uphold')}
          data-testid="appeal-uphold"
        >
          {scope === 'area' ? t('recommendUphold') : t('uphold')}
        </Button>
      </div>
      {scope === 'area' && (
        <p className="mt-2 text-xs text-muted-foreground">{t('areaNotFinal')}</p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}
