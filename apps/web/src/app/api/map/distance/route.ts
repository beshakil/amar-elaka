import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiFetch } from '@/lib/api/fetch';
import { routeError } from '@/lib/api/route-errors';
import { mapDistanceSchema } from '@/lib/api/schemas';

const latLng = z.string().regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);
const querySchema = z.object({ from: latLng, to: latLng });

/** Straight-line distance for the preview panel (GET /map/distance: PostGIS, free). */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ code: 'VALIDATION_FAILED', details: null }, { status: 400 });
  }
  try {
    return NextResponse.json(
      await apiFetch({ path: '/map/distance', schema: mapDistanceSchema, query: parsed.data }),
    );
  } catch (error) {
    return routeError(error);
  }
}
