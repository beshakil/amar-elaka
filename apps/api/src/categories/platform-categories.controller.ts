import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import {
  CategoryIdParamDto,
  CreateCategoryDto,
  FieldSchemaIdParamDto,
  SaveFieldSchemaDraftDto,
  UpdateCategoryDto,
} from './dto/category-requests.dto';
import {
  FieldSchemaVersionDto,
  FieldSchemaVersionSummaryDto,
  PlatformCategoryDto,
  type FieldSchemaVersion,
  type FieldSchemaVersionSummary,
  type PlatformCategory,
} from './dto/category-responses.dto';
import { FieldSchemaVersionsService } from './field-schema-versions.service';
import { PlatformAdminOnly } from './platform-admin-only';
import { PlatformCategoriesService } from './platform-categories.service';

/** The global taxonomy and its field-schema versions. Platform admins only. */
@Controller({ path: 'platform', version: '1' })
export class PlatformCategoriesController {
  constructor(
    private readonly categories: PlatformCategoriesService,
    private readonly versions: FieldSchemaVersionsService,
  ) {}

  @Get('categories')
  @PlatformAdminOnly('read')
  @ApiOkResponse({ type: PlatformCategoryDto, isArray: true })
  list(): Promise<PlatformCategory[]> {
    return this.categories.list();
  }

  @Post('categories')
  @PlatformAdminOnly('write')
  @ApiCreatedResponse({ type: PlatformCategoryDto })
  create(@Body() body: CreateCategoryDto): Promise<PlatformCategory> {
    return this.categories.create(body);
  }

  @Get('categories/:id')
  @PlatformAdminOnly('read')
  @ApiOkResponse({ type: PlatformCategoryDto })
  get(@Param() params: CategoryIdParamDto): Promise<PlatformCategory> {
    return this.categories.get(params.id);
  }

  @Patch('categories/:id')
  @PlatformAdminOnly('write')
  @ApiOkResponse({ type: PlatformCategoryDto })
  update(
    @Param() params: CategoryIdParamDto,
    @Body() body: UpdateCategoryDto,
  ): Promise<PlatformCategory> {
    return this.categories.update(params.id, body);
  }

  @Delete('categories/:id')
  @PlatformAdminOnly('delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Soft-deleted; existing posts keep their category.' })
  async remove(@Param() params: CategoryIdParamDto): Promise<void> {
    await this.categories.remove(params.id);
  }

  @Get('categories/:id/schemas')
  @PlatformAdminOnly('read')
  @ApiOkResponse({ type: FieldSchemaVersionSummaryDto, isArray: true })
  listVersions(@Param() params: CategoryIdParamDto): Promise<FieldSchemaVersionSummary[]> {
    return this.versions.listVersions(params.id);
  }

  @Put('categories/:id/schema-draft')
  @PlatformAdminOnly('write')
  @ApiOkResponse({ type: FieldSchemaVersionDto })
  saveDraft(
    @Param() params: CategoryIdParamDto,
    @Body() body: SaveFieldSchemaDraftDto,
  ): Promise<FieldSchemaVersion> {
    return this.versions.saveDraft(params.id, body);
  }

  @Delete('categories/:id/schema-draft')
  @PlatformAdminOnly('delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'The open draft was discarded.' })
  async discardDraft(@Param() params: CategoryIdParamDto): Promise<void> {
    await this.versions.discardDraft(params.id);
  }

  @Post('categories/:id/schema-draft/publish')
  @PlatformAdminOnly('write')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: FieldSchemaVersionDto })
  publish(@Param() params: CategoryIdParamDto): Promise<FieldSchemaVersion> {
    return this.versions.publishDraft(params.id);
  }

  @Get('category-schemas/:schemaId')
  @PlatformAdminOnly('read')
  @ApiOkResponse({ type: FieldSchemaVersionDto })
  getVersion(@Param() params: FieldSchemaIdParamDto): Promise<FieldSchemaVersion> {
    return this.versions.getVersion(params.schemaId);
  }
}
