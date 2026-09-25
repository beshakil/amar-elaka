import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module';
import { CategoriesModule } from './categories/categories.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { ZodValidationPipe } from './common/pipes/zod-validation.pipe';
import { APP_CONFIG, ConfigModule } from './config/config.module';
import type { Env } from './config/env.schema';
import { DatabaseModule } from './database/database.module';
import { TenantGateGuard } from './database/tenant-gate.guard';
import { HealthModule } from './health/health.module';
import { buildPinoHttpOptions } from './logging/pino-http-options';
import { MailModule } from './mail/mail.module';
import { QueueModule } from './queue/queue.module';
import { AuditLogInterceptor } from './rbac/audit-log.interceptor';
import { RbacModule } from './rbac/rbac.module';
import { SettingsModule } from './settings/settings.module';
import { MediaModule } from './media/media.module';
import { LocationsModule } from './locations/locations.module';
import { SearchModule } from './search/search.module';
import { TenantsModule } from './tenants/tenants.module';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (env: Env) => ({ pinoHttp: buildPinoHttpOptions(env) }),
    }),
    HealthModule,
    SettingsModule,
    AuthModule,
    TenantsModule,
    CategoriesModule,
    RbacModule,
    QueueModule,
    MailModule,
    MediaModule,
    SearchModule,
    LocationsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_GUARD, useClass: TenantGateGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditLogInterceptor },
  ],
})
export class AppModule {}
