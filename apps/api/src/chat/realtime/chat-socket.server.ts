import {
  Inject,
  Injectable,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { Server as HttpServer } from 'node:http';
import { PinoLogger } from 'nestjs-pino';
import { Server, type DefaultEventsMap, type Namespace, type Socket } from 'socket.io';
import { z, type ZodTypeAny } from 'zod';
import { UnauthenticatedException } from '../../auth/exceptions/auth.exceptions';
import { TokenService, type AccessTokenClaims } from '../../auth/tokens/token.service';
import { DomainException } from '../../common/exceptions/domain-exception';
import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { TenantContext } from '../../database/tenant-context';
import { TenantLookupService } from '../../database/tenant-lookup.service';
import {
  TenantSuspendedException,
  TenantTerminatedException,
} from '../../database/tenant.exceptions';
import { SettingsService } from '../../settings/settings.service';
import { ChatConversationsService } from '../chat-conversations.service';
import { ChatMessagesService } from '../chat-messages.service';
import { ChatScope } from '../chat-scope';
import { ChatEventInvalidException } from '../chat.exceptions';
import { CHAT_STORE, type ChatStore } from '../chat.store';
import { clientMessageIdSchema, messageContentSchema } from '../dto/chat.dto';
import { ChatBroadcaster, conversationRoom, SERVER_EVENTS, userRoom } from './chat-broadcaster';

/** Under the API prefix, so the same reverse-proxy rule covers it (Coolify/Traefik). */
export const CHAT_SOCKET_PATH = '/api/v1/chat/socket.io';
export const CHAT_NAMESPACE = '/chat';

// settings-exempt: unit conversion
const MS_PER_SECOND = 1000;

/** Client → server events (ADR 058); every one may carry an ack callback. */
export const CLIENT_EVENTS = {
  send: 'message:send',
  delivered: 'message:delivered',
  read: 'message:read',
  typing: 'typing',
  join: 'conversation:join',
  heartbeat: 'conversation:heartbeat',
  leave: 'conversation:leave',
  refresh: 'auth:refresh',
} as const;

const conversationId = z.string().uuid();
const eventSchemas = {
  send: z
    .object({
      conversationId,
      clientMessageId: clientMessageIdSchema,
      content: messageContentSchema,
    })
    .strict(),
  receipt: z.object({ conversationId, upToMessageId: z.string().uuid() }).strict(),
  typing: z.object({ conversationId, isTyping: z.boolean() }).strict(),
  conversation: z.object({ conversationId }).strict(),
  refresh: z.object({ token: z.string().min(1) }).strict(),
};

interface ChatSocketData {
  claims: AccessTokenClaims;
  /** Unix seconds; the socket closes chat_token_grace_seconds after it unless auth:refresh comes. */
  expiresAt: number | undefined;
  expiryTimer: NodeJS.Timeout | undefined;
  /** Conversations this socket joined → the caller's member id there (for typing). */
  joined: Map<string, string>;
}
type ChatSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, ChatSocketData>;

/** What an ack carries: the result, or a typed error — never a stack or SQL (CLAUDE.md rule 4). */
export type Ack =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

/**
 * The chat socket (ADR 058). A Socket.IO server on the API's own HTTP
 * server, WebSocket transport only (no long-polling: no sticky sessions, any
 * instance can take any socket), shared across instances by the Redis
 * adapter — an emit to a room reaches that room's sockets on every instance.
 *
 *  - Auth on connect: the access token (handshake `auth.token`), verified as
 *    JwtAuthGuard does; its tenant passes the tenant gate. The socket joins
 *    its user's room. It closes chat_token_grace_seconds after the token
 *    expires unless the client sends auth:refresh with the new one (same user).
 *  - Every event runs inside a fresh TenantContext built from the socket's
 *    claims — exactly what an HTTP request gets — and every conversation
 *    event goes through ChatScope (the conversation's tenant, RLS), the same
 *    services as REST. Nothing is trusted from the payload but ids.
 *  - Typing is ephemeral: relayed to the conversation's room, never stored.
 */
@Injectable()
export class ChatSocketServer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private io: Server | undefined;
  private namespace: Namespace | undefined;
  private redis: Redis[] = [];

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(APP_CONFIG) private readonly env: Pick<Env, 'REDIS_URL'>,
    private readonly tokens: TokenService,
    private readonly context: TenantContext,
    private readonly tenants: TenantLookupService,
    private readonly settings: SettingsService,
    private readonly scope: ChatScope,
    private readonly conversations: ChatConversationsService,
    private readonly messages: ChatMessagesService,
    private readonly broadcaster: ChatBroadcaster,
    @Inject(CHAT_STORE) private readonly store: ChatStore,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ChatSocketServer.name);
  }

  onApplicationBootstrap(): void {
    const httpServer = this.adapterHost.httpAdapter?.getHttpServer() as HttpServer | undefined;
    if (!httpServer) return; // the worker: no HTTP server, no sockets
    const pub = new Redis(this.env.REDIS_URL);
    const sub = pub.duplicate();
    this.redis = [pub, sub];
    this.io = new Server(httpServer, {
      path: CHAT_SOCKET_PATH,
      transports: ['websocket'],
      serveClient: false,
      adapter: createAdapter(pub, sub),
    });
    const namespace = this.io.of(CHAT_NAMESPACE);
    namespace.use((socket, next) => {
      this.authenticate(socket as ChatSocket).then(
        () => next(),
        (error: unknown) => next(connectError(error)),
      );
    });
    namespace.on('connection', (socket) => this.onConnection(socket as ChatSocket));
    this.namespace = namespace;
    this.broadcaster.attach(namespace);
  }

  /** Before the HTTP server closes: open WebSockets would keep it from closing. */
  async beforeApplicationShutdown(): Promise<void> {
    this.broadcaster.attach(undefined);
    if (this.namespace) {
      for (const socket of this.namespace.sockets.values()) {
        clearTimeout((socket as ChatSocket).data.expiryTimer);
      }
      this.namespace.local.disconnectSockets(true);
    }
    this.io?.engine.close();
    await Promise.all(this.redis.map((client) => client.quit().catch(() => undefined)));
    this.redis = [];
    this.io = undefined;
    this.namespace = undefined;
  }

  private async authenticate(socket: ChatSocket): Promise<void> {
    const token = tokenOf(socket);
    if (!token) throw new UnauthenticatedException();
    const claims = await this.verify(token);
    socket.data.claims = claims;
    socket.data.expiresAt = expiryOf(token);
    socket.data.joined = new Map();
  }

  private async verify(token: string): Promise<AccessTokenClaims> {
    const claims = await this.tokens.verifyAccessToken(token).catch(() => {
      throw new UnauthenticatedException();
    });
    const tenant = await this.tenants.resolveById(claims.tenantId);
    if (!tenant) throw new UnauthenticatedException();
    if (tenant.statusCode === 'suspended') throw new TenantSuspendedException();
    if (tenant.statusCode === 'terminated') throw new TenantTerminatedException();
    return claims;
  }

  private onConnection(socket: ChatSocket): void {
    void socket.join(userRoom(socket.data.claims.userId));
    void this.scheduleExpiry(socket);

    this.on(socket, CLIENT_EVENTS.send, eventSchemas.send, (e) =>
      this.messages.send(e.conversationId, {
        clientMessageId: e.clientMessageId,
        content: e.content,
      }),
    );
    this.on(socket, CLIENT_EVENTS.delivered, eventSchemas.receipt, (e) =>
      this.conversations.receipt(e.conversationId, e.upToMessageId, 'delivered'),
    );
    this.on(socket, CLIENT_EVENTS.read, eventSchemas.receipt, (e) =>
      this.conversations.receipt(e.conversationId, e.upToMessageId, 'read'),
    );
    this.on(socket, CLIENT_EVENTS.join, eventSchemas.conversation, (e) =>
      this.join(socket, e.conversationId),
    );
    this.on(socket, CLIENT_EVENTS.heartbeat, eventSchemas.conversation, (e) =>
      this.heartbeat(socket, e.conversationId),
    );
    this.on(socket, CLIENT_EVENTS.leave, eventSchemas.conversation, (e) =>
      this.leave(socket, e.conversationId),
    );
    this.on(socket, CLIENT_EVENTS.typing, eventSchemas.typing, (e) =>
      this.typing(socket, e.conversationId, e.isTyping),
    );
    this.on(socket, CLIENT_EVENTS.refresh, eventSchemas.refresh, (e) =>
      this.refresh(socket, e.token),
    );

    socket.on('disconnect', () => {
      clearTimeout(socket.data.expiryTimer);
      for (const id of socket.data.joined.keys()) {
        void this.store.stopViewing(id, socket.data.claims.userId).catch(() => undefined);
      }
    });
  }

  /**
   * One handler: validate, run in the socket's tenant context, ack the
   * result or a typed error. A malformed payload is refused, not ignored.
   */
  private on<S extends ZodTypeAny>(
    socket: ChatSocket,
    event: string,
    schema: S,
    handler: (input: z.infer<S>) => Promise<unknown>,
  ): void {
    socket.on(event, (raw: unknown, ack?: unknown) => {
      const reply = typeof ack === 'function' ? (ack as (answer: Ack) => void) : undefined;
      const { claims } = socket.data;
      void this.context.run(
        {
          tenantId: claims.tenantId,
          userId: claims.userId,
          memberId: claims.memberId,
          role: claims.role,
        },
        async () => {
          try {
            const parsed = schema.safeParse(raw);
            if (!parsed.success) {
              throw new ChatEventInvalidException(
                parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
              );
            }
            reply?.({ ok: true, data: (await handler(parsed.data as z.infer<S>)) ?? null });
          } catch (error) {
            if (!(error instanceof DomainException)) {
              this.logger.error({ err: error, event }, 'chat socket event failed');
            }
            reply?.({ ok: false, error: wireError(error) });
          }
        },
      );
    });
  }

  /**
   * Opens a conversation on this socket: the caller must be its participant
   * (ChatScope, else "not found" — a member of another tenant included).
   * Joins its typing room unless a block stands, and marks the caller as
   * viewing it (no notifications) until the presence TTL runs out — the
   * client sends conversation:heartbeat to stay.
   */
  private async join(socket: ChatSocket, id: string): Promise<unknown> {
    return this.scope.inConversation(id, async ({ tenantId, memberId, userId }) => {
      const conversation = await this.conversations.viewOf(id, tenantId);
      const ttl = await this.settings.get('chat_presence_ttl_seconds');
      if (!conversation.isBlocked) await socket.join(conversationRoom(id));
      socket.data.joined.set(id, memberId);
      await this.store.markViewing(id, userId, ttl);
      return { conversation, presenceTtlSeconds: ttl };
    });
  }

  private async heartbeat(socket: ChatSocket, id: string): Promise<unknown> {
    if (!socket.data.joined.has(id))
      throw new ChatEventInvalidException([{ path: 'conversationId', message: 'join first' }]);
    const ttl = await this.settings.get('chat_presence_ttl_seconds');
    await this.store.markViewing(id, socket.data.claims.userId, ttl);
    return { presenceTtlSeconds: ttl };
  }

  private async leave(socket: ChatSocket, id: string): Promise<unknown> {
    await socket.leave(conversationRoom(id));
    socket.data.joined.delete(id);
    await this.store.stopViewing(id, socket.data.claims.userId);
    return null;
  }

  /**
   * Relayed to the others in the conversation's room, never stored. Only a
   * socket still in the room may type: joining checked the participant and
   * the block, and a block takes everyone out of the room on every instance.
   */
  private async typing(socket: ChatSocket, id: string, isTyping: boolean): Promise<unknown> {
    const memberId = socket.data.joined.get(id);
    if (!memberId || !socket.rooms.has(conversationRoom(id))) return { relayed: false };
    const ttl = await this.settings.get('chat_typing_ttl_seconds');
    socket.to(conversationRoom(id)).emit(SERVER_EVENTS.typing, {
      conversationId: id,
      memberId,
      isTyping,
      expiresInSeconds: ttl,
    });
    return { relayed: true };
  }

  /**
   * A refreshed access token: same user only — another user's token is
   * answered UNAUTHENTICATED and the socket closes right after the ack;
   * the expiry moves.
   */
  private async refresh(socket: ChatSocket, token: string): Promise<unknown> {
    const claims = await this.verify(token);
    if (claims.userId !== socket.data.claims.userId) {
      setImmediate(() => socket.disconnect(true));
      throw new UnauthenticatedException();
    }
    socket.data.claims = claims;
    socket.data.expiresAt = expiryOf(token);
    await this.scheduleExpiry(socket);
    return { expiresAt: socket.data.expiresAt ?? null };
  }

  private async scheduleExpiry(socket: ChatSocket): Promise<void> {
    clearTimeout(socket.data.expiryTimer);
    const expiresAt = socket.data.expiresAt;
    if (expiresAt === undefined) return;
    const grace = await this.settings.get('chat_token_grace_seconds');
    const delay = Math.max(0, (expiresAt + grace) * MS_PER_SECOND - Date.now());
    socket.data.expiryTimer = setTimeout(() => {
      socket.emit(SERVER_EVENTS.authExpired);
      socket.disconnect(true);
    }, delay);
    socket.data.expiryTimer.unref();
  }
}

function tokenOf(socket: ChatSocket): string | undefined {
  const auth = socket.handshake.auth as { token?: unknown } | undefined;
  if (typeof auth?.token === 'string' && auth.token.length > 0) return auth.token;
  const header = socket.handshake.headers.authorization;
  return header?.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim() || undefined
    : undefined;
}

/** The `exp` of an already-verified JWT (TokenService checks it; it doesn't return it). */
function expiryOf(token: string): number | undefined {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as {
      exp?: unknown;
    };
    return typeof payload.exp === 'number' ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

function wireError(error: unknown): { code: string; message: string; details?: unknown } {
  if (error instanceof DomainException) {
    const details = 'issues' in error ? (error as { issues: unknown }).issues : undefined;
    return {
      code: error.code,
      message: error.message,
      ...(details === undefined ? {} : { details }),
    };
  }
  return { code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred.' };
}

/** A refused connection: the client's connect_error carries the typed code in `data`. */
function connectError(error: unknown): Error {
  const wire = wireError(error);
  return Object.assign(new Error(wire.message), { data: { code: wire.code } });
}
