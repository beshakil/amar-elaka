import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  FollowResultDto,
  SavedItemParamDto,
  SavedPageDto,
  SavedQueryDto,
  SaveResultDto,
  StoreIdParamDto,
  type FollowResult,
  type SavedPage,
  type SaveResult,
} from './dto/saved.dto';
import { SavedService } from './saved.service';

/** /api/v1/saved — the signed-in user's saved posts, places and stores, across tenants (ADR 037). */
@Controller({ path: 'saved', version: '1' })
@UseGuards(JwtAuthGuard)
export class SavedController {
  constructor(private readonly saved: SavedService) {}

  /** Newest first; `type` narrows to one kind. Items keep their place with a state when they stop being available. */
  @Get()
  @ApiOkResponse({ type: SavedPageDto })
  list(@Query() query: SavedQueryDto): Promise<SavedPage> {
    return this.saved.list(query);
  }

  /** 201 when saved now, 200 when it already was. */
  @Post(':itemType/:itemId')
  @ApiOkResponse({ type: SaveResultDto })
  async save(
    @Param() params: SavedItemParamDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SaveResult> {
    const result = await this.saved.save(params.itemType, params.itemId);
    void reply.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return result;
  }

  @Delete(':itemType/:itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async unsave(@Param() params: SavedItemParamDto): Promise<void> {
    await this.saved.unsave(params.itemType, params.itemId);
  }
}

/** /api/v1/stores/:id/follow — follow a store (its follower_count); no following feed yet (ADR 037). */
@Controller({ path: 'stores', version: '1' })
@UseGuards(JwtAuthGuard)
export class StoreFollowsController {
  constructor(private readonly saved: SavedService) {}

  @Post(':id/follow')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: FollowResultDto })
  follow(@Param() params: StoreIdParamDto): Promise<FollowResult> {
    return this.saved.follow(params.id);
  }

  @Delete(':id/follow')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: FollowResultDto })
  unfollow(@Param() params: StoreIdParamDto): Promise<FollowResult> {
    return this.saved.unfollow(params.id);
  }
}
