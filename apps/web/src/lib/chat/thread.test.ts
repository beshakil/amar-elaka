import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../api/schemas';
import {
  deliveryState,
  errorKey,
  isTransient,
  laterOf,
  mergeMessages,
  newClientMessageId,
  newestFromOthers,
  settlePending,
  type PendingMessage,
} from './thread';

const id = (n: number) => `0192a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const message = (
  n: number,
  sender: string | null = 'm1',
  clientMessageId = `client-${n}`,
): ChatMessage => ({
  id: id(n),
  conversationId: 'c1',
  clientMessageId,
  senderMemberId: sender,
  senderRole: sender === null ? null : 'buyer',
  kind: 'text',
  body: `মেসেজ ${n}`,
  image: null,
  location: null,
  listing: null,
  systemEvent: null,
  createdAt: '2026-10-09T08:00:00.000Z',
});
const pending = (clientMessageId: string): PendingMessage => ({
  clientMessageId,
  content: { kind: 'text', body: 'হ্যালো' },
  state: 'sending',
  createdAt: '2026-10-09T08:00:00.000Z',
});

describe('ticks from the watermarks (uuid v7 order)', () => {
  const c = { othersDeliveredUpTo: id(5), othersReadUpTo: id(3) };
  it('read, delivered, sent', () => {
    expect(deliveryState(id(2), c)).toBe('read');
    expect(deliveryState(id(3), c)).toBe('read');
    expect(deliveryState(id(4), c)).toBe('delivered');
    expect(deliveryState(id(6), c)).toBe('sent');
  });
  it('no watermark yet: sent', () => {
    expect(deliveryState(id(1), { othersDeliveredUpTo: null, othersReadUpTo: null })).toBe('sent');
  });
  it('a watermark only moves forward', () => {
    expect(laterOf(id(5), id(3))).toBe(id(5));
    expect(laterOf(null, id(3))).toBe(id(3));
    expect(laterOf(id(3), null)).toBe(id(3));
  });
});

describe('one list from every source', () => {
  it('dedupes by id and keeps time order (a socket echo of a sent message, a catch-up overlap)', () => {
    const merged = mergeMessages([message(1), message(3)], [message(3), message(2), message(4)]);
    expect(merged.map((m) => m.id)).toEqual([id(1), id(2), id(3), id(4)]);
  });
  it('a pending copy goes once the server has its client id', () => {
    const left = settlePending([pending('a'), pending('b')], [message(9, 'm1', 'a')]);
    expect(left.map((p) => p.clientMessageId)).toEqual(['b']);
  });
  it('reads up to the newest message from the other side, not mine or a system line', () => {
    const list = [message(1, 'm2'), message(2, 'm1'), message(3, null)];
    expect(newestFromOthers(list, 'm1')?.id).toBe(id(1));
    expect(newestFromOthers([message(1, 'm1')], 'm1')).toBeNull();
  });
});

describe('sending', () => {
  it('the network is retried; a refusal is final', () => {
    expect(isTransient('NETWORK')).toBe(true);
    expect(isTransient('API_UNREACHABLE')).toBe(true);
    expect(isTransient('CHAT_CONTACT_INFO_BLOCKED')).toBe(false);
    expect(isTransient('CHAT_BLOCKED')).toBe(false);
  });
  it('known refusals explain themselves; anything else is the generic line', () => {
    expect(errorKey('CHAT_CONTACT_INFO_BLOCKED')).toBe('CHAT_CONTACT_INFO_BLOCKED');
    expect(errorKey('SOMETHING_NEW')).toBe('generic');
    expect(errorKey(undefined)).toBe('generic');
  });
  it('client ids are URL-safe, 8–64 characters, unique', () => {
    const ids = Array.from({ length: 50 }, newClientMessageId);
    expect(new Set(ids).size).toBe(50);
    for (const value of ids) expect(value).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});
