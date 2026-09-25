import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import {
  SearchQueryDto,
  SearchResponseDto,
  SuggestQueryDto,
  SuggestResponseDto,
  type SearchResponse,
  type SuggestResponse,
} from './dto/search.dto';
import { SearchService } from './query/search.service';

/**
 * Public search, no login needed. Tenant-aware like every public route: the
 * tenant comes from the subdomain / X-Tenant-Id; with lat/lng, results cross
 * tenant boundaries by radius (schema.md §13.26).
 */
@Controller({ path: 'search', version: '1' })
export class SearchController {
  constructor(private readonly search: SearchService) {}

  /**
   * Full-text search in Bengali, Banglish or English, with category, custom-field
   * filters (`filters` = JSON), geo radius and facets for the filter UI.
   */
  @Get()
  @ApiOkResponse({ type: SearchResponseDto })
  find(@Query() query: SearchQueryDto): Promise<SearchResponse> {
    return this.search.search(query);
  }

  /** As-you-type suggestions: matching categories, then listings, stores and places. */
  @Get('suggest')
  @ApiOkResponse({ type: SuggestResponseDto })
  suggest(@Query() query: SuggestQueryDto): Promise<SuggestResponse> {
    return this.search.suggest(query);
  }
}
