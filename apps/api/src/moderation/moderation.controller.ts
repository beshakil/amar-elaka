import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { RequirePermission } from '../rbac/require-permission.decorator';
import {
  BulkDto,
  BulkResultDto,
  DecisionDto,
  HardRemoveDto,
  ModerationPostParamDto,
  ModerationResultDto,
  QueuePageDto,
  QueueQueryDto,
  type BulkResult,
  type ModerationResult,
  type QueuePage,
} from './dto/moderation.dto';
import { ModerationService } from './moderation.service';

/**
 * /api/v1/moderation — the tenant's moderation queue. `posts:approve`
 * (moderators and tenant admins) for everything except hard removal, which
 * is irreversible and needs `posts:delete` (tenant admins).
 */
@Controller({ path: 'moderation', version: '1' })
export class ModerationController {
  constructor(private readonly moderation: ModerationService) {}

  @Get('queue')
  @RequirePermission('posts', 'approve')
  @ApiOkResponse({ type: QueuePageDto })
  queue(@Query() query: QueueQueryDto): Promise<QueuePage> {
    return this.moderation.queue(query);
  }

  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('posts', 'approve')
  @ApiOkResponse({ type: BulkResultDto })
  bulk(@Body() body: BulkDto): Promise<BulkResult> {
    return this.moderation.bulk(body);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('posts', 'approve')
  @ApiOkResponse({ type: ModerationResultDto })
  approve(@Param() params: ModerationPostParamDto): Promise<ModerationResult> {
    return this.moderation.approve(params.id);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('posts', 'approve')
  @ApiOkResponse({ type: ModerationResultDto })
  reject(
    @Param() params: ModerationPostParamDto,
    @Body() body: DecisionDto,
  ): Promise<ModerationResult> {
    return this.moderation.reject(params.id, body);
  }

  @Post(':id/remove')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('posts', 'approve')
  @ApiOkResponse({ type: ModerationResultDto })
  remove(
    @Param() params: ModerationPostParamDto,
    @Body() body: DecisionDto,
  ): Promise<ModerationResult> {
    return this.moderation.remove(params.id, body);
  }

  @Post(':id/hard-remove')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('posts', 'delete')
  @ApiOkResponse({ type: ModerationResultDto })
  hardRemove(
    @Param() params: ModerationPostParamDto,
    @Body() body: HardRemoveDto,
  ): Promise<ModerationResult> {
    return this.moderation.hardRemove(params.id, body);
  }
}
