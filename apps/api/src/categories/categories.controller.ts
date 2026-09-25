import { Controller, Get, Param } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { AllowAnyTenant } from '../database/allow-any-tenant.decorator';
import { CategoryCatalogService } from './category-catalog.service';
import { FieldSchemaIdParamDto } from './dto/category-requests.dto';
import {
  CatalogCategoryDto,
  FieldSchemaVersionDto,
  type CatalogCategory,
  type FieldSchemaVersion,
} from './dto/category-responses.dto';

/** Public, tenant-aware category catalog. No login needed. */
@Controller({ version: '1' })
export class CategoriesController {
  constructor(private readonly catalog: CategoryCatalogService) {}

  @Get('categories')
  @ApiOkResponse({ type: CatalogCategoryDto, isArray: true })
  list(): Promise<CatalogCategory[]> {
    return this.catalog.listForTenant();
  }

  /**
   * Any published or retired version, for rendering a post against the
   * version it pinned. Versions are global and immutable, so no tenant is
   * needed and clients may cache the response indefinitely.
   */
  @Get('categories/schemas/:schemaId')
  @AllowAnyTenant()
  @ApiOkResponse({ type: FieldSchemaVersionDto })
  getSchema(@Param() params: FieldSchemaIdParamDto): Promise<FieldSchemaVersion> {
    return this.catalog.getSchema(params.schemaId);
  }
}
