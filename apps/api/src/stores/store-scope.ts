import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { UnauthenticatedException } from '../auth/exceptions/auth.exceptions';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { PostOwnershipService } from '../posts/post-ownership.service';
import { PostsRepository } from '../posts/posts.repository';
import {
  StoreMembershipRequiredException,
  StoreNotActiveException,
  StoreNotFoundException,
} from './stores.exceptions';

/**
 * The seller tools' way into a store (ADR 056/057): the store's own tenant
 * (item_tenant_of), a read in that tenant's context, and "may this caller
 * post as the store" — member_may_post_as_store through store_posting_facts,
 * the one rule.
 */
@Injectable()
export class StoreScope {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly ownership: PostOwnershipService,
    private readonly posts: PostsRepository,
  ) {}

  /** The signed-in caller's store's tenant; 404 when there's no such store. */
  async tenantOf(storeId: string): Promise<string> {
    if (!this.context.require().userId) throw new UnauthenticatedException();
    const tenantId = await this.tenantDb.transaction(
      async (tx) => {
        const rows = await tx.execute(
          sql`select public.item_tenant_of('store', ${storeId}::uuid) as tenant_id`,
        );
        return (
          z.array(z.object({ tenant_id: z.string().nullable() })).parse([...rows])[0]?.tenant_id ??
          null
        );
      },
      { accessMode: 'read only' },
    );
    if (!tenantId) throw new StoreNotFoundException();
    return tenantId;
  }

  /** The caller may post as this active store: its tenant. */
  async asPoster(storeId: string): Promise<{ tenantId: string }> {
    const tenantId = await this.tenantOf(storeId);
    const facts = await this.read(tenantId, (tx) => this.posts.storePostingFacts(tx, storeId));
    if (!facts) throw new StoreNotFoundException();
    if (!facts.mayPost) throw new StoreMembershipRequiredException();
    if (facts.status !== 'active') throw new StoreNotActiveException(facts.status);
    return { tenantId };
  }

  /** A read-only transaction in the store's tenant, as the caller's member there. */
  read<T>(tenantId: string, work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.ownership.inTenant(tenantId, 'lookup', () =>
      this.tenantDb.transaction(work, { accessMode: 'read only' }),
    );
  }
}
