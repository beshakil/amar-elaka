'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { submitAppeal } from '@/lib/account/actions';

/** The person's statement against one ban — sent once (ADR 063). */
export function AppealForm({ targetId }: { targetId: string }) {
  const t = useTranslations('account');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [statement, setStatement] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setMessage(null);
    const result = await submitAppeal({ targetId, statement });
    setBusy(false);
    if (result.ok) {
      setMessage(t('appealSent', { reference: result.reference }));
      router.refresh();
    } else {
      setMessage(
        t.has(`appealErrors.${result.reason ?? result.code}`)
          ? t(`appealErrors.${result.reason ?? result.code}`)
          : t('appealErrors.unknown'),
      );
    }
  }

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)} data-testid="ban-appeal">
        {t('appeal')}
      </Button>
    );
  }
  return (
    <div className="space-y-2">
      <label className="block space-y-1 text-sm">
        <span className="font-medium">{t('statement')}</span>
        <textarea
          value={statement}
          onChange={(event) => setStatement(event.target.value)}
          rows={4}
          className="w-full rounded-md border bg-background p-2"
          placeholder={t('statementHint')}
          data-testid="appeal-statement"
        />
      </label>
      <Button
        disabled={busy || !statement.trim()}
        onClick={() => void send()}
        data-testid="appeal-submit"
      >
        {t('appealSubmit')}
      </Button>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </div>
  );
}
