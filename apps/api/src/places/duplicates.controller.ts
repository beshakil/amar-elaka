import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import { RequirePermission } from '../rbac/require-permission.decorator';
import {
  DuplicateIdParamDto,
  DuplicatePageDto,
  DuplicateQueryDto,
  MergeIdParamDto,
  MergeParamDto,
  MergeResultDto,
  PlaceDecisionDto,
  UndoResultDto,
  type DuplicatePage,
  type MergeResult,
  type UndoResult,
} from './dto/places.dto';
import { DuplicatesService } from './duplicates.service';

/**
 * Duplicate review and the merge tool (ADR 048), moderators only
 * (`places:approve`), always in their own tenant.
 */
@Controller({ version: '1' })
export class DuplicatesController {
  constructor(private readonly duplicates: DuplicatesService) {}

  /** Flagged pairs of places and stores, likely first. */
  @Get('places/duplicates')
  @RequirePermission('places', 'approve')
  @ApiOkResponse({ type: DuplicatePageDto })
  queue(@Query() query: DuplicateQueryDto): Promise<DuplicatePage> {
    return this.duplicates.queue(query);
  }

  /** "Not a duplicate": the pair is never flagged again. */
  @Post('places/duplicates/:id/dismiss')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('places', 'approve')
  @ApiNoContentResponse()
  async dismiss(@Param() params: DuplicateIdParamDto): Promise<void> {
    await this.duplicates.dismiss(params.id);
  }

  /**
   * Merge place `id` into `targetId`: photos, revisions, saves, reviews, lead
   * history and claims move; `id` stays as a redirect. Undoable for
   * merge_undo_days.
   */
  @Post('places/:id/merge-into/:targetId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('places', 'approve')
  @ApiOkResponse({ type: MergeResultDto })
  merge(@Param() params: MergeParamDto, @Body() body: PlaceDecisionDto): Promise<MergeResult> {
    return this.duplicates.merge(params.id, params.targetId, body);
  }

  @Post('place-merges/:id/undo')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('places', 'approve')
  @ApiOkResponse({ type: UndoResultDto })
  undo(@Param() params: MergeIdParamDto): Promise<UndoResult> {
    return this.duplicates.undo(params.id);
  }
}
