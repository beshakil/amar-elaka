import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { env } from '@/lib/env';
import { readSession } from '@/lib/auth/session';
import { currentTenantId } from '@/lib/tenant';

// Transport tuning (CLAUDE.md rule 5): drawing a print card or a template
// takes the API a moment; one retry for a request that is safe to repeat.
const TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 300;

const uuid = z.string().uuid();

/**
 * The seller panel's downloads (ADR 056/057), fetched with the seller's
 * session and streamed back: the import template, an import's report, the
 * counter card (PDF, or PNG to preview). Each name maps to exactly one API
 * path — not a proxy for anything else.
 */
function apiPath(storeId: string, file: string, query: URLSearchParams): string | null {
  switch (file) {
    case 'template': {
      const categoryId = query.get('categoryId') ?? '';
      const format = query.get('format') === 'csv' ? 'csv' : 'xlsx';
      if (!uuid.safeParse(categoryId).success) return null;
      return `/stores/${storeId}/import/template?categoryId=${categoryId}&format=${format}`;
    }
    case 'report': {
      const importId = query.get('importId') ?? '';
      return uuid.safeParse(importId).success
        ? `/stores/${storeId}/imports/${importId}/report.csv`
        : null;
    }
    case 'counter-card-a5':
      return `/stores/${storeId}/counter-card.pdf?size=a5`;
    case 'counter-card-sticker':
      return `/stores/${storeId}/counter-card.pdf?size=sticker`;
    case 'counter-card-preview':
      return `/stores/${storeId}/counter-card.png?size=${query.get('size') === 'sticker' ? 'sticker' : 'a5'}`;
    default:
      return null;
  }
}

async function fetchFile(url: string, headers: Record<string, string>): Promise<Response> {
  const init = { headers, signal: AbortSignal.timeout(TIMEOUT_MS) };
  try {
    const response = await fetch(url, init);
    if (response.status < 500) return response;
  } catch {
    // retried once below
  }
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ storeId: string; file: string }> },
): Promise<Response> {
  const { storeId, file } = await params;
  const path = uuid.safeParse(storeId).success
    ? apiPath(storeId, file, request.nextUrl.searchParams)
    : null;
  if (!path) return new Response(null, { status: 404 });
  const [session, tenantId] = await Promise.all([readSession(), currentTenantId()]);
  if (!session || !tenantId) return new Response(null, { status: 401 });
  try {
    const upstream = await fetchFile(`${env().API_BASE_URL}${path}`, {
      'x-tenant-id': tenantId,
      authorization: `Bearer ${session.accessToken}`,
    });
    if (!upstream.ok)
      return new Response(null, { status: upstream.status >= 500 ? 502 : upstream.status });
    const headers = new Headers({ 'Cache-Control': 'private, no-store' });
    for (const name of ['content-type', 'content-disposition']) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(upstream.body, { headers });
  } catch {
    return new Response(null, { status: 502 });
  }
}
