import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiFetch } from '@/lib/api/fetch';
import { routeError } from '@/lib/api/route-errors';
import { appealOtpAcceptedSchema } from '@/lib/api/schemas';

const body = z.object({ phone: z.string().trim().min(1) });

/** The public appeal's SMS code (ADR 063): always "accepted" — whether the phone has a ban is never told. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ code: 'INVALID_PHONE' }, { status: 400 });
  try {
    return NextResponse.json(
      await apiFetch({
        path: '/appeals/request-otp',
        method: 'POST',
        schema: appealOtpAcceptedSchema,
        body: parsed.data,
      }),
    );
  } catch (error) {
    return routeError(error);
  }
}
