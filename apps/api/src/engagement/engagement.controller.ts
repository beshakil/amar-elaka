import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { TenantContext } from '../database/tenant-context';
import { PostIdParamDto } from '../posts/dto/posts.dto';
import { StoreIdParamDto, STORE_SLUG_PATTERN_DTO } from '../stores/dto/stores.dto';
import { z } from 'zod';
import { createZodDto } from '../common/pipes/zod-dto';

const catalogOrderParamSchema = z
  .object({ slug: STORE_SLUG_PATTERN_DTO, postId: z.string().uuid() })
  .strict();
class CatalogOrderParamDto extends createZodDto(catalogOrderParamSchema) {}
import { ContactService } from './contact.service';
import {
  ContactDto,
  ContactRevealDto,
  PostDetailDto,
  PostDetailQueryDto,
  ReportDto,
  ReportResultDto,
  StoreContactDto,
  type ContactReveal,
  type PostDetail,
  type ReportResult,
} from './dto/engagement.dto';
import { PostDetailService } from './post-detail.service';
import { PostViewsService } from './post-views.service';
import { ReportsService } from './reports.service';
import type { ViewerSignals } from './viewer-key';

/**
 * /api/v1/posts/:id/{detail,view,contact,report} — the buyer's side of a post
 * (ADR 036). Thin: validation and HTTP shape; the rules live in the services.
 */
@Controller({ path: 'posts', version: '1' })
export class EngagementController {
  constructor(
    private readonly detailService: PostDetailService,
    private readonly views: PostViewsService,
    private readonly contacts: ContactService,
    private readonly reports: ReportsService,
    private readonly context: TenantContext,
  ) {}

  /** The full post page: fields labelled from its own schema version, every photo variant, the seller card, similar posts. Never the seller's number. */
  @Get(':id/detail')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: PostDetailDto })
  detail(@Param() params: PostIdParamDto, @Query() query: PostDetailQueryDto): Promise<PostDetail> {
    return this.detailService.detail(params.id, query);
  }

  /** Counts a view (once per viewer per view_dedupe_hours), asynchronously. */
  @Post(':id/view')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(OptionalJwtAuthGuard)
  @ApiNoContentResponse()
  async view(@Param() params: PostIdParamDto, @Req() request: FastifyRequest): Promise<void> {
    await this.views.record(params.id, this.signals(request));
  }

  /** Reveals the seller's contact for one channel and records the lead. */
  @Post(':id/contact')
  @HttpCode(HttpStatus.OK)
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: ContactRevealDto })
  contact(
    @Param() params: PostIdParamDto,
    @Body() body: ContactDto,
    @Req() request: FastifyRequest,
  ): Promise<ContactReveal> {
    return this.contacts.reveal(params.id, body, this.signals(request), localeOf(request));
  }

  /** Reports the post to its area's moderators. */
  @Post(':id/report')
  @UseGuards(JwtAuthGuard)
  @ApiCreatedResponse({ type: ReportResultDto })
  report(@Param() params: PostIdParamDto, @Body() body: ReportDto): Promise<ReportResult> {
    return this.reports.report(params.id, body);
  }

  private signals(request: FastifyRequest): ViewerSignals {
    const installId = request.headers['x-install-id'];
    return {
      userId: this.context.current()?.userId,
      installId: typeof installId === 'string' ? installId : undefined,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    };
  }
}

/**
 * POST /api/v1/stores/:id/contact (ADR 054): a store's own numbers, revealed
 * like a post's (ContactService) — the store page and map preview never
 * carry them.
 */
@Controller({ path: 'stores', version: '1' })
export class StoreContactController {
  constructor(
    private readonly contacts: ContactService,
    private readonly context: TenantContext,
  ) {}

  /**
   * An order from the WhatsApp catalog (ADR 056): the wa.me link with the
   * product prefilled, and a lead. The web's catalog page calls it on a tap
   * and redirects; the number is never in a page's HTML.
   */
  @Post(':slug/catalog/order/:postId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: ContactRevealDto })
  catalogOrder(
    @Param() params: CatalogOrderParamDto,
    @Req() request: FastifyRequest,
  ): Promise<ContactReveal> {
    const installId = request.headers['x-install-id'];
    return this.contacts.catalogOrder(
      params.slug,
      params.postId,
      {
        userId: this.context.current()?.userId,
        installId: typeof installId === 'string' ? installId : undefined,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      },
      localeOf(request),
    );
  }

  @Post(':id/contact')
  @HttpCode(HttpStatus.OK)
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: ContactRevealDto })
  contact(
    @Param() params: StoreIdParamDto,
    @Body() body: StoreContactDto,
    @Req() request: FastifyRequest,
  ): Promise<ContactReveal> {
    const installId = request.headers['x-install-id'];
    return this.contacts.revealStore(
      params.id,
      body,
      {
        userId: this.context.current()?.userId,
        installId: typeof installId === 'string' ? installId : undefined,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      },
      localeOf(request),
    );
  }
}

/** The prefilled message's language: English only when the client asks for it first. */
function localeOf(request: FastifyRequest): 'bn' | 'en' {
  const accept = request.headers['accept-language'];
  return typeof accept === 'string' && accept.trim().toLowerCase().startsWith('en') ? 'en' : 'bn';
}
