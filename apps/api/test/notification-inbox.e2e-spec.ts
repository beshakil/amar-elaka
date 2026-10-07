import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/tokens/token.service';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * The in-app inbox (GET /notifications): only the caller's own, newest first,
 * paged; archived and expired ones never show; the unread badge; marking one
 * or all read; someone else's is a 404, never a read.
 */

const FIXTURE = '0191e3a0-1b0c-7000-8000-%';
const PARTNER = '0191e3a0-1b0c-7000-8000-000000000001';
const AREA = '0191e3a0-1b0c-7000-8000-000000000011';
const TENANT = '0191e3a0-1b0c-7000-8000-000000000021';
const ALICE = '0191e3a0-1b0c-7000-8000-000000000031';
const BOB = '0191e3a0-1b0c-7000-8000-000000000032';
const M_ALICE = '0191e3a0-1b0c-7000-8000-000000000041';
const M_BOB = '0191e3a0-1b0c-7000-8000-000000000042';
const square = 'SRID=4326;MULTIPOLYGON(((92.4 21.0,92.5 21.0,92.5 21.1,92.4 21.1,92.4 21.0)))';

interface Item {
  id: string;
  type: string;
  params: Record<string, string | null>;
  deepLink: string | null;
  read: boolean;
}
interface Page {
  items: Item[];
  nextCursor: string | null;
  unreadCount: number;
}

describe('Notification inbox (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: Sql;
  const tokens: Record<'alice' | 'bob', string> = { alice: '', bob: '' };

  let n = 0x1000;
  const note = async (
    userId: string,
    extra: { type?: string; read?: boolean; archived?: boolean; expired?: boolean } = {},
  ): Promise<string> => {
    const id = `0191e3a0-1b0c-7000-8000-${(n++).toString(16).padStart(12, '0')}`;
    await admin`
      insert into notifications (id, user_id, type_code, params, deep_link, read_at, archived_at, expires_at)
      values (${id}, ${userId}, ${extra.type ?? 'place_edit_approved'},
              ${admin.json({ placeId: 'p1', placeName: 'করিম ফার্মেসি', count: 3 })}, '/places/p1',
              ${extra.read ? new Date() : null}, ${extra.archived ? new Date() : null},
              ${extra.expired ? new Date(Date.now() - 60_000) : null})`;
    return id;
  };

  const call = <T>(method: 'GET' | 'POST', url: string, as?: 'alice' | 'bob') =>
    app
      .inject({
        method,
        url: `/api/v1${url}`,
        headers: {
          'x-tenant-id': TENANT,
          ...(as ? { authorization: `Bearer ${tokens[as]}` } : {}),
        },
      })
      .then((r) => ({ status: r.statusCode, body: (r.body ? r.json() : null) as T }));

  async function cleanUp(): Promise<void> {
    await admin`delete from notifications where user_id::text like ${FIXTURE}`;
    await admin`delete from tenant_members where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();
    await admin`insert into users (id, phone_e164) values (${ALICE}, '+8801788000001'), (${BOB}, '+8801788000002')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Inbox Partner', 'Inbox Partner', '+8801788000999')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release, boundary, boundary_simplified)
      values (${AREA}, 3, 'upazila', 'inbox-e2e', 'Inbox', 'fixture', ${square}, ${square})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values (${TENANT}, ${PARTNER}, ${AREA}, 'inbox-e2e', 'ই', 'I', 'SRID=4326;POINT(92.45 21.05)', 'active')`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code)
      values (${M_ALICE}, ${TENANT}, ${ALICE}, 'member'), (${M_BOB}, ${TENANT}, ${BOB}, 'member')`;

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
    tokens.alice = await signer.signAccessToken({
      userId: ALICE,
      tenantId: TENANT,
      memberId: M_ALICE,
      role: 'member',
    });
    tokens.bob = await signer.signAccessToken({
      userId: BOB,
      tenantId: TENANT,
      memberId: M_BOB,
      role: 'member',
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    try {
      await cleanUp();
    } finally {
      await admin.end();
    }
  });

  it("lists only the caller's own, newest first, paged, without archived or expired ones", async () => {
    const first = await note(ALICE, { type: 'post_approved', read: true });
    const second = await note(ALICE, { type: 'place_claim_approved' });
    const third = await note(ALICE);
    await note(ALICE, { archived: true });
    await note(ALICE, { expired: true });
    await note(BOB);

    const page1 = await call<Page>('GET', '/notifications?limit=2', 'alice');
    expect(page1.status).toBe(200);
    expect(page1.body.items.map((i) => i.id)).toEqual([third, second]);
    expect(page1.body.unreadCount).toBe(2);
    // Params come back as strings (the clients word the text from them).
    expect(page1.body.items[0]).toMatchObject({
      type: 'place_edit_approved',
      params: { placeName: 'করিম ফার্মেসি', count: '3' },
      deepLink: '/places/p1',
      read: false,
    });
    const page2 = await call<Page>(
      'GET',
      `/notifications?limit=2&cursor=${page1.body.nextCursor}`,
      'alice',
    );
    expect(page2.body.items.map((i) => i.id)).toEqual([first]);
    expect(page2.body.nextCursor).toBeNull();
    expect(
      (await call<{ unreadCount: number }>('GET', '/notifications/unread-count', 'bob')).body,
    ).toEqual({ unreadCount: 1 });
  });

  it("marks one read; someone else's is a 404 and stays unread", async () => {
    const mine = await note(ALICE);
    const bobs = await note(BOB);
    expect((await call('POST', `/notifications/${mine}/read`, 'alice')).status).toBe(204);
    // Again: still fine (idempotent).
    expect((await call('POST', `/notifications/${mine}/read`, 'alice')).status).toBe(204);
    const theirs = await call<{ error: string }>('POST', `/notifications/${bobs}/read`, 'alice');
    expect(theirs.status).toBe(404);
    expect(theirs.body.error).toBe('NOTIFICATION_NOT_FOUND');
    const [row] = await admin<{ read_at: Date | null }[]>`
      select read_at from notifications where id = ${bobs}`;
    expect(row!.read_at).toBeNull();
  });

  it('marks all read, and guests have no inbox', async () => {
    await note(ALICE);
    const res = await call<{ unreadCount: number }>('POST', '/notifications/read-all', 'alice');
    expect(res.body).toEqual({ unreadCount: 0 });
    expect(
      (await call<{ unreadCount: number }>('GET', '/notifications/unread-count', 'alice')).body
        .unreadCount,
    ).toBe(0);
    // Bob's are untouched.
    expect(
      (await call<{ unreadCount: number }>('GET', '/notifications/unread-count', 'bob')).body
        .unreadCount,
    ).toBeGreaterThan(0);
    expect((await call('GET', '/notifications')).status).toBe(401);
  });
});
