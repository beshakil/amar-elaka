import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import { pickMessages } from '@/lib/i18n-messages';
import { PublicAppeal } from './public-appeal';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * The public appeal path (ADR 063, §9.10): for a closed account, or anyone
 * who can't sign in. A code by SMS proves the phone; no session is made.
 */
export default async function AppealPage() {
  const [t, messages] = await Promise.all([getTranslations('account'), getMessages()]);
  return (
    <section className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">{t('publicTitle')}</h1>
      <p className="text-muted-foreground">{t('publicIntro')}</p>
      <NextIntlClientProvider messages={pickMessages(messages, ['account', 'login'])}>
        <PublicAppeal />
      </NextIntlClientProvider>
    </section>
  );
}
