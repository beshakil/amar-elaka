'use client';

import { useMemo, useState } from 'react';
import type { Route } from 'next';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { z } from 'zod';
import { SelectField, TextField, ZodForm } from '@/components/form/zod-form';
import { Button } from '@/components/ui/button';

/**
 * Posts to this app's own route handler, never to the API directly: the handler
 * exchanges the credentials for a token pair and puts it in httpOnly cookies,
 * so no token is ever reachable from client JavaScript.
 */
export function LoginForm({ tenants }: { tenants: { value: string; label: string }[] }) {
  const t = useTranslations('login');
  const tError = useTranslations('apiError');
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const schema = useMemo(
    () =>
      z.object({
        tenantId: z.string().uuid(t('tenantRequired')),
        email: z.string().email(t('emailInvalid')),
        password: z.string().min(1, t('passwordRequired')),
      }),
    [t],
  );

  async function submit(values: z.infer<typeof schema>) {
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      });

      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const code =
          typeof body === 'object' &&
          body !== null &&
          typeof (body as { code?: unknown }).code === 'string'
            ? (body as { code: string }).code
            : 'unexpected';
        setError(messageKeyFor(code));
        return;
      }

      // `next` comes from the URL, so it is only followed when it is a plain
      // in-app path — never a protocol-relative one that would leave the site.
      const next = searchParams.get('next');
      const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
      router.replace(target as Route);
      router.refresh();
    } catch {
      setError('unreachable');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ZodForm
      schema={schema}
      defaultValues={{ tenantId: '', email: '', password: '' }}
      onSubmit={submit}
    >
      <SelectField
        name="tenantId"
        label={t('tenantLabel')}
        placeholder={t('tenantPlaceholder')}
        options={tenants}
      />
      <TextField name="email" label={t('emailLabel')} type="email" autoComplete="username" />
      <TextField
        name="password"
        label={t('passwordLabel')}
        type="password"
        autoComplete="current-password"
      />

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {tError(error)}
        </p>
      ) : null}

      <Button type="submit" disabled={isSubmitting} className="w-full">
        {isSubmitting ? t('submitting') : t('submit')}
      </Button>
    </ZodForm>
  );
}

/** The route handler forwards the API's own error code; map it to a message key. */
function messageKeyFor(code: string): string {
  switch (code) {
    case 'INVALID_CREDENTIALS':
      return 'invalidCredentials';
    case 'ACCOUNT_RESTRICTED':
    case 'ACCOUNT_BANNED':
    case 'ACCOUNT_TERMINATED':
      return 'accountRestricted';
    case 'TENANT_SUSPENDED':
    case 'TENANT_TERMINATED':
      return 'tenantUnavailable';
    case 'API_UNREACHABLE':
      return 'unreachable';
    case 'VALIDATION_FAILED':
    case 'INVALID_INPUT':
      return 'validationFailed';
    default:
      return 'unexpected';
  }
}
