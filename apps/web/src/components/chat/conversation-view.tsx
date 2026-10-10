'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ImagePlus, MapPin, MoreVertical, Send } from 'lucide-react';
import { formatMoney } from '@amar-elaka/dynamic-form';
import { Button } from '@/components/ui/button';
import { WebPushCard } from '@/components/notifications/web-push-card';
import type { ChatMessage, Conversation, QuickReplyList } from '@/lib/api/schemas';
import {
  loadMessages,
  markRead,
  reloadConversation,
  reportConversation,
  sendMessage,
  setBlocked,
} from '@/lib/chat/actions';
import { chatSocket } from '@/lib/chat/socket';
import {
  counterpartName,
  deliveryState,
  isTransient,
  laterOf,
  mergeMessages,
  newClientMessageId,
  newestFromOthers,
  settlePending,
  type MessageContent,
  type PendingMessage,
} from '@/lib/chat/thread';
import { compressImage, isAcceptedImage } from '@/lib/media/compress-image';
import { sha256Hex } from '@/lib/media/upload-queue';
import { MessageBubble, PendingBubble } from './message-bubble';

// Transport and typing-signal tuning (not business rules — the API owns
// rate limits and the soft-block): how often we say "typing", when we stop,
// and how long a retry waits at most.
const TYPING_RESEND_MS = 3_000;
const TYPING_IDLE_MS = 4_000;
const RETRY_MAX_MS = 60_000;

/** The browser's online state, as an external store. */
function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** Wall-clock time, for throttling the typing signal (called from handlers only). */
function clock(): number {
  return Date.now();
}

type ReportReason = 'scam' | 'harassment' | 'spam' | 'prohibited_item' | 'other';
const REPORT_REASONS: ReportReason[] = ['scam', 'harassment', 'spam', 'prohibited_item', 'other'];

/**
 * One conversation on the web (ADR 060), the app's thread in a browser: the
 * post card on top, the thread (older on demand), the other side typing,
 * ticks from their receipts, and the composer — text, quick replies for a
 * store's staff, photo (through the media pipeline), location. Live over
 * the chat socket; every send goes through the server (a server action),
 * so the socket being down never loses a message: it stays "sending" and
 * is retried with backoff, and when the browser comes back online.
 */
export function ConversationView({
  initialConversation,
  initialMessages,
  initialHasOlder,
  quickReplies,
  offerPush,
}: {
  initialConversation: Conversation;
  /** Oldest first. */
  initialMessages: ChatMessage[];
  initialHasOlder: boolean;
  quickReplies: QuickReplyList['items'];
  offerPush: boolean;
}) {
  const t = useTranslations('chat');
  const [conversation, setConversation] = useState(initialConversation);
  const [messages, setMessages] = useState(initialMessages);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(initialHasOlder);
  const [typing, setTyping] = useState<{ expiresInMs: number } | null>(null);
  const [text, setText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [sentOnce, setSentOnce] = useState(false);
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
  const id = conversation.id;
  const me = conversation.me.memberId;

  // The latest list for callbacks that outlive a render (socket, timers).
  const messagesRef = useRef(messages);
  const pendingRef = useRef(pending);
  useEffect(() => {
    messagesRef.current = messages;
    pendingRef.current = pending;
  }, [messages, pending]);
  const lastReadRef = useRef<string | null>(conversation.myReadUpTo);
  const typingSentAt = useRef(0);
  const typingIdle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retries = useRef(
    new Map<string, { attempts: number; timer: ReturnType<typeof setTimeout> }>(),
  );
  const endRef = useRef<HTMLDivElement | null>(null);
  const reportRef = useRef<HTMLDialogElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // ---- reading ---------------------------------------------------------------

  const readUpToNewest = useCallback(() => {
    if (document.visibilityState !== 'visible') return;
    const newest = newestFromOthers(messagesRef.current, me);
    if (!newest || (lastReadRef.current !== null && newest.id <= lastReadRef.current)) return;
    lastReadRef.current = newest.id;
    void markRead(id, newest.id);
  }, [id, me]);

  const accept = useCallback((incoming: ChatMessage[]) => {
    setMessages((current) => mergeMessages(current, incoming));
    setPending((current) => settlePending(current, incoming));
  }, []);

  const catchUp = useCallback(async () => {
    const newest = messagesRef.current.at(-1);
    const [after, fresh] = await Promise.all([
      newest ? loadMessages(id, { after: newest.id }) : Promise.resolve(null),
      reloadConversation(id),
    ]);
    if (after?.ok) accept(after.data.items);
    if (fresh.ok) setConversation(fresh.data);
  }, [accept, id]);

  // ---- live ------------------------------------------------------------------

  useEffect(() => {
    const socket = chatSocket();
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const join = async () => {
      const every = await socket.join(id);
      if (heartbeat) clearInterval(heartbeat);
      if (every) heartbeat = setInterval(() => socket.heartbeat(id), every);
    };
    const offs = [
      socket.on('message', (_tenant, m) => {
        if (m.conversationId !== id) return;
        accept([m]);
        if (m.senderMemberId !== me) setTyping(null);
      }),
      socket.on('receipt', (r) => {
        if (r.conversationId !== id || r.memberId === me) return;
        setConversation((c) => ({
          ...c,
          othersDeliveredUpTo: laterOf(c.othersDeliveredUpTo, r.deliveredUpTo),
          othersReadUpTo: laterOf(c.othersReadUpTo, r.readUpTo),
        }));
      }),
      socket.on('typing', (signal) => {
        if (signal.conversationId !== id || signal.memberId === me) return;
        setTyping(signal.isTyping ? { expiresInMs: signal.expiresInSeconds * 1000 } : null);
      }),
      socket.on('updated', (changed) => {
        if (changed !== id) return;
        void reloadConversation(id).then((fresh) => fresh.ok && setConversation(fresh.data));
      }),
      // Every (re)connect: join, and fetch what was missed while away.
      socket.on('connected', (up) => {
        if (!up) return;
        void join();
        void catchUp();
      }),
    ];
    if (socket.isConnected) void join();
    return () => {
      for (const off of offs) off();
      if (heartbeat) clearInterval(heartbeat);
      socket.leave(id);
    };
  }, [accept, catchUp, id, me]);

  // Typing expires on its own (a lost "stopped typing").
  useEffect(() => {
    if (!typing) return;
    const timer = setTimeout(() => setTyping(null), typing.expiresInMs);
    return () => clearTimeout(timer);
  }, [typing]);

  useEffect(() => {
    readUpToNewest();
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, readUpToNewest]);

  useEffect(() => {
    const onVisible = () => readUpToNewest();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [readUpToNewest]);

  // ---- sending ---------------------------------------------------------------

  const deliver = useCallback(
    async (sent: PendingMessage) => {
      // A retry after the photo went up: send what we have, don't upload it again.
      const p = pendingRef.current.find((x) => x.clientMessageId === sent.clientMessageId) ?? sent;
      let content: MessageContent = p.content;
      if (content.kind === 'image' && !content.mediaId && p.file) {
        const uploaded = await uploadPhoto(id, p.file);
        if (!uploaded.ok) return uploaded.code;
        content = { kind: 'image', mediaId: uploaded.mediaId };
        setPending((current) =>
          current.map((x) => (x.clientMessageId === p.clientMessageId ? { ...x, content } : x)),
        );
      }
      const result = await sendMessage(id, p.clientMessageId, content);
      if (result.ok) {
        accept([result.data.message]);
        setSentOnce(true);
        return null;
      }
      return result.code;
    },
    [accept, id],
  );

  // Through a ref: a retry's timer calls the latest one.
  const attemptRef = useRef<(p: PendingMessage) => Promise<void>>(async () => {});
  const attempt = useCallback(
    async (p: PendingMessage) => {
      const code = await deliver(p);
      const entry = retries.current.get(p.clientMessageId);
      if (code === null) {
        if (entry) clearTimeout(entry.timer);
        retries.current.delete(p.clientMessageId);
        return;
      }
      if (isTransient(code)) {
        // Still "sending": back off (2, 4, 8 … s, at most a minute) and go again.
        const attempts = (entry?.attempts ?? 0) + 1;
        const wait = Math.min(2 ** attempts * 1000, RETRY_MAX_MS);
        const timer = setTimeout(() => void attemptRef.current(p), wait);
        retries.current.set(p.clientMessageId, { attempts, timer });
        return;
      }
      retries.current.delete(p.clientMessageId);
      setPending((current) =>
        current.map((x) =>
          x.clientMessageId === p.clientMessageId ? { ...x, state: 'failed', errorCode: code } : x,
        ),
      );
      if (code === 'CHAT_BLOCKED' || code === 'CHAT_LOCKED') {
        void reloadConversation(id).then((fresh) => fresh.ok && setConversation(fresh.data));
      }
    },
    [deliver, id],
  );
  useEffect(() => {
    attemptRef.current = attempt;
  }, [attempt]);

  // Back online: everything waiting goes now.
  useEffect(() => {
    const up = () => {
      for (const [clientId, entry] of retries.current) {
        clearTimeout(entry.timer);
        const p = pendingRef.current.find((x) => x.clientMessageId === clientId);
        if (p) void attempt(p);
      }
    };
    window.addEventListener('online', up);
    return () => window.removeEventListener('online', up);
  }, [attempt]);

  useEffect(
    () => () => {
      for (const entry of retries.current.values()) clearTimeout(entry.timer);
    },
    [],
  );

  function queue(content: MessageContent, extra?: Partial<PendingMessage>) {
    const p: PendingMessage = {
      clientMessageId: newClientMessageId(),
      content,
      state: 'sending',
      createdAt: new Date().toISOString(),
      ...extra,
    };
    setPending((current) => [...current, p]);
    void attempt(p);
  }

  function stopTyping() {
    if (typingIdle.current) clearTimeout(typingIdle.current);
    typingIdle.current = null;
    if (typingSentAt.current) chatSocket().typing(id, false);
    typingSentAt.current = 0;
  }

  function onType(value: string) {
    setText(value);
    const now = clock();
    if (value.trim() && now - typingSentAt.current >= TYPING_RESEND_MS) {
      chatSocket().typing(id, true);
      typingSentAt.current = now;
    }
    if (typingIdle.current) clearTimeout(typingIdle.current);
    typingIdle.current = setTimeout(stopTyping, TYPING_IDLE_MS);
  }

  function submitText() {
    const body = text.trim();
    if (!body) return;
    setText('');
    stopTyping();
    queue({ kind: 'text', body });
  }

  function pickPhoto(file: File | undefined) {
    if (!file) return;
    if (!isAcceptedImage(file)) {
      setNotice(t('errors.CHAT_IMAGE_INVALID'));
      return;
    }
    queue({ kind: 'image', mediaId: '' }, { file, previewUrl: URL.createObjectURL(file) });
  }

  function shareLocation() {
    if (!('geolocation' in navigator)) {
      setNotice(t('locationFailed'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        queue({ kind: 'location', lat: position.coords.latitude, lng: position.coords.longitude }),
      () => setNotice(t('locationFailed')),
    );
  }

  function retry(p: PendingMessage) {
    const again = { ...p, state: 'sending' as const };
    delete again.errorCode;
    setPending((current) =>
      current.map((x) => (x.clientMessageId === p.clientMessageId ? again : x)),
    );
    void attempt(again);
  }

  function discard(p: PendingMessage) {
    const entry = retries.current.get(p.clientMessageId);
    if (entry) clearTimeout(entry.timer);
    retries.current.delete(p.clientMessageId);
    if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    setPending((current) => current.filter((x) => x.clientMessageId !== p.clientMessageId));
  }

  async function older() {
    const oldest = messages[0];
    if (!oldest) return;
    const page = await loadMessages(id, { before: oldest.id });
    if (!page.ok) {
      setNotice(t('actionFailed'));
      return;
    }
    accept(page.data.items);
    setHasOlder(page.data.hasMore);
  }

  async function toggleBlock() {
    if (!conversation.blockedByMe && !window.confirm(t('blockConfirm'))) return;
    const result = await setBlocked(id, !conversation.blockedByMe);
    if (result.ok) setConversation(result.data);
    else setNotice(t('actionFailed'));
  }

  async function sendReport(form: HTMLFormElement) {
    const data = new FormData(form);
    const details = data.get('text');
    const result = await reportConversation(id, {
      reasonCode: data.get('reasonCode'),
      text: typeof details === 'string' && details.trim() ? details.trim() : undefined,
    });
    reportRef.current?.close();
    setNotice(result.ok ? t('reportSent') : t('actionFailed'));
  }

  // ---- view ------------------------------------------------------------------

  const name = counterpartName(conversation, { buyer: t('buyer'), seller: t('seller') });
  const sellerSide = conversation.me.role !== 'buyer';
  const disabledReason = conversation.isLocked
    ? t('lockedNotice')
    : conversation.blockedByMe
      ? t('youBlocked')
      : t('blockedNotice');

  return (
    <section className="mx-auto flex h-[calc(100dvh-12rem)] min-h-[28rem] max-w-2xl flex-col rounded-lg border border-border bg-card">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Link href={'/inbox'} className="text-sm text-muted-foreground hover:underline">
          {t('backToInbox')}
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-semibold">{name}</h1>
          {typing && (
            <p className="text-xs text-brand" data-testid="chat-typing">
              {t('typing')}
            </p>
          )}
        </div>
        <details className="relative">
          <summary
            className="cursor-pointer list-none rounded-md p-1 hover:bg-muted"
            aria-label={t('menu')}
          >
            <MoreVertical className="size-5" aria-hidden />
          </summary>
          <div className="absolute right-0 z-10 mt-1 w-44 rounded-md border border-border bg-card p-1 shadow">
            <button
              type="button"
              className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-muted"
              onClick={() => void toggleBlock()}
            >
              {conversation.blockedByMe ? t('unblock') : t('block')}
            </button>
            <button
              type="button"
              className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-muted"
              onClick={() => reportRef.current?.showModal()}
            >
              {t('report')}
            </button>
          </div>
        </details>
      </header>

      <PostCard conversation={conversation} />

      <div
        className="flex-1 overflow-y-auto px-3 py-2"
        data-testid="chat-thread"
        aria-live="polite"
      >
        {hasOlder && (
          <div className="py-2 text-center">
            <Button variant="outline" size="sm" onClick={() => void older()}>
              {t('older')}
            </Button>
          </div>
        )}
        {messages.length === 0 && pending.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">{t('noMessagesYet')}</p>
        )}
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            mine={m.senderMemberId === me}
            state={m.senderMemberId === me ? deliveryState(m.id, conversation) : undefined}
          />
        ))}
        {pending.map((p) => (
          <PendingBubble
            key={p.clientMessageId}
            pending={p}
            onRetry={() => retry(p)}
            onDiscard={() => discard(p)}
            onEdit={
              p.content.kind === 'text'
                ? () => {
                    setText(p.content.kind === 'text' ? p.content.body : '');
                    discard(p);
                  }
                : undefined
            }
          />
        ))}
        <div ref={endRef} />
      </div>

      {notice && (
        <p role="status" className="border-t border-border px-4 py-2 text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {!online && (
        <p role="status" className="border-t border-border px-4 py-2 text-sm text-muted-foreground">
          {t('offline')}
        </p>
      )}
      {offerPush && sentOnce && <WebPushCard />}

      {conversation.canSend ? (
        <div className="border-t border-border p-2">
          {sellerSide && quickReplies.length > 0 && (
            <div
              className="mb-2 flex gap-2 overflow-x-auto"
              aria-label={t('quickReplies')}
              data-testid="chat-quick-replies"
            >
              {quickReplies.map((reply) => (
                <button
                  key={reply.id}
                  type="button"
                  className="shrink-0 rounded-full border border-border px-3 py-1 text-sm hover:bg-muted"
                  onClick={() => onType(reply.body)}
                >
                  {reply.body}
                </button>
              ))}
            </div>
          )}
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              submitText();
            }}
          >
            <button
              type="button"
              className="rounded-md p-2 hover:bg-muted"
              aria-label={t('sendPhoto')}
              onClick={() => fileRef.current?.click()}
            >
              <ImagePlus className="size-5" aria-hidden />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(event) => {
                pickPhoto(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            <button
              type="button"
              className="rounded-md p-2 hover:bg-muted"
              aria-label={t('shareLocation')}
              onClick={shareLocation}
            >
              <MapPin className="size-5" aria-hidden />
            </button>
            <textarea
              value={text}
              onChange={(event) => onType(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  submitText();
                }
              }}
              rows={1}
              placeholder={t('composerHint')}
              aria-label={t('composerHint')}
              data-testid="chat-input"
              className="max-h-32 min-h-10 flex-1 resize-none rounded-2xl border border-border bg-background px-3 py-2"
            />
            <Button
              type="submit"
              disabled={!text.trim()}
              aria-label={t('send')}
              data-testid="chat-send"
            >
              <Send className="size-4" aria-hidden />
            </Button>
          </form>
        </div>
      ) : (
        <p
          className="border-t border-border px-4 py-3 text-center text-sm text-muted-foreground"
          data-testid="chat-composer-disabled"
        >
          {disabledReason}
        </p>
      )}

      <dialog
        ref={reportRef}
        className="w-full max-w-sm rounded-lg border border-border bg-card p-4 text-foreground backdrop:bg-black/40"
      >
        <form
          method="dialog"
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void sendReport(event.currentTarget);
          }}
        >
          <h2 className="font-semibold">{t('reportTitle')}</h2>
          {REPORT_REASONS.map((reason, i) => (
            <label key={reason} className="flex items-center gap-2 text-sm">
              <input type="radio" name="reasonCode" value={reason} defaultChecked={i === 0} />
              {t(`reportReasons.${reason}`)}
            </label>
          ))}
          <textarea
            name="text"
            placeholder={t('reportDetailsHint')}
            className="w-full rounded-md border border-border bg-background p-2 text-sm"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => reportRef.current?.close()}>
              {t('cancel')}
            </Button>
            <Button type="submit">{t('reportSend')}</Button>
          </div>
        </form>
      </dialog>
    </section>
  );
}

function PostCard({ conversation }: { conversation: Conversation }) {
  const t = useTranslations('chat');
  const post = conversation.post;
  if (!post) {
    return conversation.postRemoved ? (
      <p className="border-b border-border px-4 py-2 text-sm text-muted-foreground">
        {t('postRemoved')}
      </p>
    ) : null;
  }
  return (
    <Link
      href={`/listing/${post.id}` as Route}
      className="flex items-center gap-3 border-b border-border px-4 py-2 hover:bg-muted"
      data-testid="chat-post-card"
    >
      {post.cover ? (
        // eslint-disable-next-line @next/next/no-img-element -- storage host is not known at build time
        <img src={post.cover.url} alt="" className="size-12 rounded-md object-cover" />
      ) : (
        <span className="size-12 rounded-md bg-muted" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{post.title}</span>
        {post.price !== null && (
          <span className="block text-sm text-brand">৳ {formatMoney(post.price, 'bn')}</span>
        )}
      </span>
      <span className="text-xs text-brand">{t('viewPost')}</span>
    </Link>
  );
}

/** A photo for this conversation: compressed here, uploaded through this site (no token in the browser). */
async function uploadPhoto(
  conversationId: string,
  file: File,
): Promise<{ ok: true; mediaId: string } | { ok: false; code: string }> {
  try {
    const compressed = await compressImage(file);
    const response = await fetch(`/api/media/upload?conversation=${conversationId}`, {
      method: 'POST',
      headers: { 'content-type': compressed.type, 'x-content-sha256': await sha256Hex(compressed) },
      body: compressed,
    });
    const body = (await response.json().catch(() => ({}))) as { mediaId?: string; code?: string };
    if (response.ok && body.mediaId) return { ok: true, mediaId: body.mediaId };
    if (response.status >= 500 || response.status === 429) return { ok: false, code: 'NETWORK' };
    return { ok: false, code: 'CHAT_IMAGE_INVALID' };
  } catch {
    return { ok: false, code: 'NETWORK' };
  }
}
