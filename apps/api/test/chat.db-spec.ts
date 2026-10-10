import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * Chat in the database (0054, ADR 058), as ae_app under RLS:
 *  - open_conversation: one per buyer and post / store, the seller and the
 *    store's staff as participants, never your own listing, never across a block;
 *  - the message trigger keeps unread counts and the sender's watermarks;
 *  - claim_first_seller_reply: one lead, only for a seller-side reply to a buyer;
 *  - store staff follow the store's conversations (store_members trigger);
 *  - RLS of the new tables and policy, each with its cross-tenant case:
 *    store_quick_replies, conversation_report_snapshots, chat images;
 *  - report_conversation snapshots the transcript (deleted messages too);
 *    decide_conversation_report locks with its moderation_actions row;
 *  - Q46: a scrub turns every listing card of the post into the neutral
 *    marker, in any conversation, and severs the post's conversations.
 */

const P = '0191e3a0-c4a1-7000-8000-';
const FIXTURE = `${P}%`;
const PARTNER = `${P}000000000001`;
const AREA_A = `${P}000000000011`;
const AREA_B = `${P}000000000012`;
const TENANT_A = `${P}000000000021`;
const TENANT_B = `${P}000000000022`;
const U = (n: number) => `${P}0000000000${30 + n}`;
const M = (n: number) => `${P}0000000000${50 + n}`;
/** Users; each is a member of tenant A as M(n). MOD_B is tenant B's moderator (member M(MOD_B) of B). */
const [SELLER, BUYER, OWNER, MANAGER, EDITOR, STRANGER, MOD, MOD_B, NEW_MANAGER] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9,
];
const STORE = `${P}000000000071`;
const CATEGORY = `${P}000000000072`;
const SCHEMA = `${P}000000000073`;
const POST = `${P}000000000081`;
const STORE_POST = `${P}000000000082`;
const OTHER_POST = `${P}000000000083`;
const IMAGE = `${P}000000000091`;

type Context = Partial<Record<'tenant_id' | 'user_id' | 'member_id' | 'role', string>>;
const as = (n: number, tenant = TENANT_A, role = 'member'): Context => ({
  tenant_id: tenant,
  user_id: U(n),
  member_id: M(n),
  role,
});

async function withContext<T>(
  sql: Sql,
  context: Context,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    for (const [key, value] of Object.entries(context)) {
      await tx`select set_config(${`app.${key}`}, ${value}, true)`;
    }
    return work(tx);
  }) as Promise<T>;
}

async function rejection(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => undefined,
    (caught: unknown) => (caught as { code?: string }).code ?? 'unknown',
  );
}

describe('Chat in the database (0054)', () => {
  let app: Sql;
  let admin: Sql;

  const open = (n: number, target: { post?: string; store?: string }, source = 'post_detail') =>
    withContext(
      app,
      as(n),
      (tx) =>
        tx<{ conversation_id: string; created: boolean }[]>`
        select conversation_id, created
        from public.open_conversation(${target.post ?? null}::uuid, ${target.store ?? null}::uuid, ${source})`,
    ).then((rows) => rows[0]!);

  let counter = 0;
  const send = (n: number, conversation: string, body: string) =>
    withContext(
      app,
      as(n),
      (tx) =>
        tx<{ id: string }[]>`
        insert into messages (conversation_id, sender_member_id, kind_code, body, client_message_id)
        values (${conversation}, ${M(n)}, 'text', ${body}, ${`db-spec-${(counter += 1)}`})
        returning id`,
    ).then((rows) => rows[0]!.id);

  const participants = (conversation: string) =>
    admin<
      {
        member_id: string;
        role_code: string;
        left_at: Date | null;
        unread_count: number;
        last_read_message_id: string | null;
      }[]
    >`
      select member_id, role_code, left_at, unread_count, last_read_message_id
      from conversation_participants where conversation_id = ${conversation} order by role_code, member_id`;

  async function cleanUp(): Promise<void> {
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from moderation_actions where tenant_id::text like ${FIXTURE}`;
      await tx`delete from conversation_report_snapshots where tenant_id::text like ${FIXTURE}`;
      await tx`delete from reports where tenant_id::text like ${FIXTURE}`;
      await tx`delete from lead_events where tenant_id::text like ${FIXTURE}`;
      await tx`delete from messages where tenant_id::text like ${FIXTURE}`;
      await tx`delete from conversation_participants where tenant_id::text like ${FIXTURE}`;
      await tx`delete from conversations where tenant_id::text like ${FIXTURE}`;
      await tx`delete from user_blocks where blocker_user_id::text like ${FIXTURE}`;
      await tx`delete from store_quick_replies where tenant_id::text like ${FIXTURE}`;
      await tx`delete from media_assets where tenant_id::text like ${FIXTURE}`;
      await tx`delete from posts where tenant_id::text like ${FIXTURE}`;
      await tx`delete from store_members where tenant_id::text like ${FIXTURE}`;
      await tx`delete from stores where tenant_id::text like ${FIXTURE}`;
      await tx`delete from tenant_categories where tenant_id::text like ${FIXTURE}`;
      await tx`delete from tenant_members where tenant_id::text like ${FIXTURE}`;
    });
    await admin`delete from outbox_events where aggregate_id::text like ${FIXTURE}`;
    await admin`delete from category_field_schemas where category_id::text like ${FIXTURE}`;
    await admin`delete from categories where id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    app = testSqlClient(4, resolveTestAppDatabaseUrl());
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();
    for (const n of [SELLER, BUYER, OWNER, MANAGER, EDITOR, STRANGER, MOD, MOD_B, NEW_MANAGER]) {
      await admin`insert into users (id, phone_e164) values (${U(n)}, ${`+88017470000${n}0`})`;
    }
    await admin`insert into partners (id, legal_name, display_name, phone_e164)
                values (${PARTNER}, 'Chat Fixture', 'Chat Fixture', '+8801747000099')`;
    await admin`insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
      (${AREA_A}, 3, 'upazila', 'chat-db-a', 'Chat A', 'fixture'),
      (${AREA_B}, 3, 'upazila', 'chat-db-b', 'Chat B', 'fixture')`;
    await admin`insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
      (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'chat-db-a', 'এ', 'A', st_point(91.1, 22.1)::geography, 'active'),
      (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'chat-db-b', 'বি', 'B', st_point(91.2, 22.1)::geography, 'active')`;
    for (const n of [SELLER, BUYER, OWNER, MANAGER, EDITOR, STRANGER, NEW_MANAGER]) {
      await admin`insert into tenant_members (id, tenant_id, user_id, role_code) values (${M(n)}, ${TENANT_A}, ${U(n)}, 'member')`;
    }
    await admin`insert into tenant_members (id, tenant_id, user_id, role_code) values
      (${M(MOD)}, ${TENANT_A}, ${U(MOD)}, 'moderator'), (${M(MOD_B)}, ${TENANT_B}, ${U(MOD_B)}, 'moderator')`;
    await admin`insert into categories (id, kind_code, slug, name_bn, name_en, default_moderation_mode_code, default_post_expiry_days)
                values (${CATEGORY}, 'marketplace', 'chat-db-sale', 'বিক্রি', 'Sale', 'post', 30)`;
    await admin`insert into category_field_schemas (id, category_id, version, json_schema, status_code, published_at)
                values (${SCHEMA}, ${CATEGORY}, 1, '{}'::jsonb, 'published', now())`;
    await admin`insert into tenant_categories (tenant_id, category_id, is_enabled) values (${TENANT_A}, ${CATEGORY}, true)`;
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`insert into stores (id, tenant_id, owner_member_id, slug, name_bn, status_code)
               values (${STORE}, ${TENANT_A}, ${M(OWNER)}, 'chat-db-store', 'চ্যাট দোকান', 'active')`;
      await tx`insert into store_members (tenant_id, store_id, member_id, role_code, accepted_at) values
        (${TENANT_A}, ${STORE}, ${M(MANAGER)}, 'manager', now()),
        (${TENANT_A}, ${STORE}, ${M(EDITOR)}, 'editor', now())`;
      for (const [id, author, store] of [
        [POST, M(SELLER), null],
        [STORE_POST, M(EDITOR), STORE],
        [OTHER_POST, M(SELLER), null],
      ] as const) {
        await tx`insert into posts (id, tenant_id, author_member_id, store_id, category_id, field_schema_id, title,
                                    status_code, published_at, expires_at, location, fields)
                 values (${id}, ${TENANT_A}, ${author}, ${store}, ${CATEGORY}, ${SCHEMA}, 'চ্যাটের পণ্য', 'live',
                         now(), now() + interval '20 days', st_point(91.1, 22.1)::geography, '{}'::jsonb)`;
      }
    });
  });

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await Promise.all([app.end(), admin.end()]);
    }
  });

  describe('open_conversation', () => {
    it('opens one per buyer and post, with the seller; reopening returns it', async () => {
      const first = await open(BUYER, { post: POST }, 'search_result');
      const again = await open(BUYER, { post: POST });
      expect(first.created).toBe(true);
      expect(again).toEqual({ conversation_id: first.conversation_id, created: false });
      expect(
        (await participants(first.conversation_id)).map((p) => [p.member_id, p.role_code]),
      ).toEqual([
        [M(BUYER), 'buyer'],
        [M(SELLER), 'seller'],
      ]);
      const [row] = await admin<{ origin_source_code: string; store_id: string | null }[]>`
        select origin_source_code, store_id from conversations where id = ${first.conversation_id}`;
      expect(row).toEqual({ origin_source_code: 'search_result', store_id: null });
    });

    it("a store's post brings the store's owner and accepted managers in as staff, never editors", async () => {
      const opened = await open(BUYER, { post: STORE_POST });
      expect(
        (await participants(opened.conversation_id)).map((p) => [p.member_id, p.role_code]),
      ).toEqual([
        [M(BUYER), 'buyer'],
        [M(EDITOR), 'seller'],
        [M(OWNER), 'store_staff'],
        [M(MANAGER), 'store_staff'],
      ]);
    });

    it('refuses your own listing (AE260) and a store you manage', async () => {
      expect(await rejection(open(SELLER, { post: POST }))).toBe('AE260');
      expect(await rejection(open(MANAGER, { store: STORE }))).toBe('AE260');
    });

    it('refuses a new conversation across a block, either way (AE261)', async () => {
      await withContext(
        app,
        as(SELLER),
        (tx) =>
          tx`insert into user_blocks (blocker_user_id, blocked_user_id) values (${U(SELLER)}, ${U(STRANGER)})`,
      );
      expect(await rejection(open(STRANGER, { post: OTHER_POST }))).toBe('AE261');
      await withContext(
        app,
        as(SELLER),
        (tx) => tx`delete from user_blocks where blocker_user_id = ${U(SELLER)}`,
      );
    });

    it('refuses a post that is not listed (P0002)', async () => {
      await admin`update posts set hidden_by_owner = true where id = ${OTHER_POST}`;
      expect(await rejection(open(STRANGER, { post: OTHER_POST }))).toBe('P0002');
      await admin`update posts set hidden_by_owner = false where id = ${OTHER_POST}`;
    });

    it('needs an active member context', async () => {
      const anon = withContext(
        app,
        { tenant_id: TENANT_A, role: 'anon' },
        (tx) => tx`select * from public.open_conversation(${POST}::uuid, null, 'post_detail')`,
      );
      expect(await rejection(anon)).toBe('42501');
    });
  });

  describe('messages and watermarks', () => {
    it('counts unread for the others and moves the sender’s own watermarks', async () => {
      const { conversation_id: id } = await open(BUYER, { post: POST });
      const before = new Map((await participants(id)).map((p) => [p.member_id, p.unread_count]));
      const sent = await send(BUYER, id, 'দাম কত?');
      const after = new Map((await participants(id)).map((p) => [p.member_id, p]));
      expect(after.get(M(SELLER))!.unread_count).toBe(before.get(M(SELLER))! + 1);
      expect(after.get(M(BUYER))!.unread_count).toBe(before.get(M(BUYER))!);
      expect(after.get(M(BUYER))!.last_read_message_id).toBe(sent);
      const [conversation] = await admin<{ last_message_preview: string }[]>`
        select last_message_preview from conversations where id = ${id}`;
      expect(conversation!.last_message_preview).toBe('দাম কত?');
    });

    it('a resend with the same client id inserts nothing', async () => {
      const { conversation_id: id } = await open(BUYER, { post: POST });
      const insert = () =>
        withContext(
          app,
          as(BUYER),
          (tx) =>
            tx`insert into messages (conversation_id, sender_member_id, kind_code, body, client_message_id)
             values (${id}, ${M(BUYER)}, 'text', 'আবার', 'db-spec-dedupe')
             on conflict (tenant_id, conversation_id, sender_member_id, client_message_id) do nothing
             returning id`,
        );
      expect(await insert()).toHaveLength(1);
      expect(await insert()).toHaveLength(0);
    });

    it('a listing card carries only its snapshot (messages_content_ck)', async () => {
      const { conversation_id: id } = await open(BUYER, { post: POST });
      const card = withContext(
        app,
        as(BUYER),
        (tx) =>
          tx`insert into messages (conversation_id, sender_member_id, kind_code, listing_snapshot, client_message_id)
           values (${id}, ${M(BUYER)}, 'listing_card', ${tx.json({ state: 'shared', postId: OTHER_POST })},
                   'db-spec-card-ok')`,
      );
      expect(await rejection(card)).toBeUndefined();
      const empty = withContext(
        app,
        as(BUYER),
        (tx) =>
          tx`insert into messages (conversation_id, sender_member_id, kind_code, client_message_id)
           values (${id}, ${M(BUYER)}, 'listing_card', 'db-spec-card-empty')`,
      );
      expect(await rejection(empty)).toBe('23514');
    });
  });

  describe('claim_first_seller_reply', () => {
    const claim = (n: number, conversation: string, message: string) =>
      withContext(
        app,
        as(n),
        (tx) =>
          tx<
            {
              source_code: string;
              seller_member_id: string;
              buyer_member_id: string;
              buyer_user_id: string;
            }[]
          >`
          select source_code, seller_member_id, buyer_member_id, buyer_user_id
          from public.claim_first_seller_reply(${conversation}::uuid, ${message}::uuid)`,
      );

    it('claims once: the first seller-side reply after the buyer wrote', async () => {
      const { conversation_id: id } = await open(BUYER, { store: STORE }, 'store_page');
      const early = await send(OWNER, id, 'স্বাগতম');
      expect(await claim(OWNER, id, early)).toEqual([]); // the buyer hasn't written yet
      const question = await send(BUYER, id, 'খোলা আছেন?');
      expect(await claim(BUYER, id, question)).toEqual([]); // not a seller-side reply
      const reply = await send(MANAGER, id, 'জি, খোলা');
      expect(await claim(MANAGER, id, reply)).toEqual([
        {
          source_code: 'store_page',
          seller_member_id: M(OWNER),
          buyer_member_id: M(BUYER),
          buyer_user_id: U(BUYER),
        },
      ]);
      const second = await send(OWNER, id, 'আসুন');
      expect(await claim(OWNER, id, second)).toEqual([]);
    });
  });

  describe('store staff follow the store’s conversations', () => {
    it('an accepted manager joins; a removed one leaves', async () => {
      const { conversation_id: id } = await open(BUYER, { store: STORE });
      await admin.begin(async (tx) => {
        await tx`select set_config('app.role', 'system', true)`;
        await tx`insert into store_members (tenant_id, store_id, member_id, role_code)
                 values (${TENANT_A}, ${STORE}, ${M(NEW_MANAGER)}, 'manager')`;
      });
      const row = async () => (await participants(id)).find((p) => p.member_id === M(NEW_MANAGER));
      expect(await row()).toBeUndefined(); // invited, not accepted
      await admin`update store_members set accepted_at = now() where member_id = ${M(NEW_MANAGER)}`;
      expect(await row()).toMatchObject({ role_code: 'store_staff', left_at: null });
      await admin`delete from store_members where member_id = ${M(NEW_MANAGER)}`;
      expect((await row())!.left_at).not.toBeNull();
    });
  });

  describe('RLS', () => {
    it('conversations and messages: participants only, never another tenant', async () => {
      const { conversation_id: id } = await open(BUYER, { post: POST });
      const read = (context: Context) =>
        withContext(app, context, async (tx) => ({
          conversations: (await tx`select id from conversations where id = ${id}`).length,
          messages: (await tx`select id from messages where conversation_id = ${id}`).length,
          tenantOf: (
            await tx<{ t: string | null }[]>`select public.conversation_tenant_of(${id}) as t`
          )[0]!.t,
        }));
      expect(await read(as(BUYER))).toMatchObject({ conversations: 1, tenantOf: TENANT_A });
      expect(await read(as(STRANGER))).toEqual({ conversations: 0, messages: 0, tenantOf: null });
      // The buyer's own user, but in tenant B's context: nothing there.
      expect(await read({ ...as(BUYER), tenant_id: TENANT_B })).toMatchObject({
        conversations: 0,
        messages: 0,
      });
      expect(await read(as(MOD_B, TENANT_B, 'moderator'))).toEqual({
        conversations: 0,
        messages: 0,
        tenantOf: null,
      });
    });

    it('store_quick_replies: owner and managers; editors, strangers and other tenants nothing', async () => {
      await withContext(
        app,
        as(OWNER),
        (tx) =>
          tx`insert into store_quick_replies (store_id, body, created_by_member_id)
           values (${STORE}, 'দাম আলোচনাসাপেক্ষ', ${M(OWNER)})`,
      );
      const count = (context: Context) =>
        withContext(app, context, (tx) =>
          tx`select id from store_quick_replies where store_id = ${STORE}`.then((r) => r.length),
        );
      expect(await count(as(OWNER))).toBe(1);
      expect(await count(as(MANAGER))).toBe(1);
      expect(await count(as(EDITOR))).toBe(0);
      expect(await count(as(STRANGER))).toBe(0);
      expect(await count({ ...as(OWNER), tenant_id: TENANT_B })).toBe(0);
      const strangerWrite = withContext(
        app,
        as(STRANGER),
        (tx) =>
          tx`insert into store_quick_replies (store_id, body, created_by_member_id)
           values (${STORE}, 'হ্যাক', ${M(STRANGER)})`,
      );
      expect(await rejection(strangerWrite)).toBe('42501');
      const crossTenant = withContext(
        app,
        { ...as(OWNER), tenant_id: TENANT_B },
        (tx) =>
          tx`insert into store_quick_replies (tenant_id, store_id, body, created_by_member_id)
           values (${TENANT_A}, ${STORE}, 'হ্যাক', ${M(OWNER)})`,
      );
      expect(await rejection(crossTenant)).toBe('42501');
    });

    it('a chat image row is readable by the participants, not by others', async () => {
      const { conversation_id: id } = await open(BUYER, { post: POST });
      await admin`
        insert into media_assets (id, tenant_id, uploaded_by_user_id, kind_code, visibility_code, storage_key,
                                  mime_type, byte_size, checksum_sha256, status_code)
        values (${IMAGE}, ${TENANT_A}, ${U(BUYER)}, 'chat_image', 'private', ${`${TENANT_A}/chat_image/x`},
                'image/jpeg', 10, ${'a'.repeat(64)}, 'ready')`;
      await withContext(
        app,
        as(BUYER),
        (tx) =>
          tx`insert into messages (conversation_id, sender_member_id, kind_code, media_asset_id, client_message_id)
           values (${id}, ${M(BUYER)}, 'image', ${IMAGE}, 'db-spec-image')`,
      );
      const sees = (context: Context) =>
        withContext(app, context, (tx) =>
          tx`select id from media_assets where id = ${IMAGE}`.then((r) => r.length),
        );
      expect(await sees(as(SELLER))).toBe(1);
      expect(await sees(as(STRANGER))).toBe(0);
      expect(await sees({ ...as(SELLER), tenant_id: TENANT_B })).toBe(0);
    });
  });

  describe('reports', () => {
    it('snapshots the transcript (deleted messages too), for this tenant’s staff only', async () => {
      const { conversation_id: id } = await open(BUYER, { post: OTHER_POST });
      await send(BUYER, id, 'হ্যালো');
      const rude = await send(SELLER, id, 'খারাপ কথা');
      await withContext(
        app,
        as(SELLER),
        (tx) => tx`update messages set deleted_at = now() where id = ${rude}`,
      );
      const report = () =>
        withContext(
          app,
          as(BUYER),
          (tx) =>
            tx<{ report_id: string; created: boolean }[]>`
            select report_id, created from public.report_conversation(${id}::uuid, 'harassment', 'গালি', 50)`,
        ).then((rows) => rows[0]!);
      const first = await report();
      expect(first.created).toBe(true);
      expect(await report()).toEqual({ report_id: first.report_id, created: false });

      const snapshot = (context: Context) =>
        withContext(
          app,
          context,
          (tx) =>
            tx<{ transcript: { id: string; body: string; deletedAt: string | null }[] }[]>`
            select transcript from conversation_report_snapshots where report_id = ${first.report_id}`,
        );
      const [mine] = await snapshot(as(MOD, TENANT_A, 'moderator'));
      expect(mine!.transcript.map((e) => e.body)).toEqual(['হ্যালো', 'খারাপ কথা']);
      expect(mine!.transcript[1]!.deletedAt).not.toBeNull();
      expect(await snapshot(as(MOD_B, TENANT_B, 'moderator'))).toEqual([]);
      expect(await snapshot(as(BUYER))).toEqual([]);
      const forged = withContext(
        app,
        as(MOD, TENANT_A, 'moderator'),
        (tx) =>
          tx`insert into conversation_report_snapshots (report_id, conversation_id, transcript, message_count)
           values (${first.report_id}, ${id}, '[]', 0)`,
      );
      expect(await rejection(forged)).toBe('42501');
    });

    it('a moderator lock writes moderation_actions in the same transaction; members can’t decide', async () => {
      const { conversation_id: id } = await open(STRANGER, { post: OTHER_POST });
      await send(STRANGER, id, 'স্প্যাম');
      const [reported] = await withContext(
        app,
        as(SELLER),
        (tx) =>
          tx<{ report_id: string }[]>`
          select report_id from public.report_conversation(${id}::uuid, 'spam', null, 50)`,
      );
      const reportId = reported!.report_id;
      const byMember = withContext(
        app,
        as(SELLER),
        (tx) =>
          tx`select * from public.decide_conversation_report(${reportId}::uuid, 'lock', 'spam', null)`,
      );
      expect(await rejection(byMember)).toBe('42501');
      const [decided] = await withContext(
        app,
        as(MOD, TENANT_A, 'moderator'),
        (tx) =>
          tx<{ action_id: string }[]>`
          select action_id from public.decide_conversation_report(${reportId}::uuid, 'lock', 'spam', 'বারবার')`,
      );
      const [action] = await admin<
        { conversation_id: string; action_code: string; xact_id: string }[]
      >`
        select conversation_id, action_code, xact_id::text from moderation_actions where id = ${decided!.action_id}`;
      expect(action).toMatchObject({ conversation_id: id, action_code: 'conversation_locked' });
      const [state] = await admin<{ is_locked: boolean; status: string; system: number }[]>`
        select c.is_locked, r.status_code as status,
               (select count(*)::int from messages m where m.conversation_id = c.id and m.kind_code = 'system') as system
        from conversations c join reports r on r.conversation_id = c.id where c.id = ${id}`;
      expect(state).toEqual({ is_locked: true, status: 'actioned', system: 1 });
      // Locked: nobody can send (messages_sender_insert, 0009).
      expect(await rejection(send(STRANGER, id, 'আবার'))).toBe('42501');
    });

    it('a dismissal is recorded too, and leaves the conversation open', async () => {
      const { conversation_id: id } = await open(BUYER, { store: STORE });
      const [reported] = await withContext(
        app,
        as(OWNER),
        (tx) =>
          tx<{ report_id: string }[]>`
          select report_id from public.report_conversation(${id}::uuid, 'other', null, 50)`,
      );
      const [decided] = await withContext(
        app,
        as(MOD, TENANT_A, 'moderator'),
        (tx) =>
          tx<{ action_id: string }[]>`
          select action_id
          from public.decide_conversation_report(${reported!.report_id}::uuid, 'dismiss', 'report_unfounded', null)`,
      );
      const [row] = await admin<{ action_code: string; status: string; is_locked: boolean }[]>`
        select ma.action_code, r.status_code as status, c.is_locked
        from moderation_actions ma
        join reports r on r.id = ${reported!.report_id}
        join conversations c on c.id = ma.conversation_id
        where ma.id = ${decided!.action_id}`;
      expect(row).toEqual({
        action_code: 'reports_dismissed',
        status: 'dismissed',
        is_locked: false,
      });
      // Another tenant's moderator can't decide it (no such open report there).
      const [again] = await withContext(
        app,
        as(OWNER),
        (tx) =>
          tx<{ report_id: string }[]>`
          select report_id from public.report_conversation(${id}::uuid, 'spam', null, 50)`,
      );
      const elsewhere = withContext(
        app,
        as(MOD_B, TENANT_B, 'moderator'),
        (tx) =>
          tx`select * from public.decide_conversation_report(${again!.report_id}::uuid, 'lock', 'spam', null)`,
      );
      expect(await rejection(elsewhere)).toBe('P0002');
    });
  });

  describe('Q46: a scrub severs every chat link to the post', () => {
    it('nulls the post’s conversations and neutralises its listing cards everywhere', async () => {
      const { conversation_id: about } = await open(BUYER, { post: POST });
      const { conversation_id: elsewhere } = await open(BUYER, { store: STORE });
      for (const [conversation, key] of [
        [about, 'q46-about'],
        [elsewhere, 'q46-elsewhere'],
      ] as const) {
        await withContext(
          app,
          as(BUYER),
          (tx) =>
            tx`insert into messages (conversation_id, sender_member_id, kind_code, listing_snapshot, client_message_id)
             values (${conversation}, ${M(BUYER)}, 'listing_card',
                     ${tx.json({ state: 'shared', postId: POST, title: 'চ্যাটের পণ্য' })}, ${key})`,
        );
      }
      await admin.begin(async (tx) => {
        await tx`
          insert into moderation_actions (tenant_id, post_id, actor_user_id, action_code, reason_code, reason_text, evidence_refs)
          values (${TENANT_A}, ${POST}, ${U(MOD)}, 'moderator_removed', 'spam', 'fixture', '["ev-1"]')`;
        await tx`select public.scrub_post(${POST}, 'spam', 'moderator_removed')`;
      });
      const [conversation] = await admin<
        { post_id: string | null; post_context_removed: boolean }[]
      >`
        select post_id, post_context_removed from conversations where id = ${about}`;
      expect(conversation).toEqual({ post_id: null, post_context_removed: true });
      const cards = await admin<{ listing_snapshot: unknown }[]>`
        select listing_snapshot from messages where client_message_id in ('q46-about', 'q46-elsewhere')`;
      expect(cards.map((c) => c.listing_snapshot)).toEqual([
        { state: 'listing_removed' },
        { state: 'listing_removed' },
      ]);
    });
  });
});
