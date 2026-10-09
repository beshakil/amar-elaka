import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { ValidationException } from '../common/exceptions/validation.exception';
import { RequirePermission } from '../rbac/require-permission.decorator';
import {
  CreatePostDto,
  idempotencyKeySchema,
  MarkSoldDto,
  SetStockDto,
  MyPostCountsDto,
  MyPostsDto,
  MyPostsQueryDto,
  OwnershipDto,
  OwnershipQueryDto,
  PostDto,
  PostIdParamDto,
  UpdatePostDto,
  type MyPostCounts,
  type MyPostsPage,
  type OwnershipView,
  type PostView,
  type ScrubbedPostView,
} from './dto/posts.dto';
import { PostsService } from './posts.service';

/**
 * /api/v1/posts — thin: validation (zod DTOs) and HTTP shape only; every rule
 * lives in PostsService, every status change in post-state-machine.ts.
 * Static routes (`me`, `ownership`) are declared before `:id`.
 */
@Controller({ path: 'posts', version: '1' })
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  /**
   * Create a draft, or `submit: true` to send it for review (straight to live
   * in a post-moderated tenant). An `Idempotency-Key` header makes retries
   * safe: the same key and body return the same post (200) instead of a new one.
   */
  @Post()
  @RequirePermission('posts', 'write')
  @ApiCreatedResponse({ type: PostDto })
  async create(
    @Body() body: CreatePostDto,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<PostView> {
    let key: string | undefined;
    if (rawKey !== undefined) {
      const parsed = idempotencyKeySchema.safeParse(rawKey);
      if (!parsed.success) throw new ValidationException(parsed.error);
      key = parsed.data;
    }
    const { post, replayed } = await this.posts.create(body, key);
    void reply.status(replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return post;
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: MyPostsDto })
  listMine(@Query() query: MyPostsQueryDto): Promise<MyPostsPage> {
    return this.posts.listMine(query);
  }

  /** The "my posts" tab counts. */
  @Get('me/counts')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: MyPostCountsDto })
  countMine(): Promise<MyPostCounts> {
    return this.posts.countMine();
  }

  /** Which area a post at this point will be listed in — ask before uploading photos. */
  @Get('ownership')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: OwnershipDto })
  ownership(@Query() query: OwnershipQueryDto): Promise<OwnershipView> {
    return this.posts.ownershipAt(query.lat, query.lng);
  }

  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: PostDto })
  get(@Param() params: PostIdParamDto): Promise<PostView | ScrubbedPostView> {
    return this.posts.get(params.id);
  }

  @Patch(':id')
  @RequirePermission('posts', 'write')
  @ApiOkResponse({ type: PostDto })
  update(@Param() params: PostIdParamDto, @Body() body: UpdatePostDto): Promise<PostView> {
    return this.posts.update(params.id, body);
  }

  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('posts', 'write')
  @ApiOkResponse({ type: PostDto })
  submit(@Param() params: PostIdParamDto): Promise<PostView> {
    return this.posts.submit(params.id);
  }

  @Post(':id/sold')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('posts', 'write')
  @ApiOkResponse({ type: PostDto })
  sold(@Param() params: PostIdParamDto, @Body() body: MarkSoldDto): Promise<PostView> {
    return this.posts.markSold(params.id, body);
  }

  /**
   * The one-tap repost: expired → live with a fresh listing period. A live
   * post inside the expiry-reminder window (post_expiry_reminder_days) is
   * renewed instead; earlier → 409 POST_RENEW_TOO_EARLY.
   */
  @Post(':id/repost')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('posts', 'write')
  @ApiOkResponse({ type: PostDto })
  repost(@Param() params: PostIdParamDto): Promise<PostView> {
    return this.posts.repost(params.id);
  }

  @Post(':id/hide')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('posts', 'write')
  @ApiOkResponse({ type: PostDto })
  hide(@Param() params: PostIdParamDto): Promise<PostView> {
    return this.posts.setHidden(params.id, true);
  }

  @Post(':id/unhide')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('posts', 'write')
  @ApiOkResponse({ type: PostDto })
  unhide(@Param() params: PostIdParamDto): Promise<PostView> {
    return this.posts.setHidden(params.id, false);
  }

  /** A store product's stock (ADR 057): its author, or the store's owner and managers. */
  @Post(':id/stock')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('posts', 'write')
  @ApiOkResponse({ type: PostDto })
  setStock(@Param() params: PostIdParamDto, @Body() body: SetStockDto): Promise<PostView> {
    return this.posts.setStock(params.id, body.stockStatus);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('posts', 'delete')
  @ApiNoContentResponse()
  async remove(@Param() params: PostIdParamDto): Promise<void> {
    await this.posts.remove(params.id);
  }
}
