import { requireViewer } from '@/lib/auth/viewer';
import { postableCategories } from '@/lib/posts/load';
import { recentImports } from '@/lib/seller/load';
import { ImportFlow } from './import-flow';

/** Bulk upload (ADR 056/057): template → fill → upload → dry run → import, with a row-level report. */
export default async function SellerImport({ params }: { params: Promise<{ storeId: string }> }) {
  const [{ storeId }, viewer] = await Promise.all([params, requireViewer()]);
  const [categories, recent] = await Promise.all([
    postableCategories(viewer),
    recentImports(viewer, storeId),
  ]);
  return (
    <ImportFlow
      storeId={storeId}
      categories={categories.map((c) => ({ id: c.id, name: c.name.bn }))}
      recent={recent.items}
    />
  );
}
