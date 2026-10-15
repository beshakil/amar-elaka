'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { decideVerification, REJECTION_REASONS } from '../actions';

/** Approve (optionally until an earlier date), reject with a reason, or ask for a field visit. */
export function DecisionPanel({
  id,
  level,
  visitRequested,
}: {
  id: string;
  level: 'identity_checked' | 'business_verified';
  visitRequested: boolean;
}) {
  const t = useTranslations('verification');
  const tError = useTranslations('apiError');
  const router = useRouter();
  const [reason, setReason] = useState<(typeof REJECTION_REASONS)[number]>(REJECTION_REASONS[0]);
  const [note, setNote] = useState('');
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(input: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const result = await decideVerification(id, { ...input, note: note.trim() || undefined });
    setBusy(false);
    if (result.ok) router.push('/moderation/verifications');
    else setError(tError(result.messageKey));
  }

  return (
    <section
      className="space-y-4 rounded-md border p-4"
      aria-label={t('decision')}
      data-testid="decision-panel"
    >
      <h2 className="font-medium">{t('decision')}</h2>
      <label className="block text-sm">
        {t('note')}
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="mt-1 w-full rounded-md border bg-background p-2"
          rows={2}
          placeholder={t('notePlaceholder')}
        />
      </label>
      <div className="flex flex-wrap items-end gap-3">
        {level === 'business_verified' && (
          <label className="text-sm">
            {t('validUntil')}
            <input
              type="date"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              className="mt-1 block rounded-md border bg-background p-2"
            />
          </label>
        )}
        <Button
          disabled={busy}
          onClick={() =>
            void send({
              decision: 'approve',
              ...(until ? { expiresAt: new Date(`${until}T23:59:59+06:00`).toISOString() } : {}),
            })
          }
          data-testid="verification-approve"
        >
          {t('approve')}
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          {t('rejectionReason')}
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value as (typeof REJECTION_REASONS)[number])}
            className="mt-1 block rounded-md border bg-background p-2"
          >
            {REJECTION_REASONS.map((r) => (
              <option key={r} value={r}>
                {t(`rejection.${r}`)}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="outline"
          className="text-destructive"
          disabled={busy}
          onClick={() => void send({ decision: 'reject', rejectionReason: reason })}
          data-testid="verification-reject"
        >
          {t('reject')}
        </Button>
        {level === 'business_verified' && !visitRequested && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void send({ decision: 'request_visit' })}
          >
            {t('requestVisit')}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
