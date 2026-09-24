import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import { Toaster } from 'sonner';
import { ConfirmProvider } from '@/components/ui/confirm';
import { defaultLocale } from '@/i18n/request';
import { readUiPreferences } from '@/lib/ui-preferences';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('app');
  return { title: t('title'), robots: { index: false, follow: false } };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [{ theme }, messages] = await Promise.all([readUiPreferences(), getMessages()]);

  return (
    <html lang={defaultLocale} data-theme={theme === 'system' ? undefined : theme}>
      <body className="min-h-dvh font-sans antialiased">
        <NextIntlClientProvider messages={messages}>
          <ConfirmProvider>
            {children}
            <Toaster position="top-center" richColors />
          </ConfirmProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
