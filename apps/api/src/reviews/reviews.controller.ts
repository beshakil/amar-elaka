import { ActiveAccountRequired } from '../auth/ban-access.decorator';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { PlatformAdmin } from '../rbac/platform-admin.decorator';
import { RequirePermission } from '../rbac/require-permission.decorator';
import {
  EligibilityDto,
  RespondDto,
  RespondResultDto,
  ReportReviewDto,
  ReviewDecisionDto,
  ReviewDecisionResultDto,
  ReviewIdParamDto,
  ReviewImageParamDto,
  ReviewImagePresignDto,
  ReviewImagePresignedDto,
  ReviewImageStatusDto,
  ReviewPageDto,
  ReviewPageQueryDto,
  ReviewModerationQueueDto,
  ReviewQueueQueryDto,
  ReviewReportResultDto,
  ScrubAuthorDto,
  ScrubResultDto,
  StoreIdParamDto,
  StoreReviewParamDto,
  UserIdParamDto,
  WriteResultDto,
  WriteReviewDto,
  type Eligibility,
  type ReportResult,
  type ReviewDecisionResult,
  type ReviewImagePresigned,
  type ReviewImageStatus,
  type ReviewPage,
  type ReviewQueue,
  type WriteResult,
} from './dto/reviews.dto';
import { ReviewModerationService } from './review-moderation.service';
import { ReviewsService } from './reviews.service';

/**
 * A store's reviews (ADR 061). A store may live in another tenant than the
 * caller's token: every route runs in the store's own tenant.
 */
@Controller({ path: 'stores/:id/reviews', version: '1' })
export class StoreReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  /** Published reviews, newest first, with the summary and the seller tier. */
  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: ReviewPageDto })
  page(@Param() params: StoreIdParamDto, @Query() query: ReviewPageQueryDto): Promise<ReviewPage> {
    return this.reviews.page(params.id, query);
  }

  /** May the caller review this store (a real contact, in the window) — and their review, if any. */
  @Get('eligibility')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: EligibilityDto })
  eligibility(@Param() params: StoreIdParamDto): Promise<Eligibility> {
    return this.reviews.eligibility(params.id);
  }

  /** Write the caller's review (once per store); flagged ones wait for a moderator. */
  @Post()
  @UseGuards(JwtAuthGuard)
  @ActiveAccountRequired()
  @ApiCreatedResponse({ type: WriteResultDto })
  submit(@Param() params: StoreIdParamDto, @Body() body: WriteReviewDto): Promise<WriteResult> {
    return this.reviews.submit(params.id, body);
  }

  /** Edit the caller's review within review_edit_days. */
  @Patch('mine')
  @ActiveAccountRequired()
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: WriteResultDto })
  edit(@Param() params: StoreIdParamDto, @Body() body: WriteReviewDto): Promise<WriteResult> {
    return this.reviews.edit(params.id, body);
  }

  /** The store's reply: its owner or a manager; once per review, editable. */
  @Put(':reviewId/response')
  @ActiveAccountRequired()
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: RespondResultDto })
  respond(
    @Param() params: StoreReviewParamDto,
    @Body() body: RespondDto,
  ): Promise<{ created: boolean }> {
    return this.reviews.respond(params.id, params.reviewId, body);
  }

  /** Report a review. The store can never delete one — it reports, a moderator decides. */
  @Post(':reviewId/report')
  @UseGuards(JwtAuthGuard)
  @ApiCreatedResponse({ type: ReviewReportResultDto })
  report(
    @Param() params: StoreReviewParamDto,
    @Body() body: ReportReviewDto,
  ): Promise<ReportResult> {
    return this.reviews.report(params.id, params.reviewId, body);
  }

  /** A photo for a review: PUT it to `upload.url`, confirm, wait until ready, then send its id. */
  @Post('images')
  @ActiveAccountRequired()
  @UseGuards(JwtAuthGuard)
  @ApiCreatedResponse({ type: ReviewImagePresignedDto })
  presignImage(
    @Param() params: StoreIdParamDto,
    @Body() body: ReviewImagePresignDto,
  ): Promise<ReviewImagePresigned> {
    return this.reviews.presignImage(params.id, body);
  }

  @Post('images/:mediaId/confirm')
  @ActiveAccountRequired()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ type: ReviewImageStatusDto })
  confirmImage(@Param() params: ReviewImageParamDto): Promise<ReviewImageStatus> {
    return this.reviews.confirmImage(params.id, params.mediaId);
  }

  @Get('images/:mediaId')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: ReviewImageStatusDto })
  imageStatus(@Param() params: ReviewImageParamDto): Promise<ReviewImageStatus> {
    return this.reviews.imageStatus(params.id, params.mediaId);
  }
}

/** The area's moderators: held and reported reviews (ADR 061). */
@Controller({ path: 'reviews', version: '1' })
export class ReviewModerationController {
  constructor(private readonly moderation: ReviewModerationService) {}

  /** Reviews waiting (flagged) and published ones with open reports, oldest first. */
  @Get('queue')
  @RequirePermission('reports', 'read')
  @ApiOkResponse({ type: ReviewModerationQueueDto })
  queue(@Query() query: ReviewQueueQueryDto): Promise<ReviewQueue> {
    return this.moderation.queue(query);
  }

  /** publish, hide or remove — with a reason; writes moderation_actions and closes the reports. */
  @Post(':id/decision')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('reports', 'approve')
  @ApiOkResponse({ type: ReviewDecisionResultDto })
  decide(
    @Param() params: ReviewIdParamDto,
    @Body() body: ReviewDecisionDto,
  ): Promise<ReviewDecisionResult> {
    return this.moderation.decide(params.id, body);
  }
}

/** Platform staff: a privacy request against a review author (ADR 061). */
@Controller({ path: 'platform/users/:userId/reviews', version: '1' })
export class PlatformReviewsController {
  constructor(private readonly moderation: ReviewModerationService) {}

  /** Scrub the author everywhere: name and text gone, ratings kept; refused under a legal hold. */
  @Post('scrub')
  @PlatformAdmin()
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: ScrubResultDto })
  scrub(
    @Param() params: UserIdParamDto,
    @Body() body: ScrubAuthorDto,
  ): Promise<{ scrubbed: number }> {
    return this.moderation.scrubAuthor(params.userId, body.reason);
  }
}
