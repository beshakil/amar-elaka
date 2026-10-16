'use client';

import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { AdminBloodRequest } from '@/lib/api/schemas';
import { removeBloodRequest, type RemovalInput } from '../actions';

/** "B+": the ABO/Rh symbol, the same in every language. */
function symbol(code: string): string {
  const [abo = '', rh] = code.split('_');
  return `${abo.toUpperCase()}${rh === 'pos' ? '+' : '-'}`;
}

export function BloodRequestsClient({ items }: { items: AdminBloodRequest[] }) {
  const t = useTranslations('localInfo.blood');
  if (items.length === 0) {
    return <p className="rounded-md border p-6 text-center text-muted-foreground">{t('empty')}</p>;
  }
  return (
    <ul className="space-y-3" data-testid="blood-requests">
      {items.map((item) => (
        <RequestRow key={item.id} item={item} />
      ))}
    </ul>
  );
}

function RequestRow({ item }: { item: AdminBloodRequest }) {
  const t = useTranslations('localInfo.blood');
  const tError = useTranslations('apiError');
  const format = useFormatter();
  const router = useRouter();
  const [reason, setReason] = useState<RemovalInput['reasonCode']>('fake_blood_request');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    const result = await removeBloodRequest(item.id, { reasonCode: reason, reasonText: text });
    setBusy(false);
    if (result.ok) router.refresh();
    else setError(tError(result.messageKey));
  }

  return (
    <li className="rounded-md border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-destructive/10 px-2 py-0.5 font-semibold text-destructive">
          {symbol(item.bloodGroup)}
        </span>
        <span className="font-medium">{item.hospitalName}</span>
        <span className="rounded bg-muted px-2 py-0.5 text-xs">{t(`status.${item.status}`)}</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {t('neededBy', {
            time: format.dateTime(new Date(item.neededBy), {
              dateStyle: 'medium',
              timeStyle: 'short',
            }),
          })}
        </span>
      </div>
      {item.status !== 'removed' && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            aria-label={t('reason')}
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={reason}
            onChange={(e) => setReason(e.target.value as RemovalInput['reasonCode'])}
          >
            <option value="fake_blood_request">{t('reasons.fake_blood_request')}</option>
            <option value="blood_request_abuse">{t('reasons.blood_request_abuse')}</option>
          </select>
          <Input
            className="max-w-sm"
            placeholder={t('reasonText')}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            className="text-destructive"
            disabled={busy || text.trim().length < 3}
            onClick={() => void remove()}
          >
            {t('remove')}
          </Button>
          {error && <span className="text-sm text-destructive">{error}</span>}
        </div>
      )}
    </li>
  );
}
