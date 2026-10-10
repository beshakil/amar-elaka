import { notFound } from 'next/navigation';
import { ApiError } from '../api/errors';
import { apiFetch } from '../api/fetch';
import {
  chatHistorySchema,
  chatInboxSchema,
  conversationSchema,
  openConversationSchema,
  quickReplyListSchema,
  type ChatHistory,
  type ChatInbox,
  type Conversation,
  type QuickReplyList,
} from '../api/schemas';
import type { Viewer } from '../auth/viewer';

/** The inbox pages' reads (ADR 060), as the signed-in member; the API decides who may see what. */

const auth = (viewer: Viewer) => ({
  tenantId: viewer.tenantId,
  accessToken: viewer.session.accessToken,
});

export function chatInbox(
  viewer: Viewer,
  { archived, cursor }: { archived: boolean; cursor?: string | undefined },
): Promise<ChatInbox> {
  return apiFetch({
    path: '/conversations',
    schema: chatInboxSchema,
    query: { archived: archived ? 'true' : 'false', ...(cursor ? { cursor } : {}) },
    ...auth(viewer),
  });
}

export interface ThreadData {
  conversation: Conversation;
  history: ChatHistory;
  quickReplies: QuickReplyList['items'];
}

/** A conversation, its latest messages and (for a store's staff) the canned replies; 404 if not theirs. */
export async function chatThread(viewer: Viewer, id: string): Promise<ThreadData> {
  try {
    const [conversation, history] = await Promise.all([
      apiFetch({ path: `/conversations/${id}`, schema: conversationSchema, ...auth(viewer) }),
      apiFetch({
        path: `/conversations/${id}/messages`,
        schema: chatHistorySchema,
        ...auth(viewer),
      }),
    ]);
    const sellerSide = conversation.me.role !== 'buyer' && conversation.store !== null;
    const quickReplies = sellerSide
      ? await apiFetch({
          path: `/conversations/${id}/quick-replies`,
          schema: quickReplyListSchema,
          ...auth(viewer),
        })
          .then((list) => list.items)
          .catch(() => [])
      : [];
    return { conversation, history, quickReplies };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) notFound();
    throw error;
  }
}

/** "মেসেজ দিন" on a listing: open (or reopen — one per buyer and post) the conversation. */
export async function openForPost(viewer: Viewer, postId: string): Promise<Conversation> {
  const opened = await apiFetch({
    path: `/posts/${postId}/conversations`,
    method: 'POST',
    schema: openConversationSchema,
    body: { source: 'post_detail' },
    ...auth(viewer),
  });
  return opened.conversation;
}
