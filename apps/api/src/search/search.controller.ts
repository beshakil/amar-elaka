import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { TenantContext } from '../database/tenant-context';
import type { ViewerSignals } from '../engagement/viewer-key';
import {
  SearchClickDto,
  SearchClickResultDto,
  SearchQueryDto,
  SearchResponseDto,
  SuggestQueryDto,
  SuggestResponseDto,
  TrendingResponseDto,
  type SearchClickResult,
  type SearchResponse,
  type SuggestResponse,
  type TrendingResponse,
} from './dto/search.dto';
import { SearchActivityService } from './query/search-activity.service';
import { SearchService } from './query/search.service';

/**
 * Public search, no login needed (a signed-in searcher is recognised, for
 * the query log). Tenant-aware like every public route: the tenant comes
 * from the subdomain / X-Tenant-Id; results cross tenant boundaries by
 * radius (schema.md §13.26).
 */
@Controller({ path: 'search', version: '1' })
@UseGuards(OptionalJwtAuthGuard)
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly activity: SearchActivityService,
    private readonly context: TenantContext,
  ) {}

  /**
   * Full-text search in Bengali, Banglish or English with the feed's scopes,
   * category, custom-field filters (`filters` = JSON), price range, sort and
   * cursor paging, plus facets for the filter UI.
   */
  @Get()
  @ApiOkResponse({ type: SearchResponseDto })
  find(@Query() query: SearchQueryDto, @Req() request: FastifyRequest): Promise<SearchResponse> {
    return this.search.search(query, this.signals(request));
  }

  /** As-you-type: matching categories, popular queries and top listing titles. */
  @Get('suggest')
  @ApiOkResponse({ type: SuggestResponseDto })
  suggest(@Query() query: SuggestQueryDto): Promise<SuggestResponse> {
    return this.search.suggest(query);
  }

  /** This tenant's top queries over trending_window_hours (distinct searchers). */
  @Get('trending')
  @ApiOkResponse({ type: TrendingResponseDto })
  trending(): Promise<TrendingResponse> {
    return this.activity.trending();
  }

  /** The searcher opened a result of their search (`searchId` from GET /search). */
  @Post('click')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: SearchClickResultDto })
  click(@Body() body: SearchClickDto): Promise<SearchClickResult> {
    return this.activity.click(body);
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
