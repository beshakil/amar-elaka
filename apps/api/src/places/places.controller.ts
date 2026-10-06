import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import {
  CreatePlaceDto,
  PageQueryDto,
  PlaceDecisionDto,
  PlaceDecisionResultDto,
  PlaceDto,
  PlaceIdParamDto,
  RevertResultDto,
  ReviewQueueDto,
  RevisionPageDto,
  RevisionParamDto,
  UpdatePlaceDto,
  type PlaceDecisionResult,
  type PlaceView,
  type RevertResult,
  type ReviewQueuePage,
  type RevisionPage,
} from './dto/places.dto';
import { PlacesService } from './places.service';

/**
 * /api/v1/places — user-contributed places (ADR 047). Thin: validation and
 * HTTP shape; rules live in PlacesService. Static routes (`review-queue`)
 * come before `:id`.
 */
@Controller({ path: 'places', version: '1' })
export class PlacesController {
  constructor(private readonly places: PlacesService) {}

  /**
   * Map a place. It belongs to the area its location falls in (boundary +
   * buffer, as posts); it goes live at once for field agents, moderators and
   * members at or above place_contribution_trust_threshold, else it waits
   * for review (`status: pending_review`).
   */
  @Post()
  @RequirePermission('places', 'write')
  @ApiCreatedResponse({ type: PlaceDto })
  create(@Body() body: CreatePlaceDto): Promise<PlaceView> {
    return this.places.create(body);
  }

  /** Contributions waiting for a moderator, oldest first. */
  @Get('review-queue')
  @RequirePermission('places', 'approve')
  @ApiOkResponse({ type: ReviewQueueDto })
  reviewQueue(@Query() query: PageQueryDto): Promise<ReviewQueuePage> {
    return this.places.reviewQueue(query);
  }

  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: PlaceDto })
  get(@Param() params: PlaceIdParamDto): Promise<PlaceView> {
    return this.places.get(params.id);
  }

  /** Staff, field agents and the verified owner. Every change becomes a revision. */
  @Patch(':id')
  @RequirePermission('places', 'write')
  @ApiOkResponse({ type: PlaceDto })
  update(@Param() params: PlaceIdParamDto, @Body() body: UpdatePlaceDto): Promise<PlaceView> {
    return this.places.update(params.id, body);
  }

  /** The place's edit history, newest first (staff, agents, the verified owner). */
  @Get(':id/revisions')
  @RequirePermission('places', 'read')
  @ApiOkResponse({ type: RevisionPageDto })
  revisions(@Param() params: PlaceIdParamDto, @Query() query: PageQueryDto): Promise<RevisionPage> {
    return this.places.revisions(params.id, query);
  }

  /** Put a bad edit's previous values back. 409 when a field changed again since. */
  @Post(':id/revisions/:revisionId/revert')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('places', 'approve')
  @ApiOkResponse({ type: RevertResultDto })
  revert(@Param() params: RevisionParamDto, @Body() body: PlaceDecisionDto): Promise<RevertResult> {
    return this.places.revert(params.id, params.revisionId, body);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('places', 'approve')
  @ApiOkResponse({ type: PlaceDecisionResultDto })
  approve(@Param() params: PlaceIdParamDto): Promise<PlaceDecisionResult> {
    return this.places.approve(params.id);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('places', 'approve')
  @ApiOkResponse({ type: PlaceDecisionResultDto })
  reject(
    @Param() params: PlaceIdParamDto,
    @Body() body: PlaceDecisionDto,
  ): Promise<PlaceDecisionResult> {
    return this.places.reject(params.id, body);
  }
}
