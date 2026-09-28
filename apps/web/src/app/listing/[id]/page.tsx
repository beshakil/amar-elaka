import type { Route } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { listingStatus } from '@/lib/listings/load';
import { listingPath } from '@/lib/seo/slug';
import { currentTenantConfig } from '@/lib/tenant';

/**
 * /listing/<id> without its slug: middleware.ts redirects it (308) to the
 * canonical /listing/<id>/<slug>. This page is the fallback for when the
 * middleware couldn't reach the API.
 */
export default async function ListingWithoutSlug({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await currentTenantConfig();
  if (!tenant) notFound();
  const status = await listingStatus(tenant, id);
  if ((status.state !== 'live' && status.state !== 'sold') || !status.title) notFound();
  permanentRedirect(listingPath(id, status.title) as Route);
}
