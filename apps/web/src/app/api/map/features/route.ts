import { NextResponse, type NextRequest } from 'next/server';
import { apiFetch } from '@/lib/api/fetch';
import { routeError } from '@/lib/api/route-errors';
import { mapFeaturesResponseSchema } from '@/lib/api/schemas';

const PARAMS = ['bbox', 'zoom', 'layers', 'category', 'open_now'] as const;
// The API validates the values; this only keeps a stray parameter short.
const PARAM_MAX_CHARS = 200;

/**
 * The map page's features (GET /map/features, ADR 045): this server asks the
 * API for the browser after each pan or zoom has ended. Global, no tenant:
 * the API clusters by radius from the viewport, whichever tenant owns a
 * point, from our own database only.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const query: Record<string, string> = {};
  for (const key of PARAMS) {
    const value = request.nextUrl.searchParams.get(key);
    if (value) query[key] = value.slice(0, PARAM_MAX_CHARS);
  }
  try {
    return NextResponse.json(
      await apiFetch({ path: '/map/features', schema: mapFeaturesResponseSchema, query }),
    );
  } catch (error) {
    return routeError(error);
  }
}
