import { type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { currentTenantId } from '@/lib/tenant';

// Transport tuning (CLAUDE.md rule 5), not business rules: rendering a new
// share image takes the API a moment; a cached one is a storage read.
const TIMEOUT_MS = 8_000;
const RETRY_DELAY_MS = 200;
// Shared caches keep it a day; the page asks with ?v=<updatedAt>, so a
// changed listing is a new URL anyway.
const CACHE_CONTROL = 'public, max-age=86400';

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
 * A listing's share image on the tenant's own host (ADR 039): link
 * previews fetch it from here; the API draws it (Bengali-shaped text).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const tenantId = await currentTenantId();
  if (!tenantId || !/^[0-9a-f-]{36}$/i.test(id)) return new Response(null, { status: 404 });
  try {
    const upstream = await fetchImage(`${env().API_BASE_URL}/posts/${id}/og.png`, tenantId);
    if (!upstream.ok) return new Response(null, { status: upstream.status === 404 ? 404 : 502 });
    return new Response(upstream.body, {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': CACHE_CONTROL },
    });
  } catch {
    return new Response(null, { status: 502 });
  }
}
