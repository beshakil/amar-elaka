import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import {
  CategoryAreasDto,
  ListingIdParamDto,
  ListingStatusDto,
  SitemapPageQueryDto,
  SitemapPostsDto,
  SitemapStoresDto,
  SitemapSummaryDto,
  type CategoryAreas,
  type ListingStatus,
  type SitemapPosts,
  type SitemapStores,
  type SitemapSummary,
} from './dto/seo.dto';
import { SeoService } from './seo.service';

/** /api/v1/seo — what the public web needs to answer crawlers correctly (ADR 039). No login. */
@Controller({ path: 'seo', version: '1' })
export class SeoController {
  constructor(private readonly seo: SeoService) {}

  /** How a listing URL should answer: render (indexable or not), 410 Gone, or 404. */
  @Get('listing-status/:id')
  @ApiOkResponse({ type: ListingStatusDto })
  listingStatus(@Param() params: ListingIdParamDto): Promise<ListingStatus> {
    return this.seo.listingStatus(params.id);
  }

  /** The host tenant's sitemap sizes, to split files at sitemap_urls_per_file. */
  @Get('sitemap/summary')
  @ApiOkResponse({ type: SitemapSummaryDto })
  summary(): Promise<SitemapSummary> {
    return this.seo.sitemapSummary();
  }

  @Get('sitemap/posts')
  @ApiOkResponse({ type: SitemapPostsDto })
  posts(@Query() query: SitemapPageQueryDto): Promise<SitemapPosts> {
    return this.seo.sitemapPosts(query);
  }

  /** The category + area landing pages with enough listings (ADR 042). */
  @Get('category-areas')
  @ApiOkResponse({ type: CategoryAreasDto })
  categoryAreas(): Promise<CategoryAreas> {
    return this.seo.categoryAreas();
  }

  @Get('sitemap/stores')
  @ApiOkResponse({ type: SitemapStoresDto })
  stores(@Query() query: SitemapPageQueryDto): Promise<SitemapStores> {
    return this.seo.sitemapStores(query);
  }
}
