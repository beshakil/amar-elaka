'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { apiFetch } from '../api/fetch';
import { ApiError } from '../api/errors';
import { appealSubmittedSchema } from '../api/schemas';
import { readSession } from '../auth/session';
import { currentTenantId } from '../tenant';

const input = z.object({ targetId: z.string().uuid(), statement: z.string().trim().min(1) });

/** The in-app appeal of one ban (ADR 063): one per ban; the API holds the rules. */
export async function submitAppeal(
  raw: unknown,
): Promise<{ ok: true; reference: string } | { ok: false; code: string; reason: string | null }> {
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED', reason: null };
  const [session, tenantId] = await Promise.all([readSession(), currentTenantId()]);
  if (!session || !tenantId) return { ok: false, code: 'UNAUTHENTICATED', reason: null };
  try {
    const appeal = await apiFetch({
      path: '/account/appeals',
      method: 'POST',
      schema: appealSubmittedSchema,
      tenantId,
      accessToken: session.accessToken,
      body: parsed.data,
    });
    revalidatePath('/account/bans');
    return { ok: true, reference: appeal.reference };
  } catch (error) {
    if (error instanceof ApiError) {
      const details = error.details as { reason?: unknown } | null | undefined;
      return {
        ok: false,
        code: error.code,
        reason: typeof details?.reason === 'string' ? details.reason : null,
      };
    }
    return { ok: false, code: 'API_UNREACHABLE', reason: null };
  }
}
