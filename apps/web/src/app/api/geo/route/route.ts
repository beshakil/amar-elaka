import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiFetch } from '@/lib/api/fetch';
import { routeError } from '@/lib/api/route-errors';
import { routeResponseSchema } from '@/lib/api/schemas';
import { readSession } from '@/lib/auth/session';

const point = z.object({ lat: z.number(), lng: z.number() });
const bodySchema = z.object({ from: point, to: point, mode: z.enum(['car', 'foot']) });

/**
 * "রাস্তা দেখুন" (POST /geo/route, ADR 044): only ever on the visitor's tap.
 * The API limits routes per client, so this passes on who the visitor is —
 * their session when signed in, else their IP — rather than letting every
 * web visitor look like this one server.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ code: 'VALIDATION_FAILED', details: null }, { status: 400 });
  }
  const session = await readSession();
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  try {
    return NextResponse.json(
      await apiFetch({
        path: '/geo/route',
        method: 'POST',
        body: parsed.data,
        schema: routeResponseSchema,
        accessToken: session?.accessToken,
        headers: ip ? { 'x-forwarded-for': ip } : {},
      }),
    );
  } catch (error) {
    return routeError(error);
  }
}
