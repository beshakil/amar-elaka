import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Put } from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import { RequirePermission } from '../rbac/require-permission.decorator';
import {
  CategoryIdParamDto,
  ReorderTenantCategoriesDto,
  UpdateTenantCategoryDto,
} from './dto/category-requests.dto';
import { TenantCategorySettingDto, type TenantCategorySetting } from './dto/category-responses.dto';
import { TenantCategoriesService } from './tenant-categories.service';

/** A tenant admin enabling, overriding and ordering categories for their tenant. */
@Controller({ path: 'tenant', version: '1' })
export class TenantCategoriesController {
  constructor(private readonly tenantCategories: TenantCategoriesService) {}

  @Get('categories')
  @RequirePermission('categories', 'read')
  @ApiOkResponse({ type: TenantCategorySettingDto, isArray: true })
  list(): Promise<TenantCategorySetting[]> {
    return this.tenantCategories.list();
  }

  @Patch('categories/:id')
  @RequirePermission('categories', 'write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Saved.' })
  async update(
    @Param() params: CategoryIdParamDto,
    @Body() body: UpdateTenantCategoryDto,
  ): Promise<void> {
    await this.tenantCategories.update(params.id, body);
  }

  @Put('category-order')
  @RequirePermission('categories', 'write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Saved.' })
  async reorder(@Body() body: ReorderTenantCategoriesDto): Promise<void> {
    await this.tenantCategories.reorder(body.categoryIds);
  }
}
