import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiFetch } from '@/lib/api/fetch';
import { routeError } from '@/lib/api/route-errors';
import { appealSubmittedSchema } from '@/lib/api/schemas';

const body = z.object({
  phone: z.string().trim().min(1),
  appealToken: z.string().min(1),
  reference: z.string().trim().min(1),
  statement: z.string().trim().min(1),
});

/** The public appeal itself; the API checks the token, the reference and today's limit. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ code: 'VALIDATION_FAILED' }, { status: 400 });
  try {
    return NextResponse.json(
      await apiFetch({
        path: '/appeals/submit',
        method: 'POST',
        schema: appealSubmittedSchema,
        body: parsed.data,
      }),
      { status: 201 },
    );
  } catch (error) {
    return routeError(error);
  }
}
