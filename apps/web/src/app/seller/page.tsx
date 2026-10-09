import type { Metadata, Route } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireViewer } from '@/lib/auth/viewer';
import { sellerStores } from '@/lib/seller/load';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** /seller: straight into the seller's store, or a choice when they run several (ADR 057). */
export default async function SellerHome() {
  const viewer = await requireViewer();
  const [stores, t] = await Promise.all([sellerStores(viewer), getTranslations('seller')]);
  if (stores.length === 1) redirect(`/seller/${stores[0]!.id}` as Route);
  return (
    <section className="mx-auto max-w-xl space-y-4">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      {stores.length === 0 ? (
        <p className="text-muted-foreground">{t('noStore')}</p>
      ) : (
        <>
          <p>{t('chooseStore')}</p>
          <ul className="divide-y rounded-lg border">
            {stores.map((store) => (
              <li key={store.id}>
                <Link
                  href={`/seller/${store.id}` as Route}
                  className="flex items-center justify-between gap-3 p-4 hover:bg-muted"
                >
                  <span className="font-medium">
                    {store.name.bn ?? store.name.en ?? store.slug}
                  </span>
                  <span className="text-sm text-muted-foreground">{t(`roles.${store.role}`)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
