import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';
import { RequirePermission } from '../rbac/require-permission.decorator';
import {
  ApproveSuggestionDto,
  PlaceReportDecisionDto,
  PlaceReportDecisionResultDto,
  PlaceReportQueueDto,
  PlaceReportResultDto,
  PlaceSuggestionDto,
  RejectSuggestionDto,
  ReportPlaceDto,
  ReportQueueQueryDto,
  SuggestionDecisionResultDto,
  SuggestionIdParamDto,
  SuggestionQueueDto,
  SuggestPlaceEditDto,
  type PlaceReportDecisionResult,
  type PlaceReportQueuePage,
  type PlaceReportResult,
  type PlaceSuggestionView,
  type SuggestionDecisionResult,
  type SuggestionQueuePage,
} from './dto/place-moderation.dto';
import { PageQueryDto, PlaceIdParamDto } from './dto/places.dto';
import { PlaceModerationService } from './place-moderation.service';

/**
 * Map-specific reporting and moderation (ADR 051): members report a place
 * or suggest an edit (/places/:id/report, /places/:id/suggestions);
 * moderators work the queues (/place-reports/…, /place-suggestions/…).
 */
@Controller({ version: '1' })
export class PlaceModerationController {
  constructor(private readonly moderation: PlaceModerationService) {}

  /**
   * Report a place. Reporting it again returns the open report. The answer
   * never says how many others reported it or whether it got flagged.
   */
  @Post('places/:id/report')
  @RequirePermission('places', 'write')
  @ApiCreatedResponse({ type: PlaceReportResultDto })
  report(
    @Param() params: PlaceIdParamDto,
    @Body() body: ReportPlaceDto,
  ): Promise<PlaceReportResult> {
    return this.moderation.report(params.id, body);
  }

  /** Places with open reports, grouped per place, oldest report first. */
  @Get('place-reports/queue')
  @RequirePermission('places', 'approve')
  @ApiOkResponse({ type: PlaceReportQueueDto })
  reportQueue(@Query() query: ReportQueueQueryDto): Promise<PlaceReportQueuePage> {
    return this.moderation.reportQueue(query);
  }

  /** Decide a place's open reports: dismiss, resolved, confirm_closed, clear_closed_flag, unpublish. */
  @Post('places/:id/reports/decision')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('places', 'approve')
  @ApiOkResponse({ type: PlaceReportDecisionResultDto })
  decide(
    @Param() params: PlaceIdParamDto,
    @Body() body: PlaceReportDecisionDto,
  ): Promise<PlaceReportDecisionResult> {
    return this.moderation.decide(params.id, body);
  }

  /** Suggest a location, phones or weekly hours; pending until a moderator decides. */
  @Post('places/:id/suggestions')
  @RequirePermission('places', 'write')
  @ApiCreatedResponse({ type: PlaceSuggestionDto })
  suggest(
    @Param() params: PlaceIdParamDto,
    @Body() body: SuggestPlaceEditDto,
  ): Promise<PlaceSuggestionView> {
    return this.moderation.suggest(params.id, body);
  }

  /** Pending suggestions, oldest first, beside the place's current values. */
  @Get('place-suggestions/queue')
  @RequirePermission('places', 'approve')
  @ApiOkResponse({ type: SuggestionQueueDto })
  suggestionQueue(@Query() query: PageQueryDto): Promise<SuggestionQueuePage> {
    return this.moderation.suggestionQueue(query);
  }

  /** Apply it to the place (recorded in its revisions) and credit the suggester's trust. */
  @Post('place-suggestions/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('places', 'approve')
  @ApiOkResponse({ type: SuggestionDecisionResultDto })
  approve(
    @Param() params: SuggestionIdParamDto,
    @Body() body: ApproveSuggestionDto,
  ): Promise<SuggestionDecisionResult> {
    return this.moderation.approve(params.id, body);
  }

  @Post('place-suggestions/:id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('places', 'approve')
  @ApiOkResponse({ type: SuggestionDecisionResultDto })
  reject(
    @Param() params: SuggestionIdParamDto,
    @Body() body: RejectSuggestionDto,
  ): Promise<SuggestionDecisionResult> {
    return this.moderation.reject(params.id, body);
  }
}
