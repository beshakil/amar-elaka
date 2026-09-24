import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditLogService } from './audit-log.service';
import { MeController } from './me.controller';
import { OwnershipGuard } from './ownership.guard';
import { PERMISSIONS_CACHE_STORE } from './permissions-cache.ports';
import { PermissionGuard } from './permission.guard';
import { PermissionsService } from './permissions.service';
import { PlatformAdminGuard } from './platform-admin.guard';
import { RedisPermissionsCacheStore } from './redis-permissions-cache.store';
import { RolesController } from './roles.controller';
import { RolesRepository } from './roles.repository';
import { RolesService } from './roles.service';

/** Anything using @PlatformAdmin(), @RequirePermission() or @RequireOwnership() must import this module. */
@Module({
  imports: [AuthModule],
  controllers: [RolesController, MeController],
  providers: [
    PlatformAdminGuard,
    { provide: PERMISSIONS_CACHE_STORE, useClass: RedisPermissionsCacheStore },
    PermissionsService,
    PermissionGuard,
    OwnershipGuard,
    AuditLogService,
    RolesRepository,
    RolesService,
  ],
  // PermissionGuard/OwnershipGuard must be exported too — @RequirePermission()/
  // @RequireOwnership() are meant for future feature modules (posts, stores,
  // ...), which need these resolvable in their own DI scope, not just here.
  exports: [
    PlatformAdminGuard,
    AuthModule,
    PermissionsService,
    AuditLogService,
    PermissionGuard,
    OwnershipGuard,
  ],
})
export class RbacModule {}
