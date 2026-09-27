'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState, type FormEvent } from 'react';
import { localizeDigits } from '@amar-elaka/dynamic-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Step = { kind: 'phone' } | { kind: 'code'; phone: string; resendAt: number };

/**
 * Two steps, both through this app's own route handlers: the code is sent,
 * then exchanged for a session the handler keeps in httpOnly cookies — no
 * token ever reaches this page.
 */
export function LoginForm({ next }: { next: string }) {
  const t = useTranslations('login');
  const [step, setStep] = useState<Step>({ kind: 'phone' });
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (step.kind !== 'code') return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [step.kind]);

  function describe(errorCode: string): string {
    return t.has(`errors.${errorCode}`)
      ? t(`errors.${errorCode}`)
      : t('errors.unknown', { code: errorCode });
  }

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
        setError(describe(typeof payload.code === 'string' ? payload.code : 'unknown'));
        return null;
      }
      return payload;
    } catch {
      setError(describe('API_UNREACHABLE'));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function sendCode(event?: FormEvent) {
    event?.preventDefault();
    const target = step.kind === 'code' ? step.phone : phone;
    const sent = await call('/api/auth/otp/request', { phone: target });
    if (!sent) return;
    const seconds = typeof sent.resendAfterSeconds === 'number' ? sent.resendAfterSeconds : 0;
    setStep({ kind: 'code', phone: target, resendAt: Date.now() + seconds * 1_000 });
    setCode('');
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    if (step.kind !== 'code') return;
    const verified = await call('/api/auth/otp/verify', { phone: step.phone, code });
    if (!verified) return;
    // A full load, not router.replace + refresh (those can race, leaving the
    // seller on this page): the next page and the header render afresh with
    // the new session cookies.
    window.location.assign(next);
  }

  if (step.kind === 'phone') {
    return (
      <form onSubmit={(event) => void sendCode(event)} className="space-y-3" noValidate>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('phoneLabel')}</span>
          <Input
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            placeholder={t('phoneHint')}
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            required
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy || !phone.trim()}>
          {t('sendCode')}
        </Button>
      </form>
    );
  }

  const wait = Math.max(0, Math.ceil((step.resendAt - now) / 1_000));
  return (
    <form onSubmit={(event) => void verify(event)} className="space-y-3" noValidate>
      <p className="text-sm">{t('codeSentTo', { phone: localizeDigits(step.phone, 'bn') })}</p>
      <label className="block space-y-1">
        <span className="text-sm font-medium">{t('codeLabel')}</span>
        <Input
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          required
          autoFocus
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy || !code.trim()}>
          {t('verify')}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setStep({ kind: 'phone' })}>
          {t('changePhone')}
        </Button>
        {wait > 0 ? (
          <span className="text-sm text-muted-foreground">
            {t('resendIn', { seconds: localizeDigits(String(wait), 'bn') })}
          </span>
        ) : (
          <Button type="button" variant="link" disabled={busy} onClick={() => void sendCode()}>
            {t('resend')}
          </Button>
        )}
      </div>
    </form>
  );
}
