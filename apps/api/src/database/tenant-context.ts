import { AsyncLocalStorage } from 'node:async_hooks';
import { HttpStatus, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DomainException } from '../common/exceptions/domain-exception';

/**
 * Session roles mirrored into `app.role` (docs/specs/schema.md §0.6).
 * marketer/executive/seller are member_roles.code values added by
 * infra/migrations/0015_rbac.sql for the fine-grained permission system
 * (apps/api/src/rbac) — they carry no special RLS meaning of their own
 * (app_is_staff()/app_is_tenant_admin() don't check for them), only
 * PermissionsService's module/action lookup does.
 */
export const APP_ROLES = [
  'anon',
  'member',
  'agent',
  'moderator',
  'tenant_admin',
  'partner_owner',
  'marketer',
  'executive',
  'seller',
  'platform_admin',
  'platform_support',
  'platform_finance',
  'system',
  'restricted_user',
  'appeal_public',
] as const;

export type AppRole = (typeof APP_ROLES)[number];

const TenantContextSchema = z
  .object({
    tenantId: z.string().uuid(),
    userId: z.string().uuid(),
    memberId: z.string().uuid(),
    role: z.enum(APP_ROLES),
    // Informational only — never written to a GUC by applyTransactionContext,
    // just carried alongside tenantId so TenantGateGuard can enforce
    // suspended/terminated without a second lookup (tenant-resolution.middleware.ts).
    tenantStatus: z.string(),
  })
  .partial()
  .strict();

export type TenantContextStore = z.infer<typeof TenantContextSchema>;

export class TenantContextMissingException extends DomainException {
  readonly code = 'TENANT_CONTEXT_MISSING';
  readonly httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;

  constructor() {
    super('Request context is unavailable.');
  }
}

/**
 * Per-request (or per-job) context held in AsyncLocalStorage.
 *
 * Every HTTP request gets its own store object via TenantContextMiddleware.
 * Later auth / tenant-resolution steps fill it with `set()`. Background jobs
 * and tests open their own scope with `run()`. Stores are never shared: each
 * `run()` copies its input, so one request can't observe another's values,
 * even when both are suspended on awaits in the same event loop.
 */
@Injectable()
export class TenantContext {
  private readonly storage = new AsyncLocalStorage<TenantContextStore>();

  run<T>(store: TenantContextStore, fn: () => T): T {
    return this.storage.run({ ...TenantContextSchema.parse(store) }, fn);
  }

  current(): Readonly<TenantContextStore> | undefined {
    return this.storage.getStore();
  }

  require(): Readonly<TenantContextStore> {
    const store = this.storage.getStore();
    if (!store) {
      throw new TenantContextMissingException();
    }
    return store;
  }

  /** Fills in the current scope's store (e.g. after authentication). */
  set(values: TenantContextStore): void {
    const store = this.storage.getStore();
    if (!store) {
      throw new TenantContextMissingException();
    }
    Object.assign(store, TenantContextSchema.parse(values));
  }
}
