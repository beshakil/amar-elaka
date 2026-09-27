import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { FeedQueryDto, FeedResponseDto, type FeedResponse } from './dto/feed.dto';
import { FeedService } from './feed.service';

/**
 * The home and category feed, no login needed. Tenant-aware like every public
 * route (subdomain / X-Tenant-Id), but what it shows is a radius around the
 * viewer, whichever tenant owns it (schema.md §13.26, ADR 035).
 */
@Controller({ path: 'feed', version: '1' })
export class FeedController {
  constructor(private readonly feed: FeedService) {}

  /**
   * Ranked post cards mixed with nearby stores and, on the first page, the
   * emergency shortcut, today's bazar prices and landmarks. Page with
   * `cursor` (keep the other parameters the same). A signed-in viewer's
   * saved posts come marked `isSaved`.
   */
  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: FeedResponseDto })
  list(@Query() query: FeedQueryDto): Promise<FeedResponse> {
    return this.feed.feed(query);
  }
}
