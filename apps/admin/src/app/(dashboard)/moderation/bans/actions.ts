'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionResult } from '@/lib/action-result';
import { apiErrorMessageKey } from '@/lib/api/error-messages';
import { apiFetch } from '@/lib/api/fetch';
import {
  appealDecisionResultSchema,
  BAN_REASONS,
  BLACKLIST_REASONS,
  BLACKLIST_SEVERITIES,
  banMemberLookupSchema,
  blacklistDecisionResultSchema,
  blacklistRecommendedSchema,
  COMPLAINT_PRIORITIES,
  complaintResolvedSchema,
  complaintUpdatedSchema,
  EVIDENCE_TYPES,
  issuedBanSchema,
  revokedSchema,
  type BanMember,
} from '@/lib/api/schemas';
import { readSession } from '@/lib/auth/session';

/** Bans, appeals, the blacklist and complaints (ADR 063): the API holds every rule; these only forward. */

const uuid = z.string().uuid();
const evidence = z.array(z.object({ type: z.enum(EVIDENCE_TYPES), id: uuid }));

async function send<T extends z.ZodTypeAny>(
  path: string,
  method: 'POST' | 'PATCH',
  schema: T,
  body: unknown,
  revalidate: string,
): Promise<ActionResult> {
  const session = await readSession();
  if (!session) return { ok: false, messageKey: 'unauthenticated' };
  try {
    await apiFetch({
      path,
      method,
      schema,
      tenantId: session.tenantId,
      accessToken: session.accessToken,
      body,
    });
    revalidatePath(revalidate);
    return { ok: true };
  } catch (error) {
    return { ok: false, messageKey: apiErrorMessageKey(error) };
  }
}

/** A member of this area by exact phone (the phone is not shown back). */
export async function findMember(
  phone: string,
): Promise<{ ok: true; items: BanMember[] } | { ok: false; messageKey: string }> {
  if (!/^[+0-9 -]{8,20}$/.test(phone)) return { ok: false, messageKey: 'validationFailed' };
  const session = await readSession();
  if (!session) return { ok: false, messageKey: 'unauthenticated' };
  try {
    const found = await apiFetch({
      path: `/bans/members?phone=${encodeURIComponent(phone)}`,
      schema: banMemberLookupSchema,
      tenantId: session.tenantId,
      accessToken: session.accessToken,
    });
    return { ok: true, items: found.items };
  } catch (error) {
    return { ok: false, messageKey: apiErrorMessageKey(error) };
  }
}

const issueInput = z.object({
  userId: uuid,
  severity: z.enum(['restricted', 'banned']),
  reasonCode: z.enum(BAN_REASONS),
  reasonText: z.string().trim().min(1),
  evidence,
  durationDays: z.number().int().positive().optional(),
  permanent: z.boolean().optional(),
  overrideReason: z.string().trim().optional(),
  complaintId: uuid.optional(),
});

export async function issueBan(input: unknown): Promise<ActionResult> {
  const body = issueInput.safeParse(input);
  if (!body.success) return { ok: false, messageKey: 'validationFailed' };
  return send('/bans', 'POST', issuedBanSchema, body.data, '/moderation/bans');
}

export async function liftBan(id: string, reason: string): Promise<ActionResult> {
  if (!uuid.safeParse(id).success || !reason.trim())
    return { ok: false, messageKey: 'validationFailed' };
  return send(
    `/bans/${id}/lift`,
    'POST',
    revokedSchema,
    { reason: reason.trim() },
    '/moderation/bans',
  );
}

const appealInput = z.object({
  decision: z.enum(['grant', 'reduce', 'uphold']),
  note: z.string().trim().optional(),
  reducedUntil: z.string().datetime().optional(),
});

/** scope 'area' — the area's admins; 'platform' — the final word. */
export async function decideAppeal(
  scope: 'area' | 'platform',
  id: string,
  input: unknown,
): Promise<ActionResult> {
  const body = appealInput.safeParse(input);
  if (!uuid.safeParse(id).success || !body.success)
    return { ok: false, messageKey: 'validationFailed' };
  const path = scope === 'area' ? `/appeals/${id}/decision` : `/platform/appeals/${id}/decision`;
  return send(
    path,
    'POST',
    appealDecisionResultSchema,
    body.data,
    scope === 'area' ? '/moderation/appeals' : '/platform/appeals',
  );
}

const recommendInput = z.object({
  userId: uuid,
  reasonCode: z.enum(BLACKLIST_REASONS),
  severity: z.enum(BLACKLIST_SEVERITIES),
  summary: z.string().trim().min(1),
  evidence: evidence.min(1),
  expiresAt: z.string().datetime().optional(),
});

export async function recommendBlacklist(input: unknown): Promise<ActionResult> {
  const body = recommendInput.safeParse(input);
  if (!body.success) return { ok: false, messageKey: 'validationFailed' };
  return send(
    '/blacklist/recommendations',
    'POST',
    blacklistRecommendedSchema,
    body.data,
    '/moderation/blacklist',
  );
}

export async function decideBlacklist(
  id: string,
  decision: 'approve' | 'reject',
  note: string,
): Promise<ActionResult> {
  if (!uuid.safeParse(id).success) return { ok: false, messageKey: 'validationFailed' };
  return send(
    `/platform/blacklist/${id}/decision`,
    'POST',
    blacklistDecisionResultSchema,
    { decision, ...(note.trim() ? { note: note.trim() } : {}) },
    '/platform/blacklist',
  );
}

export async function revokeBlacklist(id: string, reason: string): Promise<ActionResult> {
  if (!uuid.safeParse(id).success || !reason.trim())
    return { ok: false, messageKey: 'validationFailed' };
  return send(
    `/platform/blacklist/${id}/revoke`,
    'POST',
    revokedSchema,
    { reason: reason.trim() },
    '/platform/blacklist',
  );
}

const complaintInput = z.object({
  assigneeUserId: uuid.nullable().optional(),
  priority: z.enum(COMPLAINT_PRIORITIES).optional(),
  status: z.enum(['pending', 'in_progress']).optional(),
});

export async function updateComplaint(id: string, input: unknown): Promise<ActionResult> {
  const body = complaintInput.safeParse(input);
  if (!uuid.safeParse(id).success || !body.success)
    return { ok: false, messageKey: 'validationFailed' };
  return send(
    `/complaints/${id}`,
    'PATCH',
    complaintUpdatedSchema,
    body.data,
    '/moderation/complaints',
  );
}

export async function resolveComplaint(id: string, resolution: string): Promise<ActionResult> {
  if (!uuid.safeParse(id).success || !resolution.trim())
    return { ok: false, messageKey: 'validationFailed' };
  return send(
    `/complaints/${id}/resolve`,
    'POST',
    complaintResolvedSchema,
    { resolution: resolution.trim() },
    '/moderation/complaints',
  );
}
