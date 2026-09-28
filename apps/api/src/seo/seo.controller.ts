import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import {
  ListingIdParamDto,
  ListingStatusDto,
  SitemapPageQueryDto,
  SitemapPostsDto,
  SitemapStoresDto,
  SitemapSummaryDto,
  StorePageDto,
  StorePostsQueryDto,
  StoreSlugParamDto,
  type ListingStatus,
  type SitemapPosts,
  type SitemapStores,
  type SitemapSummary,
  type StorePage,
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

  @Get('sitemap/stores')
  @ApiOkResponse({ type: SitemapStoresDto })
  stores(@Query() query: SitemapPageQueryDto): Promise<SitemapStores> {
    return this.seo.sitemapStores(query);
  }
}

/** GET /api/v1/stores/:slug — a store's public page (basic, ADR 039). */
@Controller({ path: 'stores', version: '1' })
export class PublicStoresController {
  constructor(private readonly seo: SeoService) {}

  @Get(':slug')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: StorePageDto })
  store(
    @Param() params: StoreSlugParamDto,
    @Query() query: StorePostsQueryDto,
  ): Promise<StorePage> {
    return this.seo.store(params.slug, query);
  }
}
