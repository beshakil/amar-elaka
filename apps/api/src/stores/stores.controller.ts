import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import {
  CreateStoreDto,
  InviteStaffDto,
  MyStoresDto,
  StoreReviewQueueDto,
  StoreReviewQueueQueryDto,
  StaffParamDto,
  StaffViewDto,
  StoreIdParamDto,
  StorePageDto,
  StorePageQueryDto,
  StoreSlugParamDto,
  StoreStatusDto,
  StoreStatusResultDto,
  StoreViewDto,
  UpdateStoreDto,
  type MyStores,
  type StoreReviewQueue,
  type StaffView,
  type StorePage,
  type StoreStatusResult,
  type StoreView,
} from './dto/stores.dto';
import { StorePageService } from './store-page.service';
import { StoresService } from './stores.service';

/**
 * /api/v1/stores (ADR 054). Hours, special days and "closed today" are
 * HoursController's (/stores/:id/hours, /stores/:id/closed-today, ADR 049);
 * calling a store is POST /stores/:id/contact (EngagementController, a lead).
 * Writes need sign-in; who may do what is the store's (owner, manager,
 * editor — store-access.ts) and its RLS.
 */
@Controller({ path: 'stores', version: '1' })
export class StoresController {
  constructor(
    private readonly stores: StoresService,
    private readonly pages: StorePageService,
  ) {}

  /** The caller becomes the owner; the store's area is the one its location falls in. */
  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiCreatedResponse({ type: StoreViewDto })
  create(@Body() body: CreateStoreDto): Promise<StoreView> {
    return this.stores.create(body);
  }

  /** Stores I own or staff (every area), and invitations waiting for me. */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: MyStoresDto })
  mine(): Promise<MyStores> {
    return this.stores.mine();
  }

  /** Stores waiting for a moderator, oldest first. */
  @Get('review-queue')
  @RequirePermission('stores', 'approve')
  @ApiOkResponse({ type: StoreReviewQueueDto })
  reviewQueue(@Query() query: StoreReviewQueueQueryDto): Promise<StoreReviewQueue> {
    return this.stores.reviewQueue(query);
  }

  /** The public page. An old slug answers too, with the current one in `slug`. */
  @Get(':slug')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: StorePageDto })
  page(@Param() params: StoreSlugParamDto, @Query() query: StorePageQueryDto): Promise<StorePage> {
    return this.pages.page(params.slug, query);
  }

  /** The store as its owner and staff see it (limits, numbers, staff). */
  @Get(':id/manage')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: StoreViewDto })
  manage(@Param() params: StoreIdParamDto): Promise<StoreView> {
    return this.stores.view(params.id);
  }

  /** Owner and managers; the slug is the owner's, once. */
  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: StoreViewDto })
  update(@Param() params: StoreIdParamDto, @Body() body: UpdateStoreDto): Promise<StoreView> {
    return this.stores.update(params.id, body);
  }

  /** Invite by phone: the owner invites managers and editors, a manager editors. */
  @Post(':id/staff')
  @UseGuards(JwtAuthGuard)
  @ApiCreatedResponse({ type: StaffViewDto })
  invite(@Param() params: StoreIdParamDto, @Body() body: InviteStaffDto): Promise<StaffView> {
    return this.stores.inviteStaff(params.id, body);
  }

  /** The invitee accepts; until then they can't post as the store. */
  @Post(':id/staff/accept')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: StoreViewDto })
  accept(@Param() params: StoreIdParamDto): Promise<StoreView> {
    return this.stores.acceptInvitation(params.id);
  }

  /** The owner removes anyone, a manager editors; anyone may remove themselves (leave, decline). */
  @Delete(':id/staff/:memberId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiNoContentResponse()
  async removeStaff(@Param() params: StaffParamDto): Promise<void> {
    await this.stores.removeStaff(params.id, params.memberId);
  }

  /** Moderators: approve, suspend, reinstate or close (a moderation_actions row each). */
  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('stores', 'approve')
  @ApiOkResponse({ type: StoreStatusResultDto })
  setStatus(
    @Param() params: StoreIdParamDto,
    @Body() body: StoreStatusDto,
  ): Promise<StoreStatusResult> {
    return this.stores.setStatus(params.id, body);
  }
}
