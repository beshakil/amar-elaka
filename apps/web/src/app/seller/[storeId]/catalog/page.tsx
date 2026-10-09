import type { Route } from 'next';
import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';
import { CopyLink } from '@/components/seller/copy-link';
import { requireViewer } from '@/lib/auth/viewer';
import { sellerStore } from '@/lib/seller/load';

/**
 * The store's WhatsApp catalog link, ready to share, and its QR code for the
 * shop counter as print-ready PDFs (A5 card, square sticker) — ADR 056/057.
 */
export default async function SellerCatalog({ params }: { params: Promise<{ storeId: string }> }) {
  const [{ storeId }, viewer] = await Promise.all([params, requireViewer()]);
  const [store, t] = await Promise.all([
    sellerStore(viewer, storeId),
    getTranslations('seller.catalog'),
  ]);
  if (store.status !== 'active') return <p className="text-muted-foreground">{t('notActive')}</p>;
  const files = (name: string, query = '') => `/seller/${storeId}/files/${name}${query}` as Route;
  const share = `https://wa.me/?text=${encodeURIComponent(store.catalogUrl)}`;
  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
        <section className="space-y-2">
          <h2 className="font-semibold">{t('link')}</h2>
          <CopyLink url={store.catalogUrl} />
          <p className="flex flex-wrap gap-3 text-sm">
            <a
              className="text-brand underline"
              href={store.catalogUrl}
              target="_blank"
              rel="noopener"
            >
              {t('open')}
            </a>
            <a className="text-brand underline" href={share} target="_blank" rel="noopener">
              {t('shareWhatsapp')}
            </a>
          </p>
        </section>
        <section className="space-y-2">
          <h2 className="font-semibold">{t('print')}</h2>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <a href={files('counter-card-a5')} download>
                {t('a5')}
              </a>
            </Button>
            <Button asChild variant="outline">
              <a href={files('counter-card-sticker')} download>
                {t('sticker')}
              </a>
            </Button>
          </div>
        </section>
      </div>
      <figure className="space-y-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- a private, per-seller image from this site's own route */}
        <img
          src={files('counter-card-preview', '?size=a5')}
          alt={t('preview')}
          width={296}
          height={420}
          className="w-full rounded-lg border shadow-sm"
        />
        <figcaption className="text-center text-sm text-muted-foreground">
          {t('preview')}
        </figcaption>
      </figure>
    </div>
  );
}
