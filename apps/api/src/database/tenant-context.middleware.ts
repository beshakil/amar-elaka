import { Injectable, type NestMiddleware } from '@nestjs/common';
import { TenantContext } from './tenant-context';

/**
 * Opens a fresh, empty tenant-context scope for every HTTP request. Everything
 * downstream (guards, interceptors, controllers, services, TenantDb) runs
 * inside `next()` and therefore sees only this request's store.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(private readonly context: TenantContext) {}

  use(_request: unknown, _response: unknown, next: (error?: unknown) => void): void {
    this.context.run({}, () => next());
  }
}
