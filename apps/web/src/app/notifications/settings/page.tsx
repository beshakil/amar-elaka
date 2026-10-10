import type { Metadata } from 'next';
import Link from 'next/link';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import { PreferenceToggles } from '@/components/notifications/preference-toggles';
import { WebPushCard } from '@/components/notifications/web-push-card';
import { apiFetch } from '@/lib/api/fetch';
import { notificationPreferencesSchema } from '@/lib/api/schemas';
import { requireViewer } from '@/lib/auth/viewer';
import { pickMessages } from '@/lib/i18n-messages';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** /notifications/settings (ADR 060): what reaches the member, and how; and Web Push for this browser. */
export default async function NotificationSettingsPage() {
  const viewer = await requireViewer();
  const [preferences, messages, t] = await Promise.all([
    apiFetch({
      path: '/me/notification-preferences',
      schema: notificationPreferencesSchema,
      tenantId: viewer.tenantId,
      accessToken: viewer.session.accessToken,
    }),
    getMessages(),
    getTranslations('notifications'),
  ]);
  return (
    <section className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t('settingsTitle')}</h1>
        <Link href={'/notifications'} className="text-sm text-brand hover:underline">
          {t('title')}
        </Link>
      </div>
      <p className="text-muted-foreground">{t('settingsIntro')}</p>
      <NextIntlClientProvider messages={pickMessages(messages, ['notifications'])}>
        <WebPushCard variant="settings" />
        <PreferenceToggles initial={preferences.items} />
      </NextIntlClientProvider>
    </section>
  );
}
