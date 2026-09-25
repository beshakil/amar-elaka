import { Injectable } from '@nestjs/common';
import { TenantContext, type AppRole, type TenantContextStore } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { PostsRepository } from './posts.repository';

export interface Ownership {
  tenantId: string;
  resolution: 'inside_boundary' | 'within_buffer' | 'beyond_buffer_fallback' | 'no_location';
  outsideBoundary: boolean;
  /** Beyond every buffer: the post always waits for a moderator (schema.md §13.26). */
  needsReview: boolean;
}

// Roles that act across tenants keep their own role in any tenant's context.
const PLATFORM_ROLES: ReadonlySet<string> = new Set(['platform_admin', 'platform_support']);

/**
 * Posts belong to the tenant their location falls in (§13.26), which may not
 * be the tenant the request came through: a buffer-zone post, or a neighbour's
 * post opened from radius search. This service works out that owning tenant
 * and runs work in ITS context — the caller's own membership and role there —
 * so the ordinary RLS policies apply exactly as they would for a local post.
 */
@Injectable()
export class PostOwnershipService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: PostsRepository,
  ) {}

  /** Which tenant a new post at this point belongs to (resolve_owning_tenant, 0023). */
  async resolve(lat: number, lng: number): Promise<Ownership> {
    const requestTenantId = this.context.require().tenantId!;
    const owner = await this.tenantDb.transaction(
      (tx) => this.repo.resolveOwner(tx, lat, lng, requestTenantId),
      { accessMode: 'read only' },
    );
    const resolution = owner.resolution as Ownership['resolution'];
    return {
      tenantId: owner.tenantId,
      resolution,
      outsideBoundary: resolution === 'within_buffer' || resolution === 'beyond_buffer_fallback',
      needsReview: resolution === 'beyond_buffer_fallback',
    };
  }

  /** The owning tenant of an existing post, or undefined when there is no such post. */
  tenantOf(postId: string): Promise<string | undefined> {
    return this.tenantDb.transaction((tx) => this.repo.tenantOf(tx, postId), {
      accessMode: 'read only',
    });
  }

  /**
   * Runs `work` as the caller inside `tenantId`. `ensure` creates the
   * caller's implicit membership there if missing (writing a post);
   * `lookup` never does (reading one) — a stranger reads as an anonymous
   * visitor of that tenant.
   */
  async inTenant<T>(
    tenantId: string,
    mode: 'ensure' | 'lookup',
    work: (scope: { memberId: string | undefined; role: AppRole }) => Promise<T>,
  ): Promise<T> {
    const current = this.context.require();
    if (current.tenantId === tenantId && (mode === 'lookup' || current.memberId)) {
      return work({ memberId: current.memberId, role: current.role ?? 'anon' });
    }

    const membership = current.userId
      ? await this.tenantDb.transaction((tx) =>
          mode === 'ensure'
            ? this.repo.ensureMembership(tx, tenantId)
            : this.repo.membershipIn(tx, tenantId),
        )
      : undefined;
    const role: AppRole =
      current.role && PLATFORM_ROLES.has(current.role)
        ? current.role
        : ((membership?.roleCode as AppRole | undefined) ?? 'anon');
    const store: TenantContextStore = {
      tenantId,
      ...(current.userId ? { userId: current.userId } : {}),
      ...(membership ? { memberId: membership.memberId } : {}),
      role,
    };
    return this.context.run(store, () => work({ memberId: membership?.memberId, role }));
  }
}
