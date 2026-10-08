import { type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { currentTenantId } from '@/lib/tenant';

// Transport tuning (CLAUDE.md rule 5), not business rules: rendering a new
// share image takes the API a moment; a cached one is a storage read.
const TIMEOUT_MS = 8_000;
const RETRY_DELAY_MS = 200;
// An hour: the card shows the store's product count, so it may not live long.
const CACHE_CONTROL = 'public, max-age=3600';
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function fetchImage(url: string, tenantId: string): Promise<Response> {
  const init = { headers: { 'x-tenant-id': tenantId }, signal: AbortSignal.timeout(TIMEOUT_MS) };
  try {
    const response = await fetch(url, init);
    if (response.status < 500) return response;
  } catch {
    // retried once below
  }
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/**
 * A store catalog's share card on the tenant's own host (ADR 056): WhatsApp's
 * link preview fetches it from here; the API draws it (Bengali-shaped text).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const tenantId = await currentTenantId();
  if (!tenantId || !SLUG.test(slug)) return new Response(null, { status: 404 });
  try {
    const upstream = await fetchImage(`${env().API_BASE_URL}/stores/${slug}/og.png`, tenantId);
    if (!upstream.ok) return new Response(null, { status: upstream.status === 404 ? 404 : 502 });
    return new Response(upstream.body, {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': CACHE_CONTROL },
    });
  } catch {
    return new Response(null, { status: 502 });
  }
}
