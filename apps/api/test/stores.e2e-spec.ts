import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/tokens/token.service';
import { SearchCliModule } from '../src/search/cli/search-cli.module';
import { SearchIndexingModule } from '../src/search/indexing/search-indexing.module';
import { SearchIndexer } from '../src/search/indexing/search-indexer.service';
import { SearchOutboxRelay } from '../src/search/indexing/search-outbox.relay';
import { SettingsModule } from '../src/settings/settings.module';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';
import { startNotificationWorker, type NotificationWorker } from './support/notification-worker';

/**
 * The stores module end to end (ADR 054): create (slug, pin, hours), the
 * public page, staff and their permissions, slug uniqueness and the one
 * slug change, posting as a store, the contact endpoint, and a suspended
 * store leaving the feed, search and the map with its posts.
 */

const FIXTURE = '0191e3a0-a0b7-7000-8000-%';
const PARTNER = '0191e3a0-a0b7-7000-8000-000000000001';
const AREA_A = '0191e3a0-a0b7-7000-8000-000000000011';
const AREA_B = '0191e3a0-a0b7-7000-8000-000000000012';
const TENANT_A = '0191e3a0-a0b7-7000-8000-000000000021';
const TENANT_B = '0191e3a0-a0b7-7000-8000-000000000022';
const OWNER = '0191e3a0-a0b7-7000-8000-000000000031';
const MANAGER = '0191e3a0-a0b7-7000-8000-000000000032';
const EDITOR = '0191e3a0-a0b7-7000-8000-000000000033';
const STRANGER = '0191e3a0-a0b7-7000-8000-000000000034';
const MOD = '0191e3a0-a0b7-7000-8000-000000000035';
const M_OWNER = '0191e3a0-a0b7-7000-8000-000000000041';
const M_MANAGER = '0191e3a0-a0b7-7000-8000-000000000042';
const M_EDITOR = '0191e3a0-a0b7-7000-8000-000000000043';
const M_STRANGER = '0191e3a0-a0b7-7000-8000-000000000044';
const M_MOD = '0191e3a0-a0b7-7000-8000-000000000045';
const PLACE_CATEGORY = '0191e3a0-a0b7-7000-8000-000000000051';
const POST_CATEGORY = '0191e3a0-a0b7-7000-8000-000000000052';
const SCHEMA = '0191e3a0-a0b7-7000-8000-000000000061';

const PHONES = {
  owner: '+8801777300001',
  manager: '+8801777300002',
  editor: '+8801777300003',
  stranger: '+8801777300004',
  mod: '+8801777300005',
  newcomer: '+8801777300006',
  store: '+8801777300010',
};

const square = (west: number, east: number) =>
  `SRID=4326;MULTIPOLYGON(((${west} 25.5,${east} 25.5,${east} 25.6,${west} 25.6,${west} 25.5)))`;
const SHOP = { lat: 25.55, lng: 88.55 };
const IN_B = { lat: 25.55, lng: 88.75 };
const ALL_WEEK = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, opens: '00:00', closes: '00:00' }));

type Role = 'owner' | 'manager' | 'editor' | 'stranger' | 'mod';

interface StoreView {
  id: string;
  slug: string;
  previousSlug: string | null;
  slugChangeable: boolean;
  status: string;
  tier: string;
  placeId: string | null;
  phone: string | null;
  myRole: string;
  limits: { staff: number; catalog: number };
  counts: { staff: number; catalog: number };
  staff: { memberId: string; role: string; accepted: boolean; phoneMasked: string | null }[];
}

describe('Stores (e2e)', () => {
  /** Notifications are queued (ADR 059): dispatched here before a test looks. */
  let queued: NotificationWorker;
  let app: NestFastifyApplication;
  let worker: TestingModule;
  let relay: SearchOutboxRelay;
  let admin: Sql;
  const tokens = {} as Record<Role, string>;
  let store: StoreView;
  let livePostId: string;

  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    as?: Role,
    body?: unknown,
    tenant = TENANT_A,
  ) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { 'x-tenant-id': tenant, ...(as ? { authorization: `Bearer ${tokens[as]}` } : {}) },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });

  /** Our search events are processed (other suites may hold a lease on them for a while). */
  const drain = async () => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      while ((await relay.relay()) > 0);
      const [pending] = await admin<{ n: string }[]>`
        select count(*) as n from outbox_events
        where processed_at is null and event_type like 'search.%' and aggregate_id::text like ${FIXTURE}`;
      if (Number(pending!.n) === 0) return;
      if (Date.now() > deadline) throw new Error(`${pending!.n} search events never processed`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  async function cleanUp(): Promise<void> {
    const tenants = [TENANT_A, TENANT_B];
    const ids = (
      await admin<{ id: string }[]>`
        select id from posts where tenant_id in ${admin(tenants)}
        union all select id from stores where tenant_id in ${admin(tenants)}
        union all select id from places where tenant_id in ${admin(tenants)}`
    ).map((r) => r.id);
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from moderation_actions where tenant_id in ${tx(tenants)}`;
      await tx`delete from lead_events where tenant_id in ${tx(tenants)}`;
      await tx`delete from search_queries where tenant_id in ${tx(tenants)}`;
      await tx`delete from notifications where entity_id in ${tx(ids.length > 0 ? ids : [PARTNER])}`;
      await tx`delete from duplicate_candidates where tenant_id in ${tx(tenants)}`;
      await tx`delete from media_attachments where tenant_id in ${tx(tenants)}`;
      await tx`delete from posts where tenant_id in ${tx(tenants)}`;
      await tx`delete from store_hours where tenant_id in ${tx(tenants)}`;
      await tx`delete from store_members where tenant_id in ${tx(tenants)}`;
      await tx`delete from place_revisions where tenant_id in ${tx(tenants)}`;
      await tx`delete from places where tenant_id in ${tx(tenants)}`;
      await tx`delete from stores where tenant_id in ${tx(tenants)}`;
      await tx`delete from member_trust_scores where tenant_id in ${tx(tenants)}`;
      await tx`delete from tenant_categories where tenant_id in ${tx(tenants)}`;
      await tx`delete from tenant_members where tenant_id in ${tx(tenants)}`;
      await tx`delete from tenant_settings where tenant_id in ${tx(tenants)}`;
    });
    if (ids.length > 0) await admin`delete from outbox_events where aggregate_id in ${admin(ids)}`;
    await admin`delete from category_field_schemas where category_id::text like ${FIXTURE}`;
    await admin`delete from categories where id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from user_profiles where user_id in (select id from users where phone_e164 = ${PHONES.newcomer})`;
    await admin`delete from users where id::text like ${FIXTURE} or phone_e164 = ${PHONES.newcomer}`;
  }

  beforeAll(async () => {
    queued = await startNotificationWorker();
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();
    await admin`
      insert into users (id, phone_e164) values
        (${OWNER}, ${PHONES.owner}), (${MANAGER}, ${PHONES.manager}), (${EDITOR}, ${PHONES.editor}),
        (${STRANGER}, ${PHONES.stranger}), (${MOD}, ${PHONES.mod})`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Stores E2E', 'Stores E2E', '+8801777300099')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release, boundary, boundary_simplified)
      values (${AREA_A}, 3, 'upazila', 'stores-e2e-a', 'Stores E2E A', 'fixture', ${square(88.5, 88.6)}, ${square(88.5, 88.6)}),
             (${AREA_B}, 3, 'upazila', 'stores-e2e-b', 'Stores E2E B', 'fixture', ${square(88.7, 88.8)}, ${square(88.7, 88.8)})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code, timezone)
      values (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'stores-e2e-a', 'দোকান এ', 'Stores A', st_point(88.55, 25.55)::geography, 'active', 'Asia/Dhaka'),
             (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'stores-e2e-b', 'দোকান বি', 'Stores B', st_point(88.75, 25.55)::geography, 'active', 'Asia/Dhaka')`;
    await admin.begin(async (tx) => {
      // A new member's store goes live (trust gate 0); posts go live after review is skipped;
      // a store card after every post. Platform-scope overrides, so platform staff only.
      await tx`select set_config('app.role', 'platform_admin', true)`;
      const overrides = {
        place_contribution_trust_threshold: 0,
        trust_auto_approve_threshold: 0,
        moderation_sample_rate_percent: 0,
        feed_store_card_interval: 1,
        hours_opens_soon_minutes: 0,
        // Room for one more editor than the two the tests invite first.
        store_staff_max_basic: 3,
      };
      await tx`
        insert into tenant_settings (tenant_id, post_moderation_mode_code, setting_overrides)
        values (${TENANT_A}, 'post', ${tx.json(overrides)}), (${TENANT_B}, 'post', ${tx.json(overrides)})`;
    });
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${M_OWNER}, ${TENANT_A}, ${OWNER}, 'member'), (${M_MANAGER}, ${TENANT_A}, ${MANAGER}, 'member'),
        (${M_EDITOR}, ${TENANT_A}, ${EDITOR}, 'member'), (${M_STRANGER}, ${TENANT_A}, ${STRANGER}, 'member'),
        (${M_MOD}, ${TENANT_A}, ${MOD}, 'moderator')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en)
      values (${PLACE_CATEGORY}, 'place', 'stores-e2e-shop', 'দোকান', 'Shop')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en, default_moderation_mode_code, default_post_expiry_days)
      values (${POST_CATEGORY}, 'marketplace', 'stores-e2e-sale', 'বিক্রি', 'Sale', 'post', 30)`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, ui_schema, status_code, published_at)
      values (${SCHEMA}, ${POST_CATEGORY}, 1, ${admin.json({
        type: 'object',
        additionalProperties: false,
        properties: {
          price: {
            'x-field-type': 'money',
            type: 'string',
            'x-money-min': '1.00',
            'x-money-max': '100000.00',
          },
        },
        required: ['price'],
      })}, ${admin.json({ order: ['price'], labels: { price: { bn: 'দাম', en: 'Price' } } })}, 'published', now())`;
    await admin`
      insert into tenant_categories (tenant_id, category_id, is_enabled) values
        (${TENANT_A}, ${PLACE_CATEGORY}, true), (${TENANT_A}, ${POST_CATEGORY}, true),
        (${TENANT_B}, ${PLACE_CATEGORY}, true), (${TENANT_B}, ${POST_CATEGORY}, true)`;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api', {
      exclude: [
        { path: 'health/live', method: RequestMethod.GET },
        { path: 'health/ready', method: RequestMethod.GET },
      ],
    });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const signer = moduleRef.get(TokenService);
    for (const [role, userId, memberId, appRole] of [
      ['owner', OWNER, M_OWNER, 'member'],
      ['manager', MANAGER, M_MANAGER, 'member'],
      ['editor', EDITOR, M_EDITOR, 'member'],
      ['stranger', STRANGER, M_STRANGER, 'member'],
      ['mod', MOD, M_MOD, 'moderator'],
    ] as const) {
      tokens[role] = await signer.signAccessToken({
        userId,
        tenantId: TENANT_A,
        memberId,
        role: appRole,
      });
    }

    worker = await Test.createTestingModule({
      imports: [SearchCliModule, SearchIndexingModule, SettingsModule],
      providers: [SearchOutboxRelay],
    }).compile();
    await worker.init();
    await worker.get(SearchIndexer).applySettings();
    relay = worker.get(SearchOutboxRelay);
  }, 120_000);

  afterAll(async () => {
    await queued?.close();
    try {
      await cleanUp();
      if (relay) await drain();
    } finally {
      await admin.end();
      await worker?.close();
      await app?.close();
    }
  }, 60_000);

  // ---- create and the public page ----------------------------------------------

  it('creates a store: Latin slug from the Bengali name, active, its own map pin, hours', async () => {
    const response = await call('POST', '/stores', 'owner', {
      nameBn: 'রহিম স্টোর',
      description: 'চাল, ডাল, তেল',
      categoryId: PLACE_CATEGORY,
      phone: '01777300010',
      location: SHOP,
      hours: ALL_WEEK,
    });
    expect(response.statusCode).toBe(201);
    store = response.json<StoreView>();
    expect(store).toMatchObject({
      slug: 'rohim-stor',
      status: 'active',
      tier: 'basic',
      myRole: 'owner',
      slugChangeable: true,
      phone: PHONES.store,
    });
    expect(store.placeId).not.toBeNull();
    expect(store.limits.staff).toBeGreaterThan(0);

    // The pin is claimed by the owner, linked to the store and never carries the phone.
    const [pin] = await admin<
      {
        claim_store_id: string;
        claimed_by_member_id: string;
        phones: string[];
        status_code: string;
      }[]
    >`
      select claim_store_id, claimed_by_member_id, phones, status_code from places where id = ${store.placeId}`;
    expect(pin).toEqual({
      claim_store_id: store.id,
      claimed_by_member_id: M_OWNER,
      phones: [],
      status_code: 'published',
    });
  });

  it('the public page: hours with the open state, stats, badge, pin — and no phone', async () => {
    const response = await call('GET', `/stores/${store.slug}`);
    expect(response.statusCode).toBe(200);
    const page = response.json<{
      id: string;
      hours: { openState: { state: string } | null };
      stats: { followers: number; livePosts: number; memberSince: string };
      verification: { badge: string };
      mapPin: { placeId: string | null } | null;
      category: { slug: string } | null;
      posts: unknown[];
    }>();
    expect(page.id).toBe(store.id);
    expect(page.hours.openState?.state).toBe('open');
    expect(page.stats).toMatchObject({ followers: 0, livePosts: 0 });
    expect(page.verification.badge).toBe('none');
    expect(page.mapPin?.placeId).toBe(store.placeId);
    expect(page.category?.slug).toBe('stores-e2e-shop');
    expect(response.body).not.toContain('1777300010');
  });

  // ---- slugs -------------------------------------------------------------------

  it('slugs are unique per tenant, not across tenants', async () => {
    const twin = {
      nameBn: 'রহিম স্টোর',
      categoryId: PLACE_CATEGORY,
      location: { lat: SHOP.lat + 0.01, lng: SHOP.lng + 0.01 },
      confirmNotDuplicate: true,
    };
    const taken = await call('POST', '/stores', 'stranger', { ...twin, slug: 'rohim-stor' });
    expect(taken.statusCode).toBe(409);
    expect(taken.json<{ error: string }>().error).toBe('STORE_SLUG_TAKEN');

    // Left to the name, the second one gets a free slug of its own.
    const generated = await call('POST', '/stores', 'stranger', twin);
    expect(generated.statusCode).toBe(201);
    expect(generated.json<StoreView>().slug).toMatch(/^rohim-stor-[a-z0-9]{4}$/);

    // Another area may use the same slug. Asked from area A, the store
    // belongs to area B, where its location is (the same rule as posts).
    const elsewhere = await call('POST', '/stores', 'owner', {
      nameBn: 'রহিম স্টোর',
      categoryId: PLACE_CATEGORY,
      location: IN_B,
      slug: 'rohim-stor',
    });
    expect(elsewhere.statusCode).toBe(201);
    expect(elsewhere.json<StoreView>()).toMatchObject({ slug: 'rohim-stor' });
    const [row] = await admin<{ tenant_id: string }[]>`
      select tenant_id from stores where id = ${elsewhere.json<StoreView>().id}`;
    expect(row!.tenant_id).toBe(TENANT_B);
  });

  it("refuses 'me' and badly formed slugs", async () => {
    const bad = await call('PATCH', `/stores/${store.id}`, 'owner', { slug: 'review-queue' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json<{ error: string }>().error).toBe('STORE_SLUG_INVALID');
    expect(
      (await call('PATCH', `/stores/${store.id}`, 'owner', { slug: 'Rahim Store' })).statusCode,
    ).toBe(422);
  });

  // ---- staff ---------------------------------------------------------------------

  it('the owner invites a manager and an editor by phone; they accept', async () => {
    const manager = await call('POST', `/stores/${store.id}/staff`, 'owner', {
      phone: '01777300002',
      role: 'manager',
    });
    expect(manager.statusCode).toBe(201);
    expect(manager.json()).toMatchObject({ memberId: M_MANAGER, role: 'manager', accepted: false });
    expect(manager.json<{ phoneMasked: string }>().phoneMasked).not.toContain('300002');
    const editor = await call('POST', `/stores/${store.id}/staff`, 'owner', {
      phone: PHONES.editor,
      role: 'editor',
    });
    expect(editor.statusCode).toBe(201);

    // The invitation is in "my stores" and the inbox until accepted.
    const mine = (await call('GET', '/stores/me', 'editor')).json<{
      items: { id: string; role: string; accepted: boolean }[];
    }>();
    expect(mine.items).toContainEqual(
      expect.objectContaining({ id: store.id, role: 'editor', accepted: false }),
    );
    await queued.dispatch((n) => n.userId === EDITOR);
    const [note] = await admin<{ n: string }[]>`
      select count(*) as n from notifications where user_id = ${EDITOR} and type_code = 'store_staff_invited'`;
    expect(Number(note!.n)).toBe(1);

    expect((await call('POST', `/stores/${store.id}/staff/accept`, 'manager')).statusCode).toBe(
      200,
    );
    expect((await call('POST', `/stores/${store.id}/staff/accept`, 'editor')).statusCode).toBe(200);
    expect((await call('POST', `/stores/${store.id}/staff/accept`, 'stranger')).statusCode).toBe(
      404,
    );
  });

  it('an editor cannot change store settings, hours, staff or the slug', async () => {
    const forbidden = await call('PATCH', `/stores/${store.id}`, 'editor', { description: 'নতুন' });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json<{ error: string }>().error).toBe('STORE_ACTION_FORBIDDEN');
    expect(
      (await call('PUT', `/stores/${store.id}/hours`, 'editor', { weekly: [] })).statusCode,
    ).toBe(403);
    expect(
      (await call('POST', `/stores/${store.id}/closed-today`, 'editor', { closed: true }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await call('POST', `/stores/${store.id}/staff`, 'editor', {
          phone: PHONES.stranger,
          role: 'editor',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await call('PATCH', `/stores/${store.id}`, 'editor', { slug: 'rahim-store' })).statusCode,
    ).toBe(403);

    // Nor see the staff list.
    const view = (await call('GET', `/stores/${store.id}/manage`, 'editor')).json<StoreView>();
    expect(view.myRole).toBe('editor');
    expect(view.staff).toEqual([]);
  });

  it('a manager edits the store and invites editors, but not managers, the slug or the owner', async () => {
    const edited = await call('PATCH', `/stores/${store.id}`, 'manager', {
      description: 'চাল, ডাল, তেল, চিনি',
      nameEn: 'Rahim Store',
    });
    expect(edited.statusCode).toBe(200);
    // The pin follows the store.
    const [pin] = await admin<
      { name_en: string }[]
    >`select name_en from places where id = ${store.placeId}`;
    expect(pin!.name_en).toBe('Rahim Store');

    expect(
      (
        await call('POST', `/stores/${store.id}/staff`, 'manager', {
          phone: PHONES.stranger,
          role: 'manager',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await call('PATCH', `/stores/${store.id}`, 'manager', { slug: 'rahim-store' })).statusCode,
    ).toBe(403);
    expect(
      (await call('DELETE', `/stores/${store.id}/staff/${M_MANAGER}`, 'editor')).statusCode,
    ).toBe(403);

    // A brand-new number: an account is made for it, the invitation waits.
    const newcomer = await call('POST', `/stores/${store.id}/staff`, 'manager', {
      phone: PHONES.newcomer,
      role: 'editor',
    });
    expect(newcomer.statusCode).toBe(201);
    const [account] = await admin<{ phone_verified_at: Date | null }[]>`
      select phone_verified_at from users where phone_e164 = ${PHONES.newcomer}`;
    expect(account!.phone_verified_at).toBeNull();

    // Three staff (invited or accepted) is this area's basic-tier limit.
    const full = await call('POST', `/stores/${store.id}/staff`, 'owner', {
      phone: PHONES.stranger,
      role: 'editor',
    });
    expect(full.statusCode).toBe(409);
    expect(full.json<{ error: string }>().error).toBe('STORE_STAFF_LIMIT_REACHED');
  });

  it('the limits come from the basic tier’s settings (with the area’s override)', async () => {
    const view = (await call('GET', `/stores/${store.id}/manage`, 'owner')).json<StoreView>();
    const [catalog] = await admin<{ value: number }[]>`
      select value::int as value from platform_settings where key = 'store_catalog_max_basic'`;
    expect(view.limits).toEqual({ staff: 3, catalog: catalog!.value });
    expect(view.counts.staff).toBe(3);
    expect(view.staff.map((s) => s.role).sort()).toEqual(['editor', 'editor', 'manager']);
  });

  it('the owner changes the slug once; the old link still finds the store', async () => {
    const changed = await call('PATCH', `/stores/${store.id}`, 'owner', { slug: 'rahim-store' });
    expect(changed.statusCode).toBe(200);
    expect(changed.json<StoreView>()).toMatchObject({
      slug: 'rahim-store',
      previousSlug: 'rohim-stor',
      slugChangeable: false,
    });
    const old = await call('GET', '/stores/rohim-stor');
    expect(old.statusCode).toBe(200);
    expect(old.json<{ slug: string }>().slug).toBe('rahim-store');

    const again = await call('PATCH', `/stores/${store.id}`, 'owner', { slug: 'rahim-store-2' });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: string }>().error).toBe('STORE_SLUG_ALREADY_CHANGED');
    store = changed.json<StoreView>();
  });

  // ---- posting as the store ------------------------------------------------------

  const postAs = (as: Role, storeId: string, location = SHOP, title = 'দোকানের চাল ৫০ কেজি') =>
    call('POST', '/posts', as, {
      categoryId: POST_CATEGORY,
      title,
      fields: { price: '2500.00' },
      location,
      storeId,
      submit: true,
    });

  it('posting as a store needs the owner or accepted staff', async () => {
    const stranger = await postAs('stranger', store.id);
    expect(stranger.statusCode).toBe(403);
    expect(stranger.json<{ error: string }>().error).toBe('STORE_MEMBERSHIP_REQUIRED');

    const outside = await postAs('editor', store.id, IN_B);
    expect(outside.statusCode).toBe(422);
    expect(outside.json<{ error: string }>().error).toBe('POST_STORE_OUTSIDE_AREA');

    const editor = await postAs('editor', store.id, SHOP, 'রহিম স্টোরের মিনিকেট চাল');
    expect(editor.statusCode).toBe(201);
    livePostId = editor.json<{ id: string }>().id;
    const [row] = await admin<
      { store_id: string; status_code: string; author_member_id: string }[]
    >`
      select store_id, status_code, author_member_id from posts where id = ${livePostId}`;
    expect(row).toEqual({ store_id: store.id, status_code: 'live', author_member_id: M_EDITOR });

    const page = (await call('GET', `/stores/${store.slug}`)).json<{
      stats: { livePosts: number };
      posts: { id: string }[];
      catalogCategories: { slug: string; count: number }[];
    }>();
    expect(page.stats.livePosts).toBe(1);
    expect(page.posts.map((p) => p.id)).toEqual([livePostId]);
    expect(page.catalogCategories).toEqual([
      expect.objectContaining({ slug: 'stores-e2e-sale', count: 1 }),
    ]);
    const filtered = (await call('GET', `/stores/${store.slug}?category=stores-e2e-shop`)).json<{
      posts: unknown[];
    }>();
    expect(filtered.posts).toEqual([]);
  });

  // ---- contact ----------------------------------------------------------------------

  it("a store's number leaves only through its contact endpoint, which records a lead", async () => {
    const preview = await call('GET', `/map/features/stores/${store.id}?tenant=${TENANT_A}`);
    expect(preview.statusCode).toBe(200);
    expect(preview.json<{ phones: string[] }>().phones).toEqual([]);

    const reveal = await call('POST', `/stores/${store.id}/contact`, 'stranger', {
      channel: 'call',
    });
    expect(reveal.statusCode).toBe(200);
    expect(reveal.json()).toMatchObject({ phone: PHONES.store, href: `tel:${PHONES.store}` });
    const [lead] = await admin<{ n: string }[]>`
      select count(*) as n from lead_events where store_id = ${store.id} and post_id is null and source_code = 'store_page'`;
    expect(Number(lead!.n)).toBe(1);

    expect(
      (await call('POST', `/stores/${store.id}/contact`, 'owner', { channel: 'call' })).statusCode,
    ).toBe(409);
    // No WhatsApp number: that channel isn't offered.
    const whatsapp = await call('POST', `/stores/${store.id}/contact`, 'stranger', {
      channel: 'whatsapp',
    });
    expect(whatsapp.json<{ error: string }>().error).toBe('CONTACT_CHANNEL_UNAVAILABLE');
  });

  // ---- suspension ---------------------------------------------------------------------

  const feedIds = async (lng: number) =>
    (
      await app.inject({
        method: 'GET',
        url: '/api/v1/feed',
        query: { lat: String(SHOP.lat), lng: String(lng), scope: 'nearby', radius_km: '5' },
        headers: { 'x-tenant-id': TENANT_A },
      })
    )
      .json<{ items: { kind: string; id: string }[] }>()
      .items.map((i) => i.id);
  // The map's answers are cached per viewport (map_features_cache_seconds): a
  // second look uses a slightly different box.
  const mapIds = async (pad: number) =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/v1/map/features?bbox=${SHOP.lng - pad},${SHOP.lat - pad},${SHOP.lng + pad},${SHOP.lat + pad}&zoom=18&layers=posts,stores,places`,
        headers: { 'x-tenant-id': TENANT_A },
      })
    )
      .json<{ features: { properties: { id: string; layer: string } }[] }>()
      .features.map((f) => f.properties);
  const searchIds = async (type: 'posts' | 'stores', q: string) =>
    (
      await app.inject({
        method: 'GET',
        url: '/api/v1/search',
        query: { q, type, lat: String(SHOP.lat), lng: String(SHOP.lng), scope: 'nearby' },
        headers: { 'x-tenant-id': TENANT_A },
      })
    )
      .json<{ hits: { id: string }[] }>()
      .hits.map((h) => h.id);

  it('the store is one pin on the map (the store), and its post is on the map, feed and search', async () => {
    const features = await mapIds(0.002);
    expect(features).toContainEqual({
      ...features.find((f) => f.id === store.id),
      layer: 'stores',
    });
    expect(features.map((f) => f.id)).not.toContain(store.placeId);
    expect(features.map((f) => f.id)).toContain(livePostId);
    expect(await feedIds(SHOP.lng)).toEqual(expect.arrayContaining([livePostId, store.id]));
    await drain();
    expect(await searchIds('posts', 'মিনিকেট')).toContain(livePostId);
    expect(await searchIds('stores', 'rahim')).toContain(store.id);
  });

  it('a suspended store and its posts vanish from the feed, search and the map', async () => {
    expect(
      (
        await call('POST', `/stores/${store.id}/status`, 'owner', {
          status: 'suspended',
          reasonCode: 'scam_suspected',
        })
      ).statusCode,
    ).toBe(403);
    const suspended = await call('POST', `/stores/${store.id}/status`, 'mod', {
      status: 'suspended',
      reasonCode: 'scam_suspected',
      reasonText: 'অনেক অভিযোগ',
    });
    expect(suspended.statusCode).toBe(200);
    const [action] = await admin<{ action_code: string; reason_code: string }[]>`
      select action_code, reason_code from moderation_actions where store_id = ${store.id}`;
    expect(action).toEqual({ action_code: 'store_suspended', reason_code: 'scam_suspected' });
    const [post] = await admin<{ store_hidden: boolean; status_code: string }[]>`
      select store_hidden, status_code from posts where id = ${livePostId}`;
    // Hidden by its store, not unpublished: its own lifecycle is untouched.
    expect(post).toEqual({ store_hidden: true, status_code: 'live' });

    const features = (await mapIds(0.003)).map((f) => f.id);
    expect(features).not.toContain(store.id);
    expect(features).not.toContain(livePostId);
    expect(features).not.toContain(store.placeId);
    // Another viewer position: the feed is cached per geohash cell.
    const feed = await feedIds(SHOP.lng + 0.01);
    expect(feed).not.toContain(livePostId);
    expect(feed).not.toContain(store.id);
    await drain();
    expect(await searchIds('posts', 'মিনিকেট')).not.toContain(livePostId);
    expect(await searchIds('stores', 'rahim')).not.toContain(store.id);
    expect((await call('GET', `/stores/${store.slug}`)).statusCode).toBe(404);

    // Nobody posts as a suspended store.
    expect((await postAs('editor', store.id)).statusCode).toBe(409);
  });

  it('reinstating brings the store and its posts back', async () => {
    const reinstated = await call('POST', `/stores/${store.id}/status`, 'mod', {
      status: 'active',
      reasonCode: 'meets_guidelines',
    });
    expect(reinstated.statusCode).toBe(200);
    expect((await mapIds(0.004)).map((f) => f.id)).toEqual(
      expect.arrayContaining([store.id, livePostId]),
    );
    await drain();
    expect(await searchIds('posts', 'মিনিকেট')).toContain(livePostId);
    const [n] = await admin<{ n: string }[]>`
      select count(*) as n from moderation_actions where store_id = ${store.id}`;
    expect(Number(n!.n)).toBe(2);
  });

  it('staff may leave on their own', async () => {
    expect(
      (await call('DELETE', `/stores/${store.id}/staff/${M_EDITOR}`, 'editor')).statusCode,
    ).toBe(204);
    expect((await postAs('editor', store.id)).statusCode).toBe(403);
  });
});
