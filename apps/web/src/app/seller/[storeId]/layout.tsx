import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import { SellerNav } from '@/components/seller/seller-nav';
import { requireViewer } from '@/lib/auth/viewer';
import { pickMessages } from '@/lib/i18n-messages';
import { sellerStore } from '@/lib/seller/load';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * The seller web panel (ADR 057) for one store: who you are there, and its
 * sections. The API decides access — a store the seller doesn't run is a 404.
 */
export default async function SellerLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ storeId: string }>;
}) {
  const [{ storeId }, viewer] = await Promise.all([params, requireViewer()]);
  const [store, t, messages] = await Promise.all([
    sellerStore(viewer, storeId),
    getTranslations('seller'),
    getMessages(),
  ]);
  return (
    <NextIntlClientProvider
      messages={pickMessages(messages, ['seller', 'dataTable', 'postErrors'])}
    >
      <div className="space-y-6">
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-2xl font-semibold">{store.name.bn ?? store.name.en ?? store.slug}</h1>
          <p className="text-sm text-muted-foreground">
            {t(`roles.${store.myRole}`)}
            {store.status !== 'active' && ` · ${t('pendingStore')}`}
          </p>
        </header>
        <SellerNav storeId={store.id} />
        {children}
      </div>
    </NextIntlClientProvider>
  );
}
