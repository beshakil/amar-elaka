import { Controller, Get, Param, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../../auth/guards/optional-jwt-auth.guard';
import { StoreIdParamDto, StoreSlugParamDto } from '../dto/stores.dto';
import { StoreCatalogDto, type StoreCatalog } from './store-catalog.dto';
import { StoreCatalogService } from './store-catalog.service';

/**
 * The WhatsApp catalog (ADR 056): the public catalog's data and its share
 * image, by slug in the host tenant; the owner's Commerce Manager export.
 * Ordering is POST /stores/:slug/catalog/order/:postId (EngagementController).
 */
@Controller({ path: 'stores', version: '1' })
export class StoreCatalogController {
  constructor(private readonly catalogs: StoreCatalogService) {}

  @Get(':slug/catalog')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: StoreCatalogDto })
  catalog(@Param() params: StoreSlugParamDto): Promise<StoreCatalog> {
    return this.catalogs.catalog(params.slug);
  }

  @Get(':slug/og.png')
  @ApiOkResponse({ description: 'A 1200×630 PNG.' })
  async image(
    @Param() params: StoreSlugParamDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile> {
    const png = await this.catalogs.sharePng(params.slug);
    void reply.header('Content-Type', 'image/png').header('Cache-Control', 'public, max-age=3600');
    return new StreamableFile(png);
  }

  /** Owner and managers: the products as a Meta Commerce Manager feed (CSV). */
  @Get(':id/catalog.csv')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ description: 'A CSV product feed.' })
  async export(
    @Param() params: StoreIdParamDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile> {
    const file = await this.catalogs.exportCsv(params.id);
    void reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${file.filename}"`)
      .header('Cache-Control', 'no-store');
    return new StreamableFile(file.body);
  }
}
