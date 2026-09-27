import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import { NoCoverage } from '@/components/no-coverage';
import { pickMessages } from '@/lib/i18n-messages';
import { safeNext } from '@/lib/auth/session';
import { currentTenantConfig } from '@/lib/tenant';
import { LoginForm } from './login-form';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * Sign in with a phone number and the SMS code — the same way as the app.
 * `next` (an in-app path only) is where the seller goes afterwards.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const [tenant, t, messages, { next }] = await Promise.all([
    currentTenantConfig(),
    getTranslations('login'),
    getMessages(),
    searchParams,
  ]);
  if (!tenant) return <NoCoverage />;
  return (
    <section className="mx-auto max-w-md space-y-4">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="text-muted-foreground">{t('intro')}</p>
      <NextIntlClientProvider messages={pickMessages(messages, ['login'])}>
        <LoginForm next={safeNext(next, '/me/posts')} />
      </NextIntlClientProvider>
    </section>
  );
}
