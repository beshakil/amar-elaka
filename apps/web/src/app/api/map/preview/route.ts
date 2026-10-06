import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiFetch } from '@/lib/api/fetch';
import { routeError } from '@/lib/api/route-errors';
import { mapPreviewSchema } from '@/lib/api/schemas';

const querySchema = z.object({
  layer: z.enum(['posts', 'stores', 'places', 'landmarks', 'info']),
  id: z.string().uuid(),
  tenant: z.string().uuid(),
});

/**
 * The map's preview panel (GET /map/features/:layer/:id, ADR 046): photo,
 * public phones and address of one tapped pin, read by the API in the pin's
 * own tenant. Our data only.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ code: 'VALIDATION_FAILED', details: null }, { status: 400 });
  }
  const { layer, id, tenant } = parsed.data;
  try {
    return NextResponse.json(
      await apiFetch({
        path: `/map/features/${layer}/${id}`,
        schema: mapPreviewSchema,
        query: { tenant },
      }),
    );
  } catch (error) {
    return routeError(error);
  }
}
