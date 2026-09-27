import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiFetch } from '@/lib/api/fetch';
import { routeError } from '@/lib/api/route-errors';
import { otpSentSchema } from '@/lib/api/schemas';
import { currentTenantId } from '@/lib/tenant';

const bodySchema = z.object({ phone: z.string().trim().min(1) });

/** Sends a login code by SMS. The phone's format is the API's to judge (INVALID_PHONE). */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ code: 'INVALID_PHONE' }, { status: 400 });
  const tenantId = await currentTenantId();
  if (!tenantId) return NextResponse.json({ code: 'TENANT_REQUIRED' }, { status: 400 });
  try {
    const sent = await apiFetch({
      path: '/auth/otp/request',
      method: 'POST',
      schema: otpSentSchema,
      tenantId,
      body: { phone: parsed.data.phone },
    });
    return NextResponse.json(sent);
  } catch (error) {
    return routeError(error);
  }
}
