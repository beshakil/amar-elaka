import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import { BanNoticeCard } from '@/components/account/ban-notice-card';
import { LogoutButton } from '@/components/logout-button';
import { apiFetch } from '@/lib/api/fetch';
import { banNoticesSchema } from '@/lib/api/schemas';
import { readSession } from '@/lib/auth/session';
import { pickMessages } from '@/lib/i18n-messages';
import { currentTenantId } from '@/lib/tenant';
import { AppealForm } from './appeal-form';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * The ban notice (ADR 063, schema.md §9.10): on a banned session's
 * allow-list, so it reads the session itself (requireViewer would send a
 * banned seller straight back here).
 */
export default async function BanNoticePage() {
  const [session, tenantId] = await Promise.all([readSession(), currentTenantId()]);
  if (!session || !tenantId) redirect('/login?next=%2Faccount%2Fbans');
  const [notices, t, messages] = await Promise.all([
    apiFetch({
      path: '/account/bans',
      schema: banNoticesSchema,
      tenantId,
      accessToken: session.accessToken,
    }),
    getTranslations('account'),
    getMessages(),
  ]);
  return (
    <section className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      {notices.items.length === 0 ? (
        <p data-testid="ban-none">
          {t('none')}{' '}
          <Link href="/" className="underline">
            {t('backHome')}
          </Link>
        </p>
      ) : (
        <>
          <p className="text-muted-foreground">{t('intro')}</p>
          <NextIntlClientProvider messages={pickMessages(messages, ['account'])}>
            {notices.items.map((notice) => (
              <BanNoticeCard key={notice.id} notice={notice}>
                <AppealForm targetId={notice.id} />
              </BanNoticeCard>
            ))}
          </NextIntlClientProvider>
          <LogoutButton label={t('logout')} />
        </>
      )}
    </section>
  );
}
