import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { SettingsModule } from '../settings/settings.module';
import { CategoriesController } from './categories.controller';
import { CATEGORIES_CLOCK, systemCategoriesClock } from './categories.ports';
import { CategoriesRepository } from './categories.repository';
import { CategoryCatalogService } from './category-catalog.service';
import { FieldSchemaVersionsService } from './field-schema-versions.service';
import { FieldValidationService } from './field-validation.service';
import { PlatformAdminOnlyGuard } from './platform-admin-only';
import { PlatformCategoriesController } from './platform-categories.controller';
import { PlatformCategoriesService } from './platform-categories.service';
import { TenantCategoriesController } from './tenant-categories.controller';
import { TenantCategoriesService } from './tenant-categories.service';

/**
 * The category engine: global taxonomy CRUD and field-schema versioning
 * (platform admin), per-tenant enablement and ordering (tenant admin), the
 * public catalog, and field validation for posts. FieldValidationService is
 * exported for the posts module.
 */
@Module({
  imports: [RbacModule, SettingsModule],
  controllers: [PlatformCategoriesController, TenantCategoriesController, CategoriesController],
  providers: [
    CategoriesRepository,
    PlatformCategoriesService,
    FieldSchemaVersionsService,
    TenantCategoriesService,
    CategoryCatalogService,
    FieldValidationService,
    PlatformAdminOnlyGuard,
    { provide: CATEGORIES_CLOCK, useValue: systemCategoriesClock },
  ],
  exports: [FieldValidationService],
})
export class CategoriesModule {}
