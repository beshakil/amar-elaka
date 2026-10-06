import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { pickMessages } from '@/lib/i18n-messages';
import { loadMapConfig } from '@/lib/map/config';
import { MapDebug } from './map-debug';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * The Bengali shaping spike (ADR 043): six Bengali names drawn as map text by
 * MapLibre and, beside them, as ordinary HTML text, in both themes and both
 * label languages. Check conjuncts in Chrome here (and on a real Android phone
 * in the app's debug screen). Not served in production unless
 * ENABLE_DEV_PAGES=true (the headless style test turns it on).
 */
export default async function MapDebugPage() {
  if (process.env.NODE_ENV === 'production' && process.env.ENABLE_DEV_PAGES !== 'true') {
    notFound();
  }
  const [config, messages] = await Promise.all([loadMapConfig(), getMessages()]);
  return (
    <NextIntlClientProvider messages={pickMessages(messages, ['map'])}>
      <MapDebug config={config} />
    </NextIntlClientProvider>
  );
}
