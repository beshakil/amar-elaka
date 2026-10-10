import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import Redis from 'ioredis';
import type { Sql } from 'postgres';
import sharp from 'sharp';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/tokens/token.service';
import { CHAT_NAMESPACE, CHAT_SOCKET_PATH } from '../src/chat/realtime/chat-socket.server';
import { MediaProcessingService } from '../src/media/media-processing.service';
import { MediaWorkerModule } from '../src/media/media-worker.module';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * Chat end to end (ADR 058) on real Postgres + Redis, with TWO API
 * instances on two ports sharing them — the production shape. Socket.IO
 * clients connect to either; messages cross instances through the Redis
 * adapter.
 *
 * Tenant B holds the seller's posts and a store (owner + manager); tenant B
 * overrides: contact filter over the first 3 messages, 2 quick replies per
 * store, 15 messages a minute. Tenant A turns the contact filter off (0).
 * The buyers are members of tenant A who message across the boundary
 * (radius discovery): the conversation lives in B. The seller's number must
 * never appear in any chat payload, in any spelling.
 */

const P = '0191e3a0-c4a2-7000-8000-';
const FIXTURE = `${P}%`;
const PARTNER = `${P}000000000001`;
const AREA_A = `${P}000000000011`;
const AREA_B = `${P}000000000012`;
const TENANT_A = `${P}000000000021`;
const TENANT_B = `${P}000000000022`;
const CATEGORY = `${P}000000000061`;
const SCHEMA = `${P}000000000062`;
const STORE = `${P}000000000071`;
const POST_B = `${P}000000000081`;
const POST_SCRUB = `${P}000000000082`;
const POST_A = `${P}000000000083`;

type Who =
  'seller' | 'buyer' | 'buyer2' | 'buyer3' | 'stranger' | 'owner' | 'manager' | 'mod' | 'sellerA';
const PEOPLE: Record<
  Who,
  { user: string; member: string; tenant: string; role: string; phone: string }
> = {
  seller: {
    user: `${P}000000000031`,
    member: `${P}000000000041`,
    tenant: TENANT_B,
    role: 'member',
    phone: '+8801755000001',
  },
  buyer: {
    user: `${P}000000000032`,
    member: `${P}000000000042`,
    tenant: TENANT_A,
    role: 'member',
    phone: '+8801755000002',
  },
  buyer2: {
    user: `${P}000000000033`,
    member: `${P}000000000043`,
    tenant: TENANT_A,
    role: 'member',
    phone: '+8801755000003',
  },
  buyer3: {
    user: `${P}000000000034`,
    member: `${P}000000000044`,
    tenant: TENANT_A,
    role: 'member',
    phone: '+8801755000004',
  },
  stranger: {
    user: `${P}000000000035`,
    member: `${P}000000000045`,
    tenant: TENANT_A,
    role: 'member',
    phone: '+8801755000005',
  },
  owner: {
    user: `${P}000000000036`,
    member: `${P}000000000046`,
    tenant: TENANT_B,
    role: 'member',
    phone: '+8801755000006',
  },
  manager: {
    user: `${P}000000000037`,
    member: `${P}000000000047`,
    tenant: TENANT_B,
    role: 'member',
    phone: '+8801755000007',
  },
  mod: {
    user: `${P}000000000038`,
    member: `${P}000000000048`,
    tenant: TENANT_B,
    role: 'moderator',
    phone: '+8801755000008',
  },
  sellerA: {
    user: `${P}000000000039`,
    member: `${P}000000000049`,
    tenant: TENANT_A,
    role: 'member',
    phone: '+8801755000009',
  },
};
/** The seller's number, every way it could leak: E.164, local, digits only, Bengali digits. */
const PHONE_SPELLINGS = [
  '+8801755000001',
  '8801755000001',
  '01755000001',
  '1755000001',
  '০১৭৫৫০০০০০১',
];

const square = (west: number, east: number) =>
  `SRID=4326;MULTIPOLYGON(((${west} 22.7,${east} 22.7,${east} 22.8,${west} 22.8,${west} 22.7)))`;
const IN_A = { lat: 22.75, lng: 89.05 };
const IN_B = { lat: 22.75, lng: 89.15 };

type Ack<T = unknown> =
  { ok: true; data: T } | { ok: false; error: { code: string; details?: unknown } };
interface MessageView {
  id: string;
  clientMessageId: string;
  conversationId: string;
  kind: string;
  body: string | null;
  senderMemberId: string | null;
  listing: { state: string; postId?: string } | null;
  image: { full: { url: string } } | null;
}
interface ConversationView {
  id: string;
  tenantId: string;
  canSend: boolean;
  isBlocked: boolean;
  blockedByMe: boolean;
  isLocked: boolean;
  post: { id: string; title: string } | null;
  postRemoved: boolean;
  counterpart: { kind: string; name: string | null };
  me: { memberId: string; role: string };
  othersReadUpTo: string | null;
}

jest.setTimeout(30_000);

describe('Chat (e2e, two API instances)', () => {
  let admin: Sql;
  let redis: Redis;
  let one: { app: NestFastifyApplication; port: number; module: TestingModule };
  let two: { app: NestFastifyApplication; port: number };
  let processing: MediaProcessingService;
  const tokens = {} as Record<Who, string>;
  const sockets: ClientSocket[] = [];
  /** Every payload the API sent us, REST and socket: the phone-leak check reads them all. */
  const seen: string[] = [];

  async function boot(
    withWorker: boolean,
  ): Promise<{ app: NestFastifyApplication; port: number; module: TestingModule }> {
    const module = await Test.createTestingModule({
      imports: withWorker ? [AppModule, MediaWorkerModule] : [AppModule],
    }).compile();
    const app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api', {
      exclude: [
        { path: 'health/live', method: RequestMethod.GET },
        { path: 'health/ready', method: RequestMethod.GET },
      ],
    });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;
    return { app, port, module };
  }

  const call = async (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    as: Who,
    body?: unknown,
  ) => {
    const response = await one.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { 'x-tenant-id': PEOPLE[as].tenant, authorization: `Bearer ${tokens[as]}` },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });
    seen.push(response.body);
    return response;
  };

  const connect = (port: number, as: Who, token = tokens[as]) =>
    new Promise<ClientSocket>((resolve, reject) => {
      const socket = io(`http://127.0.0.1:${port}${CHAT_NAMESPACE}`, {
        path: CHAT_SOCKET_PATH,
        transports: ['websocket'],
        auth: { token },
        forceNew: true,
        reconnection: false,
      });
      sockets.push(socket);
      socket.onAny((_event: string, payload: unknown) => seen.push(JSON.stringify(payload)));
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    });

  const emit = <T = unknown>(socket: ClientSocket, event: string, payload: unknown) =>
    new Promise<Ack<T>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), 10_000);
      socket.emit(event, payload, (answer: Ack<T>) => {
        clearTimeout(timer);
        seen.push(JSON.stringify(answer));
        resolve(answer);
      });
    });

  const next = <T>(
    socket: ClientSocket,
    event: string,
    match: (payload: T) => boolean = () => true,
  ) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off(event, handler);
        reject(new Error(`no ${event}`));
      }, 10_000);
      const handler = (payload: T) => {
        if (!match(payload)) return;
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(payload);
      };
      socket.on(event, handler);
    });

  const collect = <T>(socket: ClientSocket, event: string): T[] => {
    const got: T[] = [];
    socket.on(event, (payload: T) => got.push(payload));
    return got;
  };

  const settle = (ms = 600) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (body: string, clientMessageId = randomUUID()) => ({
    clientMessageId,
    content: { kind: 'text', body },
  });
  const openOnPost = async (as: Who, postId = POST_B, source = 'post_detail') => {
    const response = await call('POST', `/posts/${postId}/conversations`, as, { source });
    expect(response.statusCode).toBe(201);
    return response.json<{ conversation: ConversationView; created: boolean }>();
  };

  async function clearRedis(): Promise<void> {
    const users = Object.values(PEOPLE).map((p) => p.user);
    for (const pattern of ['chat:*', 'media:*']) {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        cursor = nextCursor;
        const ours = keys.filter(
          (key) => users.some((user) => key.includes(user)) || key.includes(P),
        );
        if (ours.length > 0) await redis.del(...ours);
      } while (cursor !== '0');
    }
  }

  async function cleanUp(): Promise<void> {
    const tenants = [TENANT_A, TENANT_B];
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from moderation_actions where tenant_id in ${tx(tenants)}`;
      await tx`delete from conversation_report_snapshots where tenant_id in ${tx(tenants)}`;
      await tx`delete from reports where tenant_id in ${tx(tenants)}`;
      await tx`delete from lead_events where tenant_id in ${tx(tenants)}`;
      await tx`delete from messages where tenant_id in ${tx(tenants)}`;
      await tx`delete from conversation_participants where tenant_id in ${tx(tenants)}`;
      await tx`delete from conversations where tenant_id in ${tx(tenants)}`;
      await tx`delete from store_quick_replies where tenant_id in ${tx(tenants)}`;
      await tx`delete from user_blocks where blocker_user_id::text like ${FIXTURE}`;
      await tx`delete from notifications where user_id::text like ${FIXTURE}`;
      await tx`delete from media_assets where tenant_id in ${tx(tenants)}`;
      await tx`delete from posts where tenant_id in ${tx(tenants)}`;
      await tx`delete from store_members where tenant_id in ${tx(tenants)}`;
      await tx`delete from stores where tenant_id in ${tx(tenants)}`;
      await tx`delete from tenant_categories where tenant_id in ${tx(tenants)}`;
      await tx`delete from tenant_members where tenant_id in ${tx(tenants)}`;
      await tx`delete from tenant_settings where tenant_id in ${tx(tenants)}`;
    });
    await admin`delete from outbox_events where aggregate_id::text like ${FIXTURE}`;
    await admin`delete from category_field_schemas where category_id::text like ${FIXTURE}`;
    await admin`delete from categories where id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from user_profiles where user_id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    redis = new Redis(process.env.REDIS_URL!);
    await cleanUp();
    await clearRedis();
    for (const person of Object.values(PEOPLE)) {
      await admin`insert into users (id, phone_e164, phone_verified_at) values (${person.user}, ${person.phone}, now())`;
    }
    await admin`insert into user_profiles (user_id, display_name) values
      (${PEOPLE.seller.user}, 'রহিম বিক্রেতা'), (${PEOPLE.buyer.user}, 'করিম ক্রেতা')`;
    await admin`insert into partners (id, legal_name, display_name, phone_e164)
                values (${PARTNER}, 'Chat Partner', 'Chat Partner', '+8801755000099')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, name_bn, source_release, boundary, boundary_simplified)
      values
        (${AREA_A}, 3, 'upazila', 'chat-e2e-a', 'Chat A', 'চ্যাট এ', 'fixture', ${square(89.0, 89.1)}, ${square(89.0, 89.1)}),
        (${AREA_B}, 3, 'upazila', 'chat-e2e-b', 'Chat B', 'চ্যাট বি', 'fixture', ${square(89.1, 89.2)}, ${square(89.1, 89.2)})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values
        (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'chat-e2e-a', 'এ', 'A', st_point(89.05, 22.75)::geography, 'active'),
        (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'chat-e2e-b', 'বি', 'B', st_point(89.15, 22.75)::geography, 'active')`;
    await admin.begin(async (tx) => {
      // Platform-scope overrides need platform staff (0003). Before the apps
      // start: SettingsService caches what it reads.
      await tx`select set_config('app.role', 'platform_admin', true)`;
      await tx`
        insert into tenant_settings (tenant_id, post_moderation_mode_code, setting_overrides) values
          (${TENANT_A}, 'post', ${tx.json({ chat_contact_filter_first_messages: 0 })}),
          (${TENANT_B}, 'post', ${tx.json({
            chat_contact_filter_first_messages: 3,
            chat_quick_replies_per_store_max: 2,
            chat_messages_per_user_per_minute: 15,
          })})`;
    });
    for (const person of Object.values(PEOPLE)) {
      await admin`insert into tenant_members (id, tenant_id, user_id, role_code)
                  values (${person.member}, ${person.tenant}, ${person.user}, ${person.role})`;
    }
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en, default_moderation_mode_code)
      values (${CATEGORY}, 'marketplace', 'chat-e2e-phones', 'মোবাইল', 'Phones', 'post')`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, ui_schema, status_code, published_at)
      values (${SCHEMA}, ${CATEGORY}, 1, ${admin.json({ type: 'object', properties: {}, required: [] })},
              ${admin.json({ order: [] })}, 'published', now())`;
    await admin`
      insert into tenant_categories (tenant_id, category_id, is_enabled)
      values (${TENANT_A}, ${CATEGORY}, true), (${TENANT_B}, ${CATEGORY}, true)`;
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`insert into stores (id, tenant_id, owner_member_id, slug, name_bn, status_code)
               values (${STORE}, ${TENANT_B}, ${PEOPLE.owner.member}, 'chat-e2e-store', 'চ্যাট দোকান', 'active')`;
      await tx`insert into store_members (tenant_id, store_id, member_id, role_code, accepted_at)
               values (${TENANT_B}, ${STORE}, ${PEOPLE.manager.member}, 'manager', now())`;
    });
    for (const [id, tenant, author, at, area] of [
      [POST_B, TENANT_B, PEOPLE.seller.member, IN_B, AREA_B],
      [POST_SCRUB, TENANT_B, PEOPLE.seller.member, IN_B, AREA_B],
      [POST_A, TENANT_A, PEOPLE.sellerA.member, IN_A, AREA_A],
    ] as const) {
      await admin`
        insert into posts
          (id, tenant_id, author_member_id, category_id, field_schema_id, title, fields, status_code,
           published_at, bumped_at, expires_at, location, geo_area_id, contact_name, contact_phone_e164, show_phone)
        values
          (${id}, ${tenant}, ${author}, ${CATEGORY}, ${SCHEMA}, 'স্যামসাং ফোন', '{}'::jsonb, 'live',
           now(), now(), now() + interval '20 days', ${`SRID=4326;POINT(${at.lng} ${at.lat})`}, ${area},
           'রহিম', ${PEOPLE.seller.phone}, true)`;
    }

    one = await boot(true);
    two = await boot(false);
    processing = one.module.get(MediaProcessingService);
    const signer = one.module.get(TokenService);
    for (const [who, person] of Object.entries(PEOPLE) as [Who, (typeof PEOPLE)[Who]][]) {
      tokens[who] = await signer.signAccessToken({
        userId: person.user,
        tenantId: person.tenant,
        memberId: person.member,
        role: person.role as 'member' | 'moderator',
      });
    }
  }, 120_000);

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    try {
      await two?.app.close();
      await one?.app.close();
      await cleanUp();
      await clearRedis();
    } finally {
      await admin.end();
      redis.disconnect();
    }
  }, 60_000);

  // ---- opening ------------------------------------------------------------

  it('opens a conversation about a post in another tenant; reopening returns the same one', async () => {
    const first = await openOnPost('buyer', POST_B, 'search_result');
    expect(first.created).toBe(true);
    expect(first.conversation).toMatchObject({
      tenantId: TENANT_B,
      post: { id: POST_B, title: 'স্যামসাং ফোন' },
      counterpart: { kind: 'seller', name: 'রহিম বিক্রেতা' },
      me: { role: 'buyer' },
      canSend: true,
    });
    const again = await openOnPost('buyer');
    expect(again).toMatchObject({ created: false, conversation: { id: first.conversation.id } });
    expect(
      (await call('POST', `/posts/${POST_B}/conversations`, 'seller', {})).json(),
    ).toMatchObject({
      error: 'CHAT_OWN_LISTING',
    });
  });

  it('archives a conversation for the caller only; the next message brings it back', async () => {
    const { conversation } = await openOnPost('buyer');
    const inboxIds = async (who: Who, archived = false) =>
      (await call('GET', `/conversations${archived ? '?archived=true' : ''}`, who))
        .json<{ items: ConversationView[] }>()
        .items.map((c) => c.id);
    expect(
      (await call('POST', `/conversations/${conversation.id}/archive`, 'buyer')).statusCode,
    ).toBe(200);
    expect(await inboxIds('buyer')).not.toContain(conversation.id);
    expect(await inboxIds('buyer', true)).toContain(conversation.id);
    expect(await inboxIds('seller')).toContain(conversation.id); // the seller's copy is untouched
    // The post card fields are there (this fixture post has no photo or price).
    expect((await call('GET', `/conversations/${conversation.id}`, 'buyer')).json()).toMatchObject({
      post: { id: POST_B, title: 'স্যামসাং ফোন', price: null, cover: null },
    });
    await call('POST', `/conversations/${conversation.id}/messages`, 'seller', text('ফিরে আসুন'));
    expect(await inboxIds('buyer')).toContain(conversation.id);
    expect(
      (await call('POST', `/conversations/${conversation.id}/archive`, 'stranger')).statusCode,
    ).toBe(404);
  });

  // ---- the two-instance exchange -------------------------------------------

  it('two API instances exchange messages through Redis, to every device of each side', async () => {
    const { conversation } = await openOnPost('buyer');
    const buyerOnOne = await connect(one.port, 'buyer');
    const sellerOnTwo = await connect(two.port, 'seller');
    const buyerSecondDeviceOnTwo = await connect(two.port, 'buyer');

    const toSeller = next<{ message: MessageView }>(
      sellerOnTwo,
      'message:new',
      (e) => e.message.body === 'আছে?',
    );
    const toBuyerElsewhere = next<{ message: MessageView }>(
      buyerSecondDeviceOnTwo,
      'message:new',
      (e) => e.message.body === 'আছে?',
    );
    const sent = await emit<{ message: MessageView; created: boolean }>(
      buyerOnOne,
      'message:send',
      {
        conversationId: conversation.id,
        ...text('আছে?'),
      },
    );
    expect(sent).toMatchObject({
      ok: true,
      data: { created: true, message: { kind: 'text', body: 'আছে?' } },
    });
    expect((await toSeller).message.senderMemberId).toBe(conversation.me.memberId);
    await toBuyerElsewhere;

    const toBuyer = next<{ message: MessageView }>(
      buyerOnOne,
      'message:new',
      (e) => e.message.body === 'জি আছে',
    );
    const reply = await emit(sellerOnTwo, 'message:send', {
      conversationId: conversation.id,
      ...text('জি আছে'),
    });
    expect(reply.ok).toBe(true);
    expect((await toBuyer).message.kind).toBe('text');
  });

  it('the first seller reply writes one chat lead (chat counts as a contact channel)', async () => {
    const { conversation } = await openOnPost('buyer');
    const leads = await admin<
      { channel_code: string; source_code: string; actor: string; target: string }[]
    >`
      select channel_code, source_code, actor_member_id as actor, target_member_id as target
      from lead_events where tenant_id = ${TENANT_B} and post_id = ${POST_B}`;
    expect(leads).toEqual([
      {
        channel_code: 'chat_started',
        source_code: 'search_result',
        actor: conversation.me.memberId,
        target: PEOPLE.seller.member,
      },
    ]);
    const seller = await connect(two.port, 'seller');
    expect(
      (await emit(seller, 'message:send', { conversationId: conversation.id, ...text('আরেকটা') }))
        .ok,
    ).toBe(true);
    const [count] = await admin<{ n: number }[]>`
      select count(*)::int as n from lead_events where tenant_id = ${TENANT_B} and channel_code = 'chat_started'`;
    expect(count!.n).toBe(1);
  });

  it('delivered and read receipts reach the sender', async () => {
    const { conversation } = await openOnPost('buyer');
    const buyer = await connect(one.port, 'buyer');
    const seller = await connect(two.port, 'seller');
    const sent = await emit<{ message: MessageView }>(buyer, 'message:send', {
      conversationId: conversation.id,
      ...text('রসিদ'),
    });
    const messageId = sent.ok ? sent.data.message.id : '';
    const receipt = next<{ readUpTo: string }>(buyer, 'receipt', (e) => e.readUpTo === messageId);
    expect(
      await emit(seller, 'message:read', {
        conversationId: conversation.id,
        upToMessageId: messageId,
      }),
    ).toMatchObject({ ok: true, data: { readUpTo: messageId, unreadCount: 0 } });
    await receipt;
    expect((await call('GET', `/conversations/${conversation.id}`, 'buyer')).json()).toMatchObject({
      othersReadUpTo: messageId,
    });
  });

  // ---- tenancy -------------------------------------------------------------

  it('a member of tenant A cannot join, read or write a tenant B conversation', async () => {
    const { conversation } = await openOnPost('buyer');
    const stranger = await connect(one.port, 'stranger');
    for (const [event, payload] of [
      ['conversation:join', { conversationId: conversation.id }],
      ['message:send', { conversationId: conversation.id, ...text('ঢুকতে চাই') }],
      ['message:read', { conversationId: conversation.id, upToMessageId: conversation.id }],
    ] as const) {
      expect(await emit(stranger, event, payload)).toMatchObject({
        ok: false,
        error: { code: 'CHAT_CONVERSATION_NOT_FOUND' },
      });
    }
    expect((await call('GET', `/conversations/${conversation.id}`, 'stranger')).statusCode).toBe(
      404,
    );
    expect(
      (await call('GET', `/conversations/${conversation.id}/messages`, 'stranger')).statusCode,
    ).toBe(404);
    // The typing room is joined only through an authorised join: nothing reaches a stranger.
    const typings = collect(stranger, 'typing');
    const seller = await connect(two.port, 'seller');
    await emit(seller, 'conversation:join', { conversationId: conversation.id });
    await emit(seller, 'typing', { conversationId: conversation.id, isTyping: true });
    await settle();
    expect(typings).toEqual([]);
  });

  it('refuses a socket without a valid token', async () => {
    await expect(connect(one.port, 'buyer', 'not-a-token')).rejects.toMatchObject({
      data: { code: 'UNAUTHENTICATED' },
    });
  });

  // ---- the contact soft-block ------------------------------------------------

  it('holds back a phone number or link in the first messages, then lets it through flagged', async () => {
    const { conversation } = await openOnPost('buyer2');
    const buyer = await connect(one.port, 'buyer2');
    const seller = await connect(two.port, 'seller');
    const received = collect<{ message: MessageView }>(seller, 'message:new');

    // Bengali digits, split by a dash: the pre-filter's own matcher catches it.
    expect(
      await emit(buyer, 'message:send', {
        conversationId: conversation.id,
        ...text('ফোন দিন ০১৭১১-২২৩৩৪৪'),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'CHAT_CONTACT_INFO_BLOCKED', details: { found: 'phone', remaining: 3 } },
    });
    const link = await call(
      'POST',
      `/conversations/${conversation.id}/messages`,
      'buyer2',
      text('দেখুন bit.ly/abc'),
    );
    expect(link.statusCode).toBe(422);
    expect(link.json()).toMatchObject({
      error: 'CHAT_CONTACT_INFO_BLOCKED',
      details: { found: 'link' },
    });
    await settle();
    expect(received).toEqual([]);
    expect(
      (await call('GET', `/conversations/${conversation.id}/messages`, 'buyer2')).json(),
    ).toMatchObject({
      items: [],
    });

    for (const body of ['হ্যালো', 'ফোনটা কেমন?', 'দাম কমবে?']) {
      expect(
        (await emit(buyer, 'message:send', { conversationId: conversation.id, ...text(body) })).ok,
      ).toBe(true);
    }
    const late = await emit<{ message: MessageView }>(buyer, 'message:send', {
      conversationId: conversation.id,
      ...text('এখন নম্বর 01711223344'),
    });
    expect(late.ok).toBe(true);
    const [row] = await admin<{ flagged_by_filter: boolean }[]>`
      select flagged_by_filter from messages where id = ${late.ok ? late.data.message.id : ''}`;
    expect(row!.flagged_by_filter).toBe(true);
  });

  it('the filter is a per-tenant setting: off where the tenant set 0', async () => {
    const opened = await call('POST', `/posts/${POST_A}/conversations`, 'buyer2', {});
    const { conversation } = opened.json<{ conversation: ConversationView }>();
    const first = await call(
      'POST',
      `/conversations/${conversation.id}/messages`,
      'buyer2',
      text('নম্বর 01711223344'),
    );
    expect(first.statusCode).toBe(201);
  });

  // ---- offline queue: dedupe on reconnect ---------------------------------------

  it('a resend after reconnect is the same message, delivered once', async () => {
    const { conversation } = await openOnPost('buyer');
    const seller = await connect(two.port, 'seller');
    const received = collect<{ message: MessageView }>(seller, 'message:new');
    const queued = text('অফলাইনে লেখা');

    const firstSocket = await connect(one.port, 'buyer');
    const first = await emit<{ message: MessageView; created: boolean }>(
      firstSocket,
      'message:send',
      {
        conversationId: conversation.id,
        ...queued,
      },
    );
    firstSocket.disconnect();
    const reconnected = await connect(two.port, 'buyer');
    const again = await emit<{ message: MessageView; created: boolean }>(
      reconnected,
      'message:send',
      {
        conversationId: conversation.id,
        ...queued,
      },
    );
    const overRest = await call(
      'POST',
      `/conversations/${conversation.id}/messages`,
      'buyer',
      queued,
    );
    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(again.data).toEqual({ created: false, message: first.data.message });
    expect(overRest.json()).toMatchObject({
      created: false,
      message: { id: first.data.message.id },
    });
    await settle();
    expect(
      received.filter((e) => e.message.clientMessageId === queued.clientMessageId),
    ).toHaveLength(1);
    const [count] = await admin<{ n: number }[]>`
      select count(*)::int as n from messages where client_message_id = ${queued.clientMessageId}`;
    expect(count!.n).toBe(1);
  });

  // ---- block ----------------------------------------------------------------

  it('block stops delivery and typing, both ways, until unblocked', async () => {
    const { conversation } = await openOnPost('buyer');
    const buyer = await connect(one.port, 'buyer');
    const seller = await connect(two.port, 'seller');
    await emit(buyer, 'conversation:join', { conversationId: conversation.id });
    await emit(seller, 'conversation:join', { conversationId: conversation.id });
    const typed = next<{ isTyping: boolean; expiresInSeconds: number }>(buyer, 'typing');
    await emit(seller, 'typing', { conversationId: conversation.id, isTyping: true });
    const typing = await typed;
    expect(typing.isTyping).toBe(true);
    expect(typing.expiresInSeconds).toBeGreaterThan(0);

    const blocked = await call('POST', `/conversations/${conversation.id}/block`, 'buyer');
    expect(blocked.json()).toMatchObject({ canSend: false, isBlocked: true, blockedByMe: true });
    await settle();
    const toBuyer = collect(buyer, 'message:new');
    const typingToBuyer = collect(buyer, 'typing');
    expect(
      await emit(seller, 'message:send', { conversationId: conversation.id, ...text('শুনুন') }),
    ).toMatchObject({
      ok: false,
      error: { code: 'CHAT_BLOCKED' },
    });
    expect(
      await emit(seller, 'typing', { conversationId: conversation.id, isTyping: true }),
    ).toMatchObject({
      ok: true,
      data: { relayed: false },
    });
    expect(
      await emit(buyer, 'message:send', { conversationId: conversation.id, ...text('না') }),
    ).toMatchObject({
      ok: false,
      error: { code: 'CHAT_BLOCKED' },
    });
    expect((await call('POST', `/stores/${STORE}/conversations`, 'buyer', {})).statusCode).toBe(
      201,
    ); // the store isn't the seller
    await settle();
    expect(toBuyer).toEqual([]);
    expect(typingToBuyer).toEqual([]);

    expect(
      (await call('DELETE', `/conversations/${conversation.id}/block`, 'buyer')).json(),
    ).toMatchObject({
      canSend: true,
    });
    expect(
      (await emit(seller, 'message:send', { conversationId: conversation.id, ...text('আবার') })).ok,
    ).toBe(true);
  });

  // ---- rate limit -----------------------------------------------------------

  it('limits messages per user per minute (a setting)', async () => {
    const { conversation } = await openOnPost('buyer3');
    const buyer = await connect(one.port, 'buyer3');
    const answers: Ack[] = [];
    for (let i = 0; i < 16; i += 1) {
      answers.push(
        await emit(buyer, 'message:send', {
          conversationId: conversation.id,
          ...text(`বার্তা ${i}`),
        }),
      );
    }
    expect(answers.slice(0, 15).every((a) => a.ok)).toBe(true);
    expect(answers[15]).toMatchObject({
      ok: false,
      error: { code: 'CHAT_RATE_LIMITED', details: { limit: 15 } },
    });
  });

  // ---- report and moderation -------------------------------------------------

  it('a report attaches the transcript; a moderator lock writes moderation_actions and closes the conversation', async () => {
    const { conversation } = await openOnPost('buyer3');
    const report = await call('POST', `/conversations/${conversation.id}/report`, 'buyer3', {
      reasonCode: 'harassment',
      text: 'বিরক্ত করছে',
    });
    expect(report.statusCode).toBe(201);
    const { reportId } = report.json<{ reportId: string }>();
    expect(
      (
        await call('POST', `/conversations/${conversation.id}/report`, 'buyer3', {
          reasonCode: 'spam',
        })
      ).json(),
    ).toEqual({
      reportId,
      created: false,
    });
    expect((await call('GET', `/chat-reports/${reportId}`, 'seller')).statusCode).toBe(403);
    const queue = (await call('GET', '/chat-reports/queue', 'mod')).json<{
      items: { reportId: string }[];
    }>();
    expect(queue.items.map((i) => i.reportId)).toContain(reportId);
    const detail = (await call('GET', `/chat-reports/${reportId}`, 'mod')).json<{
      transcript: { body: string }[];
    }>();
    expect(detail.transcript.map((e) => e.body)).toContain('বার্তা 0');

    const buyer = await connect(one.port, 'buyer3');
    const updated = next<{ conversationId: string }>(
      buyer,
      'conversation:updated',
      (e) => e.conversationId === conversation.id,
    );
    const decided = await call('POST', `/chat-reports/${reportId}/decision`, 'mod', {
      decision: { decision: 'lock', reasonCode: 'harassment', note: 'হয়রানি' },
    });
    expect(decided.statusCode).toBe(200);
    await updated;
    const [action] = await admin<{ action_code: string; conversation_id: string }[]>`
      select action_code, conversation_id from moderation_actions
      where id = ${decided.json<{ moderationActionId: string }>().moderationActionId}`;
    expect(action).toEqual({
      action_code: 'conversation_locked',
      conversation_id: conversation.id,
    });
    // Nobody can send now: the seller either (the buyer used up this minute's messages above).
    const seller = await connect(two.port, 'seller');
    expect(
      await emit(seller, 'message:send', { conversationId: conversation.id, ...text('আর?') }),
    ).toMatchObject({
      ok: false,
      error: { code: 'CHAT_LOCKED' },
    });
  });

  // ---- quick replies ----------------------------------------------------------

  it('quick replies: per store, at most N, for the owner and managers, in the composer', async () => {
    for (const body of ['জি, আছে', 'দাম ফিক্সড']) {
      expect(
        (await call('POST', `/stores/${STORE}/quick-replies`, 'owner', { body })).statusCode,
      ).toBe(201);
    }
    const third = await call('POST', `/stores/${STORE}/quick-replies`, 'manager', { body: 'আসুন' });
    expect(third.json()).toMatchObject({
      error: 'CHAT_QUICK_REPLY_LIMIT_REACHED',
      details: { max: 2 },
    });
    expect((await call('GET', `/stores/${STORE}/quick-replies`, 'stranger')).statusCode).toBe(403);

    const opened = (
      await call('POST', `/stores/${STORE}/conversations`, 'buyer2', { source: 'store_page' })
    ).json<{
      conversation: ConversationView;
    }>();
    expect(opened.conversation.counterpart).toEqual({ kind: 'store', name: 'চ্যাট দোকান' });
    const forManager = await call(
      'GET',
      `/conversations/${opened.conversation.id}/quick-replies`,
      'manager',
    );
    expect(forManager.json<{ items: { body: string }[] }>().items.map((i) => i.body)).toEqual([
      'জি, আছে',
      'দাম ফিক্সড',
    ]);
    expect(
      (
        await call('GET', `/conversations/${opened.conversation.id}/quick-replies`, 'buyer2')
      ).json(),
    ).toMatchObject({
      items: [],
    });
  });

  // ---- Q46 --------------------------------------------------------------------

  it('scrub: the conversation loses its post and every card of it becomes the neutral marker (Q46)', async () => {
    const { conversation: about } = await openOnPost('buyer2', POST_SCRUB);
    const store = (await call('POST', `/stores/${STORE}/conversations`, 'buyer2', {})).json<{
      conversation: ConversationView;
    }>().conversation;
    for (const id of [about.id, store.id]) {
      const card = await call('POST', `/conversations/${id}/messages`, 'buyer2', {
        clientMessageId: randomUUID(),
        content: { kind: 'listing_card', postId: POST_SCRUB },
      });
      expect(card.json()).toMatchObject({
        message: { listing: { state: 'shared', postId: POST_SCRUB, title: 'স্যামসাং ফোন' } },
      });
    }
    await admin.begin(async (tx) => {
      await tx`
        insert into moderation_actions (tenant_id, post_id, actor_user_id, action_code, reason_code, reason_text, evidence_refs)
        values (${TENANT_B}, ${POST_SCRUB}, ${PEOPLE.mod.user}, 'moderator_removed', 'spam', 'fixture', '["ev-1"]')`;
      await tx`select public.scrub_post(${POST_SCRUB}, 'spam', 'moderator_removed')`;
    });
    expect((await call('GET', `/conversations/${about.id}`, 'buyer2')).json()).toMatchObject({
      post: null,
      postRemoved: true,
    });
    for (const id of [about.id, store.id]) {
      const history = (await call('GET', `/conversations/${id}/messages`, 'buyer2')).json<{
        items: MessageView[];
      }>();
      const cards = history.items.filter((m) => m.kind === 'listing_card');
      expect(cards.map((m) => m.listing)).toEqual([{ state: 'listing_removed' }]);
    }
  });

  // ---- private images ----------------------------------------------------------

  it('a chat photo is private: uploaded in the conversation, shown through signed URLs only', async () => {
    const { conversation } = await openOnPost('buyer');
    const bytes = await sharp({
      create: { width: 64, height: 48, channels: 3, background: '#2a6' },
    })
      .jpeg()
      .toBuffer();
    const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
    expect(
      (
        await call('POST', '/media/presign', 'buyer', {
          kind: 'chat_image',
          contentType: 'image/jpeg',
          byteSize: bytes.length,
          checksumSha256,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call('POST', `/conversations/${conversation.id}/images`, 'stranger', {
          contentType: 'image/jpeg',
          byteSize: bytes.length,
          checksumSha256,
        })
      ).statusCode,
    ).toBe(404);
    const presigned = (
      await call('POST', `/conversations/${conversation.id}/images`, 'buyer', {
        contentType: 'image/jpeg',
        byteSize: bytes.length,
        checksumSha256,
      })
    ).json<{ mediaId: string; upload: { url: string; headers: Record<string, string> } }>();
    const put = await one.app.inject({
      method: 'PUT',
      url: new URL(presigned.upload.url).pathname,
      headers: presigned.upload.headers,
      payload: bytes,
    });
    expect(put.statusCode).toBe(200);
    expect(
      (
        await call(
          'POST',
          `/conversations/${conversation.id}/images/${presigned.mediaId}/confirm`,
          'buyer',
        )
      ).statusCode,
    ).toBe(202);
    expect(await processing.process(TENANT_B, presigned.mediaId)).toBe('ready');

    const sent = await call('POST', `/conversations/${conversation.id}/messages`, 'buyer', {
      clientMessageId: randomUUID(),
      content: { kind: 'image', mediaId: presigned.mediaId },
    });
    const { message } = sent.json<{ message: MessageView }>();
    const url = new URL(message.image!.full.url);
    expect(url.pathname.startsWith('/api/v1/storage/files/')).toBe(true);
    const image = await one.app.inject({ method: 'GET', url: url.pathname });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/webp');
    const forged = await one.app.inject({ method: 'GET', url: `${url.pathname.slice(0, -4)}AAAA` });
    expect(forged.statusCode).toBe(404);
    // The seller sees it too (a participant); the asset can't be sent again elsewhere.
    const forSeller = (
      await call('GET', `/conversations/${conversation.id}/messages`, 'seller')
    ).json<{ items: MessageView[] }>();
    expect(forSeller.items.find((m) => m.id === message.id)?.image?.full.url).toContain(
      '/api/v1/storage/files/',
    );
  });

  // ---- auth refresh -----------------------------------------------------------

  it('auth:refresh keeps the socket for the same user and closes it for another', async () => {
    const buyer = await connect(one.port, 'buyer');
    expect(await emit(buyer, 'auth:refresh', { token: tokens.buyer })).toMatchObject({ ok: true });
    const closed = new Promise((resolve) => buyer.once('disconnect', resolve));
    expect(await emit(buyer, 'auth:refresh', { token: tokens.seller })).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHENTICATED' },
    });
    await closed;
    expect(buyer.connected).toBe(false);
  });

  // ---- privacy ----------------------------------------------------------------

  it('never sent the seller’s phone number in any chat payload, in any spelling', () => {
    expect(seen.length).toBeGreaterThan(50);
    const all = seen.join('\n');
    for (const spelling of PHONE_SPELLINGS) expect(all).not.toContain(spelling);
  });
});
