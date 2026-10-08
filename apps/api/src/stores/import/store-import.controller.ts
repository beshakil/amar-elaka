import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiOkResponse } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { StoreIdParamDto } from '../dto/stores.dto';
import {
  ImportListDto,
  ImportParamDto,
  ImportTemplateQueryDto,
  ImportViewDto,
  StartImportDto,
  type ImportList,
  type ImportView,
} from './dto/store-import.dto';
import { StoreImportService } from './store-import.service';

const attachment = (reply: FastifyReply, filename: string, contentType: string) =>
  void reply
    .header('Content-Type', contentType)
    .header('Content-Disposition', `attachment; filename="${filename}"`)
    .header('Cache-Control', 'no-store');

/**
 * /api/v1/stores/:id/import… — bulk upload (ADR 056). Upload the sheet (and
 * an optional photos ZIP) through POST /media/presign with kind `import`,
 * confirm, then start; poll the import for progress; download the report.
 */
@Controller({ path: 'stores', version: '1' })
export class StoreImportController {
  constructor(private readonly imports: StoreImportService) {}

  /** The category's sheet: Bengali headers, an example row, photo columns. */
  @Get(':id/import/template')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ description: 'An XLSX or CSV file.' })
  async template(
    @Param() params: StoreIdParamDto,
    @Query() query: ImportTemplateQueryDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile> {
    const file = await this.imports.template(params.id, query);
    attachment(reply, file.filename, file.contentType);
    return new StreamableFile(file.body);
  }

  /** Queues the import (or a dry run that creates nothing) and answers at once. */
  @Post(':id/import')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(JwtAuthGuard)
  @ApiAcceptedResponse({ type: ImportViewDto })
  start(@Param() params: StoreIdParamDto, @Body() body: StartImportDto): Promise<ImportView> {
    return this.imports.start(params.id, body);
  }

  @Get(':id/imports')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: ImportListDto })
  list(@Param() params: StoreIdParamDto): Promise<ImportList> {
    return this.imports.list(params.id);
  }

  /** Progress, counts and every row's outcome. */
  @Get(':id/imports/:importId')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: ImportViewDto })
  get(@Param() params: ImportParamDto): Promise<ImportView> {
    return this.imports.get(params.id, params.importId);
  }

  @Get(':id/imports/:importId/report.csv')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ description: 'The row-level report (CSV).' })
  async report(
    @Param() params: ImportParamDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile> {
    const file = await this.imports.report(params.id, params.importId);
    attachment(reply, file.filename, 'text/csv; charset=utf-8');
    return new StreamableFile(file.body);
  }
}
