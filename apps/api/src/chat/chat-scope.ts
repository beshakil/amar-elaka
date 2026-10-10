import { Injectable } from '@nestjs/common';
import { UnauthenticatedException } from '../auth/exceptions/auth.exceptions';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { TenantLookupService } from '../database/tenant-lookup.service';
import { TenantSuspendedException, TenantTerminatedException } from '../database/tenant.exceptions';
import { PostOwnershipService } from '../posts/post-ownership.service';
import { ConversationNotFoundException } from './chat.exceptions';
import { ChatRepository } from './chat.repository';

export interface ConversationScopeInfo {
  tenantId: string;
  userId: string;
  /** The caller's membership in the conversation's tenant. */
  memberId: string;
}

/**
 * The one place chat enters a conversation's tenant, for REST and the socket
 * alike. A conversation lives in its post's or store's tenant, not
 * necessarily the caller's (radius discovery crosses boundaries), so:
 *
 *   1. conversation_tenant_of() answers only for one of the conversation's
 *      own participants (any of the caller's memberships); anyone else —
 *      a member of another tenant included — gets "not found";
 *   2. the tenant gate's rule (suspended / terminated) applies to that
 *      tenant, as TenantGateGuard applies it to a request's;
 *   3. the work runs as the caller's membership there
 *      (PostOwnershipService.inTenant, the same switch posts use), so every
 *      query is under the ordinary RLS policies of that tenant.
 */
@Injectable()
export class ChatScope {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly ownership: PostOwnershipService,
    private readonly tenants: TenantLookupService,
    private readonly repo: ChatRepository,
  ) {}

  requireUserId(): string {
    const userId = this.context.current()?.userId;
    if (!userId) throw new UnauthenticatedException();
    return userId;
  }

  async inConversation<T>(
    conversationId: string,
    work: (scope: ConversationScopeInfo) => Promise<T>,
  ): Promise<T> {
    const userId = this.requireUserId();
    const tenantId = await this.tenantDb.transaction(
      (tx) => this.repo.conversationTenantOf(tx, conversationId),
      { accessMode: 'read only' },
    );
    if (!tenantId) throw new ConversationNotFoundException();
    await this.assertOpen(tenantId);
    return this.ownership.inTenant(tenantId, 'lookup', ({ memberId }) => {
      if (!memberId) throw new ConversationNotFoundException();
      return work({ tenantId, userId, memberId });
    });
  }

  /** Runs as the caller in `tenantId`, creating their membership there if missing (opening a conversation). */
  async asMemberOf<T>(
    tenantId: string,
    work: (scope: ConversationScopeInfo) => Promise<T>,
  ): Promise<T> {
    const userId = this.requireUserId();
    await this.assertOpen(tenantId);
    return this.ownership.inTenant(tenantId, 'ensure', ({ memberId }) => {
      if (!memberId) throw new UnauthenticatedException();
      return work({ tenantId, userId, memberId });
    });
  }

  /** Runs as the caller in `tenantId` without creating a membership (reading). */
  async lookupIn<T>(
    tenantId: string,
    work: (memberId: string | undefined) => Promise<T>,
  ): Promise<T> {
    return this.ownership.inTenant(tenantId, 'lookup', ({ memberId }) => work(memberId));
  }

  private async assertOpen(tenantId: string): Promise<void> {
    const tenant = await this.tenants.resolveById(tenantId);
    if (!tenant) throw new ConversationNotFoundException();
    if (tenant.statusCode === 'suspended') throw new TenantSuspendedException();
    if (tenant.statusCode === 'terminated') throw new TenantTerminatedException();
  }
}
