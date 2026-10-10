import type { ChatMessage, Conversation } from '../api/schemas';

/**
 * A thread's state as the browser keeps it (ADR 060) — the same rules as the
 * app's ConversationController, kept pure here so they are tested on their own.
 */

export type MessageContent =
  | { kind: 'text'; body: string }
  | { kind: 'image'; mediaId: string }
  | { kind: 'location'; lat: number; lng: number }
  | { kind: 'listing_card'; postId: string };

/** Mine, not on the server yet: sending, or refused with the API's code. */
export interface PendingMessage {
  clientMessageId: string;
  content: MessageContent;
  /** A photo being uploaded: its local preview. */
  previewUrl?: string;
  /** The photo itself, kept for a retry of its upload. */
  file?: File;
  state: 'sending' | 'failed';
  errorCode?: string;
  createdAt: string;
}

export type DeliveryState = 'sending' | 'failed' | 'sent' | 'delivered' | 'read';

/**
 * Sent / delivered / read from the other side's watermarks: message ids are
 * uuid v7, so their text order is their time order (ADR 058).
 */
export function deliveryState(
  messageId: string,
  conversation: Pick<Conversation, 'othersDeliveredUpTo' | 'othersReadUpTo'>,
): DeliveryState {
  const reached = (upTo: string | null) => upTo !== null && messageId <= upTo;
  if (reached(conversation.othersReadUpTo)) return 'read';
  if (reached(conversation.othersDeliveredUpTo)) return 'delivered';
  return 'sent';
}

/**
 * Messages from any source (history, a send's answer, the socket, a catch-up
 * after a reconnect) into one list: each id once, oldest first.
 */
export function mergeMessages(
  current: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
): ChatMessage[] {
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The server has these now: their pending copies go. */
export function settlePending(
  pending: readonly PendingMessage[],
  arrived: readonly ChatMessage[],
): PendingMessage[] {
  const done = new Set(arrived.map((m) => m.clientMessageId));
  return pending.filter((p) => !done.has(p.clientMessageId));
}

/** A watermark only moves forward. */
export function laterOf(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

/** The newest message from the other side, the one to mark read up to. */
export function newestFromOthers(
  messages: readonly ChatMessage[],
  myMemberId: string,
): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.senderMemberId !== null && m.senderMemberId !== myMemberId) return m;
  }
  return null;
}

/** Refusals worth explaining (the rest are "couldn't send"). */
const EXPLAINED = new Set([
  'CHAT_CONTACT_INFO_BLOCKED',
  'CHAT_BLOCKED',
  'CHAT_LOCKED',
  'CHAT_RATE_LIMITED',
  'CHAT_MESSAGE_TOO_LONG',
  'CHAT_IMAGE_INVALID',
]);

/**
 * Network trouble (or the API momentarily down) leaves a message to retry;
 * anything else the server said no to is final until the user acts.
 */
export function isTransient(code: string): boolean {
  return code === 'NETWORK' || code === 'API_UNREACHABLE' || code === 'UNEXPECTED_RESPONSE';
}

/** The message key under `chat.errors` for a refusal. */
export function errorKey(code: string | undefined): string {
  return code && EXPLAINED.has(code) ? code : 'generic';
}

/** A random client message id: URL-safe, 22 characters (the API takes 8–64). */
export function newClientMessageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** Who the other side is, as the thread and the inbox name them. */
export function counterpartName(
  c: Conversation,
  fallback: { buyer: string; seller: string },
): string {
  if (c.counterpart.kind === 'store' && c.store) return c.store.name.bn;
  return c.counterpart.name ?? (c.counterpart.kind === 'buyer' ? fallback.buyer : fallback.seller);
}
