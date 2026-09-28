import { NextResponse, type NextRequest } from 'next/server';
import { apiFetch } from '@/lib/api/fetch';
import { routeError } from '@/lib/api/route-errors';
import { suggestResponseSchema } from '@/lib/api/schemas';
import { currentTenantId } from '@/lib/tenant';

// The API's own cap on q (search.dto.ts); longer input is cut, not refused.
const Q_MAX_CHARS = 200;

/**
 * The header's as-you-type suggestions (GET /search/suggest, ADR 040): this
 * server calls the API for the browser, with the tenant from the host.
 * Anonymous and uncached — they depend on what was just typed.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const q = [...(request.nextUrl.searchParams.get('q') ?? '').trim()]
    .slice(0, Q_MAX_CHARS)
    .join('');
  const tenantId = await currentTenantId();
  if (!q || !tenantId) {
    return NextResponse.json({
      query: q,
      categories: [],
      queries: [],
      listings: [],
      degraded: false,
    });
  }
  try {
    const suggestions = await apiFetch({
      path: '/search/suggest',
      schema: suggestResponseSchema,
      tenantId,
      query: { q },
    });
    return NextResponse.json(suggestions);
  } catch (error) {
    return routeError(error);
  }
}
