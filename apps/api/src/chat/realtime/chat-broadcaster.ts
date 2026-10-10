import { Injectable } from '@nestjs/common';
import type { Namespace } from 'socket.io';

/** Server → client events (ADR 058). */
export const SERVER_EVENTS = {
  messageNew: 'message:new',
  receipt: 'receipt',
  typing: 'typing',
  conversationUpdated: 'conversation:updated',
  authExpired: 'auth:expired',
} as const;

/**
 * Every socket joins its user's room on connect; messages, receipts and
 * inbox updates go to the participants' user rooms, so they reach every
 * device of every participant on whichever instance it is connected to (the
 * Redis adapter relays the emit), whether or not the thread is open.
 */
export const userRoom = (userId: string): string => `user:${userId}`;

/** Joined on conversation:join (authorised); carries only the typing indicator. */
export const conversationRoom = (conversationId: string): string => `conv:${conversationId}`;

/**
 * Sends chat events to sockets. The socket server attaches its namespace at
 * startup (ChatSocketServer); before that, and in processes without one (the
 * worker, unit tests), sending is a no-op — clients catch up through REST.
 */
@Injectable()
export class ChatBroadcaster {
  private namespace: Namespace | undefined;

  attach(namespace: Namespace | undefined): void {
    this.namespace = namespace;
  }

  toUsers(userIds: readonly string[], event: string, payload: unknown): void {
    if (!this.namespace || userIds.length === 0) return;
    this.namespace.to([...new Set(userIds)].map(userRoom)).emit(event, payload);
  }

  /**
   * Takes these users' sockets, on every instance, out of the conversation's
   * room (after a block: typing must stop reaching the other side).
   */
  leaveConversation(userIds: readonly string[], conversationId: string): void {
    if (!this.namespace || userIds.length === 0) return;
    this.namespace
      .in([...new Set(userIds)].map(userRoom))
      .socketsLeave(conversationRoom(conversationId));
  }
}
