'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionResult } from '@/lib/action-result';
import { apiErrorMessageKey } from '@/lib/api/error-messages';
import { apiFetch } from '@/lib/api/fetch';
import { verificationDecisionResultSchema } from '@/lib/api/schemas';
import { readSession } from '@/lib/auth/session';

export const REJECTION_REASONS = [
  'document_unclear',
  'document_expired',
  'name_mismatch',
  'suspected_fraud',
  'duplicate_submission',
  'other',
] as const;

// Mirrors the API's DTO so the client refuses what the server would.
const decision = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('approve'),
    note: z.string().trim().optional(),
    expiresAt: z.string().datetime().optional(),
  }),
  z.object({
    decision: z.literal('reject'),
    rejectionReason: z.enum(REJECTION_REASONS),
    note: z.string().trim().optional(),
  }),
  z.object({ decision: z.literal('request_visit'), note: z.string().trim().optional() }),
]);
export type VerificationDecisionInput = z.infer<typeof decision>;

/** A moderator's decision on a verification (ADR 062): the API writes the audit and moves the badge. */
export async function decideVerification(id: string, input: unknown): Promise<ActionResult> {
  const body = decision.safeParse(input);
  if (!z.string().uuid().safeParse(id).success || !body.success) {
    return { ok: false, messageKey: 'validationFailed' };
  }
  const session = await readSession();
  if (!session) return { ok: false, messageKey: 'unauthenticated' };
  try {
    await apiFetch({
      path: `/verifications/${id}/decision`,
      method: 'POST',
      schema: verificationDecisionResultSchema,
      tenantId: session.tenantId,
      accessToken: session.accessToken,
      body: { ...body.data, note: body.data.note || null },
    });
    revalidatePath('/moderation/verifications');
    return { ok: true };
  } catch (error) {
    return { ok: false, messageKey: apiErrorMessageKey(error) };
  }
}
