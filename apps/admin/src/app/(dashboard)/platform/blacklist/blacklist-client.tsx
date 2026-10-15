'use client';

import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { BlacklistItem } from '@/lib/api/schemas';
import { decideBlacklist, revokeBlacklist } from '../../moderation/bans/actions';

/** Blacklist entries: the platform decides (mode 'platform'); an area only sees its own recommendations ('area'). */
export function BlacklistClient({
  items,
  mode,
}: {
  items: BlacklistItem[];
  mode: 'platform' | 'area';
}) {
  const t = useTranslations('blacklist');
  if (items.length === 0) {
    return (
      <p
        className="rounded-md border p-6 text-center text-muted-foreground"
        data-testid="blacklist-empty"
      >
        {t('empty')}
      </p>
    );
  }
  return (
    <ul className="space-y-3" data-testid="blacklist-list">
      {items.map((item) => (
        <EntryCard key={item.id} item={item} mode={mode} />
      ))}
    </ul>
  );
}

function EntryCard({ item, mode }: { item: BlacklistItem; mode: 'platform' | 'area' }) {
  const t = useTranslations('blacklist');
  const tError = useTranslations('apiError');
  const format = useFormatter();
  const router = useRouter();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<{ ok: true } | { ok: false; messageKey: string }>) {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (result.ok) router.refresh();
    else setError(tError(result.messageKey));
  }

  return (
    <li className="rounded-md border p-4" data-testid={`blacklist-${item.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{item.displayName ?? t('unnamed')}</span>
        <span className="rounded bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
          {t(`severity.${item.severity}`)}
        </span>
        <span className="rounded bg-muted px-2 py-0.5 text-xs">
          {t(`reason.${item.reasonCode}`)}
        </span>
        <span className="rounded bg-muted px-2 py-0.5 text-xs">{t(`status.${item.status}`)}</span>
        <span className="ml-auto text-xs text-muted-foreground">{item.reference}</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm">{item.summary}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {item.sourceAreaName ? t('fromArea', { area: item.sourceAreaName }) : t('fromPlatform')}
        {item.recommendedByName ? ` · ${t('by', { name: item.recommendedByName })}` : ''}
        {` · ${t('evidenceCount', { count: item.evidence.length })}`}
        {` · ${item.expiresAt ? t('until', { when: format.dateTime(new Date(item.expiresAt), { dateStyle: 'medium' }) }) : t('permanent')}`}
      </p>
      {item.reviewNote && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t('reviewNote', { note: item.reviewNote })}
        </p>
      )}
      {mode === 'platform' && (item.status === 'recommended' || item.status === 'active') && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="min-w-64 flex-1 text-sm">
            {t('note')}
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="mt-1 block w-full rounded-md border bg-background p-2"
            />
          </label>
          {item.status === 'recommended' ? (
            <>
              <Button
                disabled={busy}
                onClick={() => void run(() => decideBlacklist(item.id, 'approve', note))}
                data-testid="blacklist-approve"
              >
                {t('approve')}
              </Button>
              <Button
                variant="outline"
                className="text-destructive"
                disabled={busy || !note.trim()}
                onClick={() => void run(() => decideBlacklist(item.id, 'reject', note))}
                data-testid="blacklist-reject"
              >
                {t('reject')}
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              disabled={busy || !note.trim()}
              onClick={() => void run(() => revokeBlacklist(item.id, note))}
              data-testid="blacklist-revoke"
            >
              {t('revoke')}
            </Button>
          )}
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
