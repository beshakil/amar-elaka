'use server';

import { z } from 'zod';
import type { ActionResult } from '@/lib/action-result';
import { apiErrorMessageKey } from '@/lib/api/error-messages';
import { apiFetch } from '@/lib/api/fetch';
import { moderationResultSchema } from '@/lib/api/schemas';
import { readSession } from '@/lib/auth/session';
import { TAKEDOWN_REASONS } from './reasons';

// Mirrors the API's moderation DTOs so the client refuses what the server would.
const postId = z.string().uuid();
const decision = z.object({
  reasonCode: z.enum(TAKEDOWN_REASONS),
  reasonText: z.string().trim().min(1).optional(),
});
const hardRemoval = z.object({
  reasonCode: z.enum(TAKEDOWN_REASONS),
  reasonText: z.string().trim().min(1),
  evidenceRefs: z.array(z.string().trim().min(1)).min(1),
});

export type DecisionInput = z.infer<typeof decision>;
export type HardRemovalInput = z.infer<typeof hardRemoval>;

async function post(path: string, body?: unknown): Promise<ActionResult> {
  // Tokens live in httpOnly cookies: only the server can attach them.
  const session = await readSession();
  if (!session) return { ok: false, messageKey: 'unauthenticated' };
  try {
    await apiFetch({
      path,
      method: 'POST',
      schema: moderationResultSchema,
      tenantId: session.tenantId,
      accessToken: session.accessToken,
      ...(body === undefined ? {} : { body }),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, messageKey: apiErrorMessageKey(error) };
  }
}

export async function approvePost(id: string): Promise<ActionResult> {
  if (!postId.safeParse(id).success) return { ok: false, messageKey: 'validationFailed' };
  return post(`/moderation/${id}/approve`);
}

export async function rejectPost(id: string, input: DecisionInput): Promise<ActionResult> {
  const parsed = decision.safeParse(input);
  if (!postId.safeParse(id).success || !parsed.success)
    return { ok: false, messageKey: 'validationFailed' };
  return post(`/moderation/${id}/reject`, parsed.data);
}

export async function removePost(id: string, input: DecisionInput): Promise<ActionResult> {
  const parsed = decision.safeParse(input);
  if (!postId.safeParse(id).success || !parsed.success)
    return { ok: false, messageKey: 'validationFailed' };
  return post(`/moderation/${id}/remove`, parsed.data);
}

export async function hardRemovePost(id: string, input: HardRemovalInput): Promise<ActionResult> {
  const parsed = hardRemoval.safeParse(input);
  if (!postId.safeParse(id).success || !parsed.success)
    return { ok: false, messageKey: 'validationFailed' };
  return post(`/moderation/${id}/hard-remove`, parsed.data);
}
