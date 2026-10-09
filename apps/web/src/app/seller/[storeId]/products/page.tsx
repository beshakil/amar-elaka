import { requireViewer } from '@/lib/auth/viewer';
import { storeProducts } from '@/lib/seller/load';
import { ProductsTable } from './products-table';

/** The store's products (ADR 057): edit price and stock in place, act on many at once. */
export default async function SellerProducts({ params }: { params: Promise<{ storeId: string }> }) {
  const [{ storeId }, viewer] = await Promise.all([params, requireViewer()]);
  const first = await storeProducts(viewer, storeId, undefined);
  return <ProductsTable storeId={storeId} initial={first} />;
}
