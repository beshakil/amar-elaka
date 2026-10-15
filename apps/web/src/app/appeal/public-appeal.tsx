'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { noticeLines } from '@/lib/account/notice';
import type { BanNotice, PublicAppealStatus } from '@/lib/api/schemas';

type Step =
  | { kind: 'phone' }
  | { kind: 'code'; phone: string }
  | { kind: 'choose'; phone: string; status: PublicAppealStatus }
  | { kind: 'statement'; phone: string; status: PublicAppealStatus; notice: BanNotice }
  | { kind: 'done'; reference: string };

/** phone → code → the ban → the statement → the reference. */
export function PublicAppeal() {
  const t = useTranslations('account');
  const tLogin = useTranslations('login');
  const format = useFormatter();
  const [step, setStep] = useState<Step>({ kind: 'phone' });
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [statement, setStatement] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(path: string, body: unknown): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        const errorCode = typeof payload.code === 'string' ? payload.code : 'unknown';
        const details = payload.details as { reason?: string } | null | undefined;
        const key = details?.reason ?? errorCode;
        setError(
          t.has(`appealErrors.${key}`)
            ? t(`appealErrors.${key}`)
            : tLogin.has(`errors.${errorCode}`)
              ? tLogin(`errors.${errorCode}`)
              : t('appealErrors.unknown'),
        );
        return null;
      }
      return payload;
    } catch {
      setError(tLogin('errors.API_UNREACHABLE'));
      return null;
    } finally {
      setBusy(false);
    }
  }

  const describe = (notice: BanNotice) => {
    const lines = noticeLines(notice);
    return [
      t(lines.severityKey),
      t(lines.reasonKey),
      lines.until
        ? t('until', { date: format.dateTime(new Date(lines.until), { dateStyle: 'long' }) })
        : t('permanent'),
      lines.area ? t('inArea', { area: lines.area }) : t('everywhere'),
    ].join(' · ');
  };

  return (
    <div className="space-y-4" data-testid="public-appeal">
      {step.kind === 'phone' && (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void call('/api/appeals/request-otp', { phone }).then(
              (ok) => ok && setStep({ kind: 'code', phone }),
            );
          }}
        >
          <label className="block space-y-1">
            <span className="text-sm font-medium">{tLogin('phoneLabel')}</span>
            <Input
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder={tLogin('phoneHint')}
            />
          </label>
          <Button type="submit" disabled={busy || !phone.trim()}>
            {tLogin('sendCode')}
          </Button>
        </form>
      )}
      {step.kind === 'code' && (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void call('/api/appeals/status', { phone: step.phone, otp: code }).then(
              (status) =>
                status &&
                setStep({
                  kind: 'choose',
                  phone: step.phone,
                  status: status as unknown as PublicAppealStatus,
                }),
            );
          }}
        >
          <p className="text-sm">{t('codeSent')}</p>
          <label className="block space-y-1">
            <span className="text-sm font-medium">{tLogin('codeLabel')}</span>
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <Button type="submit" disabled={busy || !code.trim()}>
            {t('check')}
          </Button>
        </form>
      )}
      {step.kind === 'choose' &&
        (step.status.items.length === 0 ? (
          <p data-testid="public-appeal-nothing">{t('nothingToAppeal')}</p>
        ) : (
          <ul className="space-y-3">
            {step.status.items.map((notice) => {
              const lines = noticeLines(notice);
              return (
                <li key={notice.id} className="space-y-2 rounded-lg border p-4">
                  <p className="text-sm">{describe(notice)}</p>
                  <p className="font-mono text-sm">{notice.reference}</p>
                  {lines.appeal ? (
                    <p className="text-sm font-medium">
                      {t(lines.appeal.statusKey, { reference: lines.appeal.reference })}
                    </p>
                  ) : (
                    lines.canAppeal &&
                    step.status.appealsLeftToday > 0 && (
                      <Button
                        variant="outline"
                        onClick={() => setStep({ ...step, kind: 'statement', notice })}
                      >
                        {t('appeal')}
                      </Button>
                    )
                  )}
                </li>
              );
            })}
            {step.status.appealsLeftToday === 0 && (
              <p className="text-sm">{t('appealErrors.rate_limited')}</p>
            )}
          </ul>
        ))}
      {step.kind === 'statement' && (
        <div className="space-y-3">
          <p className="text-sm">{t('appealFor', { reference: step.notice.reference })}</p>
          <textarea
            value={statement}
            onChange={(e) => setStatement(e.target.value)}
            rows={5}
            className="w-full rounded-md border bg-background p-2"
            placeholder={t('statementHint')}
          />
          <Button
            disabled={busy || !statement.trim()}
            onClick={() =>
              void call('/api/appeals/submit', {
                phone: step.phone,
                appealToken: step.status.appealToken,
                reference: step.notice.reference,
                statement,
              }).then(
                (done) => done && setStep({ kind: 'done', reference: String(done.reference) }),
              )
            }
          >
            {t('appealSubmit')}
          </Button>
        </div>
      )}
      {step.kind === 'done' && (
        <p data-testid="public-appeal-done">{t('publicDone', { reference: step.reference })}</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
