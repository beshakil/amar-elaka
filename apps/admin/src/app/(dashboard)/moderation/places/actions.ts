'use server';

import { z } from 'zod';
import type { ActionResult } from '@/lib/action-result';
import { apiErrorMessageKey } from '@/lib/api/error-messages';
import { apiFetch } from '@/lib/api/fetch';
import { placeActionResultSchema } from '@/lib/api/schemas';
import { readSession } from '@/lib/auth/session';
import { TAKEDOWN_REASONS } from '../reasons';
import {
  CLAIM_REJECT_REASONS,
  REPORT_DECISIONS,
  SUGGESTION_REJECT_REASONS,
  type ReportDecision,
} from './reasons';

// Mirrors the API's DTOs so the client refuses what the server would.
const id = z.string().uuid();
const text = z.string().trim().min(1).optional();
const placeDecision = z.object({ reasonCode: z.enum(TAKEDOWN_REASONS), reasonText: text });
const claimReject = z.object({ reasonCode: z.enum(CLAIM_REJECT_REASONS), reasonText: text });
const suggestionReject = z.object({
  reasonCode: z.enum(SUGGESTION_REJECT_REASONS),
  reasonText: text,
});
const reportDecision = z
  .object({
    decision: z.enum(REPORT_DECISIONS),
    reasonCode: z.enum(TAKEDOWN_REASONS).optional(),
    reasonText: text,
  })
  .refine((v) => v.decision !== 'unpublish' || v.reasonCode !== undefined);

export type PlaceDecisionInput = z.infer<typeof placeDecision>;
export type ClaimRejectInput = z.infer<typeof claimReject>;
export type SuggestionRejectInput = z.infer<typeof suggestionReject>;
export type ReportDecisionInput = { decision: ReportDecision } & Partial<PlaceDecisionInput>;

const invalid: ActionResult = { ok: false, messageKey: 'validationFailed' };

async function post(path: string, body: unknown = {}): Promise<ActionResult> {
  // Tokens live in httpOnly cookies: only the server can attach them.
  const session = await readSession();
  if (!session) return { ok: false, messageKey: 'unauthenticated' };
  try {
    await apiFetch({
      path,
      method: 'POST',
      schema: placeActionResultSchema,
      tenantId: session.tenantId,
      accessToken: session.accessToken,
      body,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, messageKey: apiErrorMessageKey(error) };
  }
}

function withBody<T>(
  rawId: string,
  schema: z.ZodType<T>,
  input: unknown,
  path: (id: string) => string,
): Promise<ActionResult> {
  const parsed = schema.safeParse(input);
  if (!id.safeParse(rawId).success || !parsed.success) return Promise.resolve(invalid);
  return post(path(rawId), parsed.data);
}

// ---- new places ----

export async function approvePlace(placeId: string): Promise<ActionResult> {
  if (!id.safeParse(placeId).success) return invalid;
  return post(`/places/${placeId}/approve`);
}

export async function rejectPlace(
  placeId: string,
  input: PlaceDecisionInput,
): Promise<ActionResult> {
  return withBody(placeId, placeDecision, input, (p) => `/places/${p}/reject`);
}

// ---- claims ----

export async function approveClaim(claimId: string): Promise<ActionResult> {
  if (!id.safeParse(claimId).success) return invalid;
  return post(`/place-claims/${claimId}/approve`);
}

export async function rejectClaim(claimId: string, input: ClaimRejectInput): Promise<ActionResult> {
  return withBody(claimId, claimReject, input, (c) => `/place-claims/${c}/reject`);
}

// ---- edit suggestions ----

export async function approveSuggestion(suggestionId: string): Promise<ActionResult> {
  if (!id.safeParse(suggestionId).success) return invalid;
  return post(`/place-suggestions/${suggestionId}/approve`);
}

export async function rejectSuggestion(
  suggestionId: string,
  input: SuggestionRejectInput,
): Promise<ActionResult> {
  return withBody(suggestionId, suggestionReject, input, (s) => `/place-suggestions/${s}/reject`);
}

// ---- duplicates ----

/** The flagged place goes into the existing one (the API keeps an undo window). */
export async function mergeDuplicate(placeId: string, targetId: string): Promise<ActionResult> {
  if (!id.safeParse(placeId).success || !id.safeParse(targetId).success) return invalid;
  return post(`/places/${placeId}/merge-into/${targetId}`, { reasonCode: 'duplicate' });
}

export async function dismissDuplicate(candidateId: string): Promise<ActionResult> {
  if (!id.safeParse(candidateId).success) return invalid;
  return post(`/places/duplicates/${candidateId}/dismiss`);
}

// ---- reports ----

export async function decideReports(
  placeId: string,
  input: ReportDecisionInput,
): Promise<ActionResult> {
  return withBody(placeId, reportDecision, input, (p) => `/places/${p}/reports/decision`);
}
