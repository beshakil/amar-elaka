import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { tenantThemeVars } from '@/lib/branding';
import { defaultLocale } from '@/i18n/request';
import { readThemePreference } from '@/lib/theme';
import { currentOrigin, tenantConfigForChrome } from '@/lib/tenant';
import './globals.css';

// The only namespaces a client component here reads (theme-toggle, error). The
// provider serializes what it is given into every page's payload, so passing
// the whole catalog would ship all of the site's copy on every request.
const CLIENT_NAMESPACES = ['theme', 'error'];

export async function generateMetadata(): Promise<Metadata> {
  const [tenant, origin, t] = await Promise.all([
    tenantConfigForChrome(),
    currentOrigin(),
    getTranslations('site'),
  ]);
  const name = tenant ? `${tenant.nameBn} | আমার এলাকা` : 'আমার এলাকা';

  return {
    metadataBase: new URL(origin),
    title: { default: name, template: `%s | ${tenant?.nameBn ?? 'আমার এলাকা'}` },
    description: t('tagline'),
    openGraph: { title: name, description: t('tagline'), locale: 'bn_BD', type: 'website' },
    alternates: { canonical: '/' },
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The chrome never throws: if the tenant cannot be loaded, the header and
  // footer fall back to platform defaults and the page body shows the error.
  const [tenant, theme, messages, t] = await Promise.all([
    tenantConfigForChrome(),
    readThemePreference(),
    getMessages(),
    getTranslations('site'),
  ]);

  return (
    // `data-theme` is resolved on the server from the theme cookie, so the
    // correct palette is in the first byte of HTML — 'system' leaves it unset
    // and the prefers-color-scheme rules in globals.css decide.
    <html
      lang={defaultLocale}
      data-theme={theme === 'system' ? undefined : theme}
      style={tenantThemeVars(tenant)}
      suppressHydrationWarning
    >
      <body className="flex min-h-dvh flex-col font-sans antialiased">
        <NextIntlClientProvider
          messages={Object.fromEntries(
            Object.entries(messages).filter(([namespace]) => CLIENT_NAMESPACES.includes(namespace)),
          )}
        >
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:rounded-md focus:bg-card focus:px-3 focus:py-2"
          >
            {t('skipToContent')}
          </a>
          <SiteHeader tenant={tenant} theme={theme} />
          <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
            {children}
          </main>
          <SiteFooter tenant={tenant} />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
