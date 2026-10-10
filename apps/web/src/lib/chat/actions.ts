'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { apiFetch } from '../api/fetch';
import { ApiError, ApiShapeError, ApiUnreachableError } from '../api/errors';
import {
  chatHistorySchema,
  chatReportResultSchema,
  conversationSchema,
  receiptResultSchema,
  sendResultSchema,
  type ChatHistory,
  type Conversation,
  type SendResult,
} from '../api/schemas';
import { readSession } from '../auth/session';
import { currentTenantId } from '../tenant';

/**
 * The thread's and the inbox's actions (ADR 060): the same REST endpoints as
 * the app, made by this server with the member's session. The socket only
 * listens; every send comes through here.
 */

export type ChatResult<T> = { ok: true; data: T } | { ok: false; code: string };

const uuid = z.string().uuid();
const clientId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const contentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), body: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('image'), mediaId: z.string().uuid() }).strict(),
  z
    .object({
      kind: z.literal('location'),
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    })
    .strict(),
  z.object({ kind: z.literal('listing_card'), postId: z.string().uuid() }).strict(),
]);
const reportSchema = z
  .object({
    reasonCode: z.enum(['scam', 'harassment', 'spam', 'prohibited_item', 'other']),
    // Its length limit is the API's (a setting); a longer text is refused there.
    text: z.string().trim().optional(),
  })
  .strict();

async function asMember<T>(
  call: (auth: { tenantId: string; accessToken: string }) => Promise<T>,
): Promise<ChatResult<T>> {
  const [session, tenantId] = await Promise.all([readSession(), currentTenantId()]);
  if (!session) return { ok: false, code: 'UNAUTHENTICATED' };
  if (!tenantId) return { ok: false, code: 'TENANT_REQUIRED' };
  try {
    return { ok: true, data: await call({ tenantId, accessToken: session.accessToken }) };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, code: error.code };
    if (error instanceof ApiUnreachableError) return { ok: false, code: 'NETWORK' };
    if (error instanceof ApiShapeError) return { ok: false, code: 'UNEXPECTED_RESPONSE' };
    throw error;
  }
}

const invalid = { ok: false, code: 'VALIDATION_FAILED' } as const;

export async function sendMessage(
  conversationId: string,
  clientMessageId: string,
  content: unknown,
): Promise<ChatResult<SendResult>> {
  const body = contentSchema.safeParse(content);
  if (
    !uuid.safeParse(conversationId).success ||
    !clientId.safeParse(clientMessageId).success ||
    !body.success
  ) {
    return invalid;
  }
  return asMember((auth) =>
    apiFetch({
      path: `/conversations/${conversationId}/messages`,
      method: 'POST',
      schema: sendResultSchema,
      body: { clientMessageId, content: body.data },
      ...auth,
    }),
  );
}

/** Older messages (scrolling up), or what came after the newest shown (a reconnect's catch-up). */
export async function loadMessages(
  conversationId: string,
  page: { before?: string; after?: string },
): Promise<ChatResult<ChatHistory>> {
  const cursor = page.before ?? page.after;
  if (
    !uuid.safeParse(conversationId).success ||
    (cursor !== undefined && !uuid.safeParse(cursor).success)
  ) {
    return invalid;
  }
  return asMember((auth) =>
    apiFetch({
      path: `/conversations/${conversationId}/messages`,
      schema: chatHistorySchema,
      query: page.before ? { before: page.before } : page.after ? { after: page.after } : {},
      ...auth,
    }),
  );
}

export async function reloadConversation(
  conversationId: string,
): Promise<ChatResult<Conversation>> {
  if (!uuid.safeParse(conversationId).success) return invalid;
  return asMember((auth) =>
    apiFetch({ path: `/conversations/${conversationId}`, schema: conversationSchema, ...auth }),
  );
}

export async function markRead(
  conversationId: string,
  upToMessageId: string,
): Promise<ChatResult<null>> {
  if (!uuid.safeParse(conversationId).success || !uuid.safeParse(upToMessageId).success)
    return invalid;
  return asMember(async (auth) => {
    await apiFetch({
      path: `/conversations/${conversationId}/read`,
      method: 'POST',
      schema: receiptResultSchema,
      body: { upToMessageId },
      ...auth,
    });
    return null;
  });
}

export async function setBlocked(
  conversationId: string,
  blocked: boolean,
): Promise<ChatResult<Conversation>> {
  if (!uuid.safeParse(conversationId).success) return invalid;
  return asMember((auth) =>
    apiFetch({
      path: `/conversations/${conversationId}/block`,
      method: blocked ? 'POST' : 'DELETE',
      schema: conversationSchema,
      ...auth,
    }),
  );
}

export async function reportConversation(
  conversationId: string,
  input: unknown,
): Promise<ChatResult<null>> {
  const body = reportSchema.safeParse(input);
  if (!uuid.safeParse(conversationId).success || !body.success) return invalid;
  return asMember(async (auth) => {
    await apiFetch({
      path: `/conversations/${conversationId}/report`,
      method: 'POST',
      schema: chatReportResultSchema,
      body: {
        reasonCode: body.data.reasonCode,
        ...(body.data.text ? { text: body.data.text } : {}),
      },
      ...auth,
    });
    return null;
  });
}

/** The inbox's archive / unarchive (a form button: the list re-renders). */
export async function setArchived(formData: FormData): Promise<void> {
  const id = uuid.safeParse(formData.get('conversationId'));
  if (!id.success) return;
  const archived = formData.get('archived') === 'true';
  await asMember((auth) =>
    apiFetch({
      path: `/conversations/${id.data}/archive`,
      method: archived ? 'POST' : 'DELETE',
      schema: conversationSchema,
      ...auth,
    }),
  );
  revalidatePath('/inbox');
}
