'use client';

import { io, type Socket } from 'socket.io-client';
import { chatMessageSchema, type ChatMessage } from '../api/schemas';

/**
 * The chat socket in the browser (ADR 058/060): one per tab, shared by the
 * thread and the header's badge. It only listens (and sends typing and
 * presence); messages go out through the server actions. Its token comes
 * from /api/chat-token at every (re)connect — the session itself stays in
 * httpOnly cookies — and the API's origin comes with it, so the build doesn't
 * need to know it.
 */

export interface ChatSocketEvents {
  message: (tenantId: string, message: ChatMessage) => void;
  receipt: (r: {
    conversationId: string;
    memberId: string;
    deliveredUpTo: string | null;
    readUpTo: string | null;
  }) => void;
  typing: (t: {
    conversationId: string;
    memberId: string;
    isTyping: boolean;
    expiresInSeconds: number;
  }) => void;
  updated: (conversationId: string) => void;
  connected: (up: boolean) => void;
}

type Listener<K extends keyof ChatSocketEvents> = ChatSocketEvents[K];

const CHAT_SOCKET_PATH = '/api/v1/chat/socket.io';
const NAMESPACE = '/chat';
// Transport tuning, not business rules: how soon to reconnect, at most.
const RECONNECT_DELAY_MS = 1_000;
const RECONNECT_DELAY_MAX_MS = 30_000;
const ACK_TIMEOUT_MS = 10_000;

interface TokenAnswer {
  token: string;
  socketUrl: string;
}

async function fetchToken(): Promise<TokenAnswer | null> {
  try {
    const response = await fetch('/api/chat-token', {
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<TokenAnswer>;
    return typeof body.token === 'string' && typeof body.socketUrl === 'string'
      ? { token: body.token, socketUrl: body.socketUrl }
      : null;
  } catch {
    return null;
  }
}

class ChatSocketClient {
  private socket: Socket | null = null;
  private starting: Promise<void> | null = null;
  private readonly listeners: { [K in keyof ChatSocketEvents]: Set<Listener<K>> } = {
    message: new Set(),
    receipt: new Set(),
    typing: new Set(),
    updated: new Set(),
    connected: new Set(),
  };

  get isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  on<K extends keyof ChatSocketEvents>(event: K, listener: Listener<K>): () => void {
    void this.start();
    (this.listeners[event] as Set<Listener<K>>).add(listener);
    return () => {
      (this.listeners[event] as Set<Listener<K>>).delete(listener);
    };
  }

  private emitLocal<K extends keyof ChatSocketEvents>(
    event: K,
    ...args: Parameters<ChatSocketEvents[K]>
  ) {
    for (const listener of this.listeners[event] as Set<
      (...a: Parameters<ChatSocketEvents[K]>) => void
    >) {
      listener(...args);
    }
  }

  start(): Promise<void> {
    this.starting ??= this.connect();
    return this.starting;
  }

  private async connect(): Promise<void> {
    const first = await fetchToken();
    if (!first) {
      // Signed out (or the site couldn't answer): try again on the next start.
      this.starting = null;
      return;
    }
    const socket = io(`${first.socketUrl}${NAMESPACE}`, {
      path: CHAT_SOCKET_PATH,
      transports: ['websocket'],
      reconnectionDelay: RECONNECT_DELAY_MS,
      reconnectionDelayMax: RECONNECT_DELAY_MAX_MS,
      // Asked at every (re)connect: an expired token is rotated on the way (middleware).
      auth: (cb) => {
        void fetchToken().then((answer) => cb({ token: answer?.token ?? '' }));
      },
    });
    socket.on('connect', () => this.emitLocal('connected', true));
    socket.on('disconnect', () => this.emitLocal('connected', false));
    socket.on('message:new', (data: unknown) => {
      const record = data as { tenantId?: unknown; message?: unknown } | null;
      const parsed = chatMessageSchema.safeParse(record?.message);
      if (parsed.success && typeof record?.tenantId === 'string') {
        this.emitLocal('message', record.tenantId, parsed.data);
      }
    });
    socket.on('receipt', (data: Parameters<ChatSocketEvents['receipt']>[0]) =>
      this.emitLocal('receipt', data),
    );
    socket.on('typing', (data: Parameters<ChatSocketEvents['typing']>[0]) =>
      this.emitLocal('typing', data),
    );
    socket.on('conversation:updated', (data: { conversationId?: unknown } | null) => {
      if (typeof data?.conversationId === 'string') this.emitLocal('updated', data.conversationId);
    });
    // The token ran out with the socket open: reconnect, which fetches a fresh one.
    socket.on('auth:expired', () => {
      socket.disconnect();
      socket.connect();
    });
    this.socket = socket;
  }

  /** Opening a thread: typing reaches it and its pushes stay quiet. Returns how often to heartbeat. */
  async join(conversationId: string): Promise<number | null> {
    const socket = this.socket;
    if (!socket?.connected) return null;
    try {
      const answer = (await socket
        .timeout(ACK_TIMEOUT_MS)
        .emitWithAck('conversation:join', { conversationId })) as {
        ok?: boolean;
        data?: { presenceTtlSeconds?: number };
      };
      const ttl = answer?.data?.presenceTtlSeconds;
      // Refresh presence at half its lifetime.
      return typeof ttl === 'number' ? (ttl * 1000) / 2 : null;
    } catch {
      return null;
    }
  }

  heartbeat(conversationId: string): void {
    this.socket?.emit('conversation:heartbeat', { conversationId });
  }

  leave(conversationId: string): void {
    this.socket?.emit('conversation:leave', { conversationId });
  }

  typing(conversationId: string, isTyping: boolean): void {
    this.socket?.emit('typing', { conversationId, isTyping });
  }
}

let client: ChatSocketClient | null = null;

/** The tab's chat socket (connects on first use). */
export function chatSocket(): ChatSocketClient {
  client ??= new ChatSocketClient();
  return client;
}

export type { ChatSocketClient };
