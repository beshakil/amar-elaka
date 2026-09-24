import {
  Body,
  Controller,
  Delete,
  Get,
  Module,
  Param,
  Patch,
  Post,
  RequestMethod,
  VersioningType,
} from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/tokens/token.service';
import type { AppRole } from '../src/database/tenant-context';
import { PermissionsService } from '../src/rbac/permissions.service';
import { RbacModule } from '../src/rbac/rbac.module';
import { RequireOwnership } from '../src/rbac/require-ownership.decorator';
import { RequirePermission } from '../src/rbac/require-permission.decorator';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * Full-stack proof of the role & permission system: real Postgres+Redis,
 * one member per built-in role plus one custom-role member, exercised
 * through a small probe controller (mirrors test/tenant-context.e2e-spec.ts's
 * pattern of testing generic guards without a real feature route — no
 * posts/campaigns/etc. controller exists yet, on purpose, this phase).
 */

@Controller({ path: 'probe', version: '1' })
class ProbeController {
  @Get('posts') @RequirePermission('posts', 'read') postsRead() {
    return { ok: true };
  }
  @Post('posts') @RequirePermission('posts', 'write') postsWrite() {
    return { ok: true };
  }
  @Post('posts/:id/approve') @RequirePermission('posts', 'approve') postsApprove() {
    return { ok: true };
  }
  @Delete('posts/:id') @RequirePermission('posts', 'delete') postsDelete() {
    return { ok: true };
  }
  @Get('campaigns') @RequirePermission('campaigns', 'read') campaignsRead() {
    return { ok: true };
  }
  @Post('campaigns') @RequirePermission('campaigns', 'write') campaignsWrite() {
    return { ok: true };
  }
  @Get('analytics') @RequirePermission('analytics', 'read') analyticsRead() {
    return { ok: true };
  }
  @Get('users') @RequirePermission('users', 'read') usersRead() {
    return { ok: true };
  }
  @Post('users') @RequirePermission('users', 'write') usersWrite() {
    return { ok: true };
  }
  @Get('stores') @RequirePermission('stores', 'read') storesRead() {
    return { ok: true };
  }
  @Patch('stores/:id')
  @RequirePermission('stores', 'write')
  @RequireOwnership({ table: 'stores', ownerColumn: 'owner_member_id', idParam: 'id' })
  storesEditOwn(@Param('id') id: string, @Body() body: unknown) {
    return { ok: true, id, body };
  }
}

// Imports RbacModule so PermissionGuard/OwnershipGuard (used internally by
// @RequirePermission()/@RequireOwnership()) are resolvable in this module's
// own DI scope — exactly what a real future feature module would need too.
@Module({ imports: [RbacModule], controllers: [ProbeController] })
class ProbeModule {}

const PARTNER = '0191e3a0-dddd-7000-8000-0000000000d9';
const GEO_AREA_A = '0191e3a0-dddd-7000-8000-0000000000e1';
const GEO_AREA_B = '0191e3a0-dddd-7000-8000-0000000000e2';
const TENANT_A = '0191e3a0-dddd-7000-8000-00000000000a';
const TENANT_B = '0191e3a0-dddd-7000-8000-00000000000b';
const FIXTURE_PREFIX = '0191e3a0-dddd-7000-8000-%';
const RUN_ID = Date.now().toString().slice(-6);

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+88017${RUN_ID}${phoneCounter.toString().padStart(2, '0')}`;
}

interface FixtureMember {
  userId: string;
  memberId: string;
  roleCode: string;
  token: string;
}

describe('Role & permission system (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: Sql;
  let tokens: TokenService;
  let permissions: PermissionsService;
  const members: Record<string, FixtureMember> = {};

  async function createMember(
    tenantId: string,
    roleCode: AppRole,
    customRoleId?: string,
  ): Promise<FixtureMember> {
    const phone = nextPhone();
    const [user] = await admin<{ id: string }[]>`
      insert into users (phone_e164, phone_verified_at) values (${phone}, now()) returning id`;
    const [member] = await admin<{ id: string }[]>`
      insert into tenant_members (tenant_id, user_id, role_code, custom_role_id)
      values (${tenantId}, ${user!.id}, ${roleCode}, ${customRoleId ?? null})
      returning id`;
    const token = await tokens.signAccessToken({
      userId: user!.id,
      tenantId,
      memberId: member!.id,
      role: roleCode,
    });
    return { userId: user!.id, memberId: member!.id, roleCode, token };
  }

  function authHeaders(role: string): Record<string, string> {
    return { authorization: `Bearer ${members[role]!.token}`, 'x-tenant-id': TENANT_A };
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());

    await admin`
      insert into partners (id, legal_name, display_name, phone_e164) values
        (${PARTNER}, 'RBAC E2E Partner Ltd.', 'RBAC E2E Partner', '+8801911000069')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
        (${GEO_AREA_A}, 3, 'upazila', 'rbac-e2e-a', 'RBAC E2E Area A', 'fixture'),
        (${GEO_AREA_B}, 3, 'upazila', 'rbac-e2e-b', 'RBAC E2E Area B', 'fixture')`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
        (${TENANT_A}, ${PARTNER}, ${GEO_AREA_A}, 'rbac-e2e-tenant-a', 'এ', 'A', st_point(90.4, 23.8)::geography, 'active'),
        (${TENANT_B}, ${PARTNER}, ${GEO_AREA_B}, 'rbac-e2e-tenant-b', 'বি', 'B', st_point(90.5, 23.9)::geography, 'active')`;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, ProbeModule],
    }).compile();
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

    tokens = moduleRef.get(TokenService);
    permissions = moduleRef.get(PermissionsService);

    const tenantRoles: AppRole[] = [
      'tenant_admin',
      'moderator',
      'marketer',
      'executive',
      'seller',
      'member',
    ];
    for (const role of tenantRoles) {
      members[role] = await createMember(TENANT_A, role);
    }
    // A moderator who exists ONLY in tenant A — the cross-tenant proof needs this exact user absent from tenant B.
    members.moderatorOnlyInA = members.moderator!;

    // platform_admin is a global users.platform_role_code attribute, not a
    // tenant_members row — the JWT's own `role` claim is irrelevant for it,
    // since PermissionsService verifies platform_role_code fresh from the DB
    // rather than trusting the token (a real admin may hit a plain
    // @RequirePermission() route that PlatformAdminGuard never ran on).
    const platformPhone = nextPhone();
    const [platformUser] = await admin<{ id: string }[]>`
      insert into users (phone_e164, phone_verified_at, platform_role_code)
      values (${platformPhone}, now(), 'platform_admin') returning id`;
    const platformToken = await tokens.signAccessToken({
      userId: platformUser!.id,
      tenantId: TENANT_A,
      memberId: '00000000-0000-7000-8000-000000000000',
      role: 'member',
    });
    members.platform_admin = {
      userId: platformUser!.id,
      memberId: '',
      roleCode: 'platform_admin',
      token: platformToken,
    };
  });

  afterAll(async () => {
    await app.close();
    try {
      await admin`delete from stores where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from roles where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenant_members where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from users where phone_e164 like ${`+88017${RUN_ID}%`}`;
    } finally {
      await admin.end();
    }
  });

  describe('built-in roles: allowed actions succeed, forbidden ones 403', () => {
    it('platform_admin: everything succeeds', async () => {
      for (const url of [
        '/api/v1/probe/posts',
        '/api/v1/probe/campaigns',
        '/api/v1/probe/users',
        '/api/v1/probe/analytics',
        '/api/v1/probe/stores',
      ]) {
        const response = await app.inject({
          method: 'GET',
          url,
          headers: authHeaders('platform_admin'),
        });
        expect(response.statusCode).toBe(200);
      }
    });

    it('tenant_admin: everything succeeds via the wildcard grant', async () => {
      for (const url of [
        '/api/v1/probe/posts',
        '/api/v1/probe/campaigns',
        '/api/v1/probe/users',
        '/api/v1/probe/analytics',
      ]) {
        const response = await app.inject({
          method: 'GET',
          url,
          headers: authHeaders('tenant_admin'),
        });
        expect(response.statusCode).toBe(200);
      }
    });

    it('moderator: posts read/write/approve succeed; delete/campaigns/users are forbidden', async () => {
      const headers = authHeaders('moderator');
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/probe/posts', headers })).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: 'POST', url: '/api/v1/probe/posts', headers })).statusCode,
      ).toBe(201);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/probe/posts/0191e3a0-dddd-7000-8000-0000000000f1/approve',
            headers,
          })
        ).statusCode,
      ).toBe(201);

      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: '/api/v1/probe/posts/0191e3a0-dddd-7000-8000-0000000000f2',
            headers,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/probe/campaigns', headers })).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/probe/users', headers })).statusCode,
      ).toBe(403);
    });

    it('marketer: campaigns/ads read+write and analytics read succeed; posts/users are forbidden', async () => {
      const headers = authHeaders('marketer');
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/probe/campaigns', headers })).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: 'POST', url: '/api/v1/probe/campaigns', headers })).statusCode,
      ).toBe(201);
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/probe/analytics', headers })).statusCode,
      ).toBe(200);

      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/probe/posts', headers })).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ method: 'POST', url: '/api/v1/probe/posts', headers })).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/probe/users', headers })).statusCode,
      ).toBe(403);
    });

    it('executive: users read+write succeed; posts/campaigns/stores are forbidden', async () => {
      const headers = authHeaders('executive');
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/probe/users', headers })).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: 'POST', url: '/api/v1/probe/users', headers })).statusCode,
      ).toBe(201);

      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/probe/posts', headers })).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/probe/campaigns', headers })).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/probe/stores', headers })).statusCode,
      ).toBe(403);
    });

    it('seller: posts/stores read+write succeed (ability); approve/campaigns/users are forbidden', async () => {
      const headers = authHeaders('seller');
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/probe/posts', headers })).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: 'POST', url: '/api/v1/probe/posts', headers })).statusCode,
      ).toBe(201);
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/probe/stores', headers })).statusCode,
      ).toBe(200);

      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/probe/posts/0191e3a0-dddd-7000-8000-0000000000f1/approve',
            headers,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/probe/campaigns', headers })).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/probe/users', headers })).statusCode,
      ).toBe(403);
    });

    it('member (user role): posts read/write/delete succeed; approve/stores/campaigns are forbidden', async () => {
      const headers = authHeaders('member');
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/probe/posts', headers })).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: 'POST', url: '/api/v1/probe/posts', headers })).statusCode,
      ).toBe(201);
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: '/api/v1/probe/posts/0191e3a0-dddd-7000-8000-0000000000f2',
            headers,
          })
        ).statusCode,
      ).toBe(200);

      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/probe/posts/0191e3a0-dddd-7000-8000-0000000000f1/approve',
            headers,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/probe/stores', headers })).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/probe/campaigns', headers })).statusCode,
      ).toBe(403);
    });
  });

  it('a moderator in tenant A has zero grants in tenant B — no membership row there, not just a token mismatch', async () => {
    const moderator = members.moderatorOnlyInA!;
    await expect(permissions.can(TENANT_A, moderator.userId, 'posts', 'read')).resolves.toBe(true);
    await expect(permissions.can(TENANT_B, moderator.userId, 'posts', 'read')).resolves.toBe(false);
  });

  describe('ownership: a seller can edit only their own store', () => {
    let storeA: string;
    let storeOther: string;

    beforeAll(async () => {
      const seller = members.seller!;
      const other = members.executive!; // any other member id works as "someone else"
      const [rowA] = await admin<{ id: string }[]>`
        insert into stores (tenant_id, owner_member_id, slug, name_bn)
        values (${TENANT_A}, ${seller.memberId}, ${'rbac-e2e-store-a-' + RUN_ID}, 'দোকান এ') returning id`;
      const [rowB] = await admin<{ id: string }[]>`
        insert into stores (tenant_id, owner_member_id, slug, name_bn)
        values (${TENANT_A}, ${other.memberId}, ${'rbac-e2e-store-b-' + RUN_ID}, 'দোকান বি') returning id`;
      storeA = rowA!.id;
      storeOther = rowB!.id;
    });

    it('succeeds on their own store', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/probe/stores/${storeA}`,
        headers: authHeaders('seller'),
        payload: { name_bn: 'নতুন নাম' },
      });
      expect(response.statusCode).toBe(200);
    });

    it("403s on someone else's store, even though they have the base stores:write permission", async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/probe/stores/${storeOther}`,
        headers: authHeaders('seller'),
        payload: { name_bn: 'নতুন নাম' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json<{ error: string }>().error).toBe('OWNERSHIP_REQUIRED');
    });
  });

  describe('custom roles', () => {
    it('a tenant admin creates a custom role, assigns it, and its exact matrix is enforced', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/roles',
        headers: authHeaders('tenant_admin'),
        payload: { name: 'Content Reviewer', permissions: [{ module: 'posts', action: 'read' }] },
      });
      expect(created.statusCode).toBe(201);
      const role = created.json<{ id: string; code: string }>();
      expect(role.code).toBe('content_reviewer');

      const reviewer = await createMember(TENANT_A, 'member');
      const assign = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant-members/${reviewer.memberId}/role`,
        headers: authHeaders('tenant_admin'),
        payload: { customRoleId: role.id },
      });
      expect(assign.statusCode).toBe(200);

      const reviewerHeaders = {
        authorization: `Bearer ${reviewer.token}`,
        'x-tenant-id': TENANT_A,
      };
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/probe/posts', headers: reviewerHeaders }))
          .statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: 'POST', url: '/api/v1/probe/posts', headers: reviewerHeaders }))
          .statusCode,
      ).toBe(403);
    });
  });

  describe('editing and deleting custom roles', () => {
    async function createCustomRole(name: string, grants: { module: string; action: string }[]) {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/roles',
        headers: authHeaders('tenant_admin'),
        payload: { name, permissions: grants },
      });
      expect(created.statusCode).toBe(201);
      return created.json<{ id: string; code: string }>();
    }

    async function holderOf(roleId: string): Promise<Record<string, string>> {
      const holder = await createMember(TENANT_A, 'member', roleId);
      return { authorization: `Bearer ${holder.token}`, 'x-tenant-id': TENANT_A };
    }

    it("a new matrix applies to the role's holders on their very next request", async () => {
      const role = await createCustomRole('Approver Edit', [{ module: 'posts', action: 'read' }]);
      const holder = await holderOf(role.id);
      const approve = {
        method: 'POST' as const,
        url: '/api/v1/probe/posts/0191e3a0-dddd-7000-8000-0000000000f2/approve',
        headers: holder,
      };

      expect((await app.inject(approve)).statusCode).toBe(403);

      const updated = await app.inject({
        method: 'PATCH',
        url: `/api/v1/roles/${role.id}`,
        headers: authHeaders('tenant_admin'),
        payload: {
          name: 'Approver Edited',
          permissions: [
            { module: 'posts', action: 'read' },
            { module: 'posts', action: 'approve' },
          ],
        },
      });
      expect(updated.statusCode).toBe(200);
      const body = updated.json<{ name: string; code: string; permissions: unknown[] }>();
      expect(body.name).toBe('Approver Edited');
      // Renaming never changes the role's identifier.
      expect(body.code).toBe(role.code);
      expect(body.permissions).toHaveLength(2);

      expect((await app.inject(approve)).statusCode).toBe(201);
    });

    it('deleting a role drops its holders back to their built-in role_code', async () => {
      const role = await createCustomRole('Temp Reader', [{ module: 'posts', action: 'read' }]);
      const holder = await holderOf(role.id);
      const write = { method: 'POST' as const, url: '/api/v1/probe/posts', headers: holder };

      // The custom role only grants read, overriding role_code 'member'.
      expect((await app.inject(write)).statusCode).toBe(403);

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/v1/roles/${role.id}`,
        headers: authHeaders('tenant_admin'),
      });
      expect(deleted.statusCode).toBe(204);

      // Back on 'member', which can write posts.
      expect((await app.inject(write)).statusCode).toBe(201);
    });

    it('built-in roles cannot be edited or deleted', async () => {
      const list = await app.inject({
        method: 'GET',
        url: '/api/v1/roles',
        headers: authHeaders('tenant_admin'),
      });
      const moderator = list
        .json<{ id: string; code: string }[]>()
        .find((role) => role.code === 'moderator')!;

      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/v1/roles/${moderator.id}`,
        headers: authHeaders('tenant_admin'),
        payload: { name: 'Hijacked' },
      });
      expect(patch.statusCode).toBe(409);
      expect(patch.json<{ error: string }>().error).toBe('ROLE_BUILTIN_IMMUTABLE');

      const remove = await app.inject({
        method: 'DELETE',
        url: `/api/v1/roles/${moderator.id}`,
        headers: authHeaders('tenant_admin'),
      });
      expect(remove.statusCode).toBe(409);
    });

    it('rejects a malformed role id and an empty change set with 400', async () => {
      const badId = await app.inject({
        method: 'PATCH',
        url: '/api/v1/roles/not-a-uuid',
        headers: authHeaders('tenant_admin'),
        payload: { name: 'X' },
      });
      expect(badId.statusCode).toBe(400);

      const role = await createCustomRole('Empty Patch', [{ module: 'posts', action: 'read' }]);
      const empty = await app.inject({
        method: 'PATCH',
        url: `/api/v1/roles/${role.id}`,
        headers: authHeaders('tenant_admin'),
        payload: {},
      });
      expect(empty.statusCode).toBe(400);
    });

    it('a member without roles:delete gets 403', async () => {
      const role = await createCustomRole('Protected', [{ module: 'posts', action: 'read' }]);
      const remove = await app.inject({
        method: 'DELETE',
        url: `/api/v1/roles/${role.id}`,
        headers: authHeaders('moderator'),
      });
      expect(remove.statusCode).toBe(403);
    });
  });

  describe('cache invalidation on role assignment', () => {
    it('a member promoted to moderator gets the new permissions on the very next request', async () => {
      const promotee = await createMember(TENANT_A, 'member');
      const promoteeHeaders = {
        authorization: `Bearer ${promotee.token}`,
        'x-tenant-id': TENANT_A,
      };

      const before = await app.inject({
        method: 'POST',
        url: '/api/v1/probe/posts/0191e3a0-dddd-7000-8000-0000000000f1/approve',
        headers: promoteeHeaders,
      });
      expect(before.statusCode).toBe(403);

      const assign = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant-members/${promotee.memberId}/role`,
        headers: authHeaders('tenant_admin'),
        payload: { roleCode: 'moderator' },
      });
      expect(assign.statusCode).toBe(200);

      const after = await app.inject({
        method: 'POST',
        url: '/api/v1/probe/posts/0191e3a0-dddd-7000-8000-0000000000f1/approve',
        headers: promoteeHeaders,
      });
      expect(after.statusCode).toBe(201);
    });
  });

  describe('audit logging', () => {
    it('logs a staff write/approve/delete action', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/probe/posts/0191e3a0-dddd-7000-8000-0000000000f3/approve',
        headers: authHeaders('moderator'),
      });

      const [row] = await admin<{ action: string; actor_role: string }[]>`
        select action, actor_role from audit_logs
        where tenant_id = ${TENANT_A} and actor_user_id = ${members.moderator!.userId} and action = 'posts.approve'
        order by occurred_at desc limit 1`;
      expect(row?.actor_role).toBe('moderator');
    });

    it('does not log a seller acting on their own store (self-service, not a staff action)', async () => {
      const before = await admin<{ count: string }[]>`
        select count(*)::text as count from audit_logs where actor_user_id = ${members.seller!.userId}`;

      await app.inject({
        method: 'PATCH',
        url: `/api/v1/probe/stores/${(await admin<{ id: string }[]>`select id from stores where owner_member_id = ${members.seller!.memberId} limit 1`)[0]!.id}`,
        headers: authHeaders('seller'),
        payload: { name_bn: 'আবার নতুন' },
      });

      const after = await admin<{ count: string }[]>`
        select count(*)::text as count from audit_logs where actor_user_id = ${members.seller!.userId}`;
      expect(after[0]!.count).toBe(before[0]!.count);
    });
  });
});
