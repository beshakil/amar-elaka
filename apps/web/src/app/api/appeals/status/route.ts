import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiFetch } from '@/lib/api/fetch';
import { routeError } from '@/lib/api/route-errors';
import { publicAppealStatusSchema } from '@/lib/api/schemas';

const body = z.object({ phone: z.string().trim().min(1), otp: z.string().trim().min(1) });

/** After the code: the phone's bans and an appeal-only token. POST, so the code never sits in a URL. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ code: 'OTP_INCORRECT' }, { status: 400 });
  try {
    return NextResponse.json(
      await apiFetch({
        path: '/appeals/status',
        method: 'POST',
        schema: publicAppealStatusSchema,
        body: parsed.data,
      }),
    );
  } catch (error) {
    return routeError(error);
  }
}
