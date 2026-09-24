import {
  Global,
  Inject,
  Injectable,
  Module,
  RequestMethod,
  type MiddlewareConsumer,
  type NestModule,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Sql } from 'postgres';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { createDatabase, createSqlClient } from './database.client';
import { DatabasePrivilegeCheck } from './database-privileges';
import { DB, SQL_CLIENT } from './database.tokens';
import { RedisTenantCacheStore } from './redis-tenant-cache.store';
import { TENANT_CACHE_STORE } from './tenant-cache.ports';
import { TenantContext } from './tenant-context';
import { TenantContextMiddleware } from './tenant-context.middleware';
import { TenantDb } from './tenant-db';
import { TenantLookupService } from './tenant-lookup.service';
import { TenantResolutionMiddleware } from './tenant-resolution.middleware';

@Injectable()
class SqlClientShutdown implements OnModuleDestroy {
  constructor(@Inject(SQL_CLIENT) private readonly client: Sql) {}

  async onModuleDestroy(): Promise<void> {
    await this.client.end();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: SQL_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (env: Env) =>
        createSqlClient({
          url: env.DATABASE_URL,
          poolMax: env.DB_POOL_MAX,
          idleTimeoutSeconds: env.DB_IDLE_TIMEOUT_S,
          connectTimeoutSeconds: env.DB_CONNECT_TIMEOUT_S,
          statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
          prepare: env.DB_PREPARE,
          applicationName: 'amar-elaka-api',
        }),
    },
    { provide: DB, inject: [SQL_CLIENT], useFactory: createDatabase },
    SqlClientShutdown,
    DatabasePrivilegeCheck,
    TenantContext,
    TenantDb,
    { provide: TENANT_CACHE_STORE, useClass: RedisTenantCacheStore },
    TenantLookupService,
  ],
  exports: [DB, TenantContext, TenantDb, TenantLookupService],
})
export class DatabaseModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantContextMiddleware).forRoutes({ path: '*', method: RequestMethod.ALL });
    consumer.apply(TenantResolutionMiddleware).forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
