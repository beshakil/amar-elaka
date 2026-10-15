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
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { AppealAllowed } from '../auth/ban-access.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AllowAnyTenant } from '../database/allow-any-tenant.decorator';
import { PlatformAdmin } from '../rbac/platform-admin.decorator';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { AppealsService } from './appeals.service';
import { BansService } from './bans.service';
import { BlacklistService } from './blacklist.service';
import { ComplaintsService } from './complaints.service';
import {
  AccountAppealsDto,
  AccountAppealSubmitDto,
  AppealDecisionDto,
  AppealDecisionResultDto,
  AppealIdParamDto,
  AppealOtpAcceptedDto,
  AppealOtpRequestDto,
  AppealQueueDto,
  AppealQueueQueryDto,
  AppealStatusRequestDto,
  AppealSubmittedDto,
  BanIdParamDto,
  BanListDto,
  BanListQueryDto,
  BanMemberLookupDto,
  BanMemberQueryDto,
  BanNoticesDto,
  BlacklistDecisionDto,
  BlacklistDecisionResultDto,
  BlacklistIdParamDto,
  BlacklistPageDto,
  BlacklistQueryDto,
  BlacklistRecommendedDto,
  ComplaintAssigneesDto,
  ComplaintIdParamDto,
  ComplaintQueueDto,
  ComplaintQueueQueryDto,
  ComplaintResolvedDto,
  ComplaintSubmittedDto,
  ComplaintUpdatedDto,
  IssueBanDto,
  IssuedBanDto,
  LiftBanDto,
  LiftedBanDto,
  MyComplaintsDto,
  PublicAppealStatusDto,
  PublicAppealSubmitDto,
  RecommendBlacklistDto,
  ResolveComplaintDto,
  RevokeBlacklistDto,
  SubmitComplaintDto,
  UpdateComplaintDto,
  type AccountAppeals,
  type AppealOtpAccepted,
  type AppealDecisionResult,
  type AppealQueue,
  type AppealSubmitted,
  type BanList,
  type BanMemberLookup,
  type BanNotices,
  type BlacklistPage,
  type ComplaintAssignees,
  type ComplaintQueue,
  type ComplaintSubmitted,
  type ComplaintUpdated,
  type IssuedBan,
  type MyComplaints,
  type PublicAppealStatus,
} from './dto/bans.dto';

function userAgentOf(request: FastifyRequest): string | undefined {
  const value = request.headers['user-agent'];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The person's own bans and appeals (ADR 063). On a banned session's
 * allow-list (§9.10): the notice — why, how long, which area, the reference —
 * and the appeal.
 */
@Controller({ path: 'account', version: '1' })
@UseGuards(JwtAuthGuard)
@AppealAllowed()
export class AccountBansController {
  constructor(private readonly appeals: AppealsService) {}

  @Get('bans')
  @ApiOkResponse({ type: BanNoticesDto })
  bans(): Promise<BanNotices> {
    return this.appeals.notices();
  }

  @Get('appeals')
  @ApiOkResponse({ type: AccountAppealsDto })
  myAppeals(): Promise<AccountAppeals> {
    return this.appeals.myAppeals();
  }

  @Post('appeals')
  @ApiCreatedResponse({ type: AppealSubmittedDto })
  appeal(@Body() body: AccountAppealSubmitDto): Promise<AppealSubmitted> {
    return this.appeals.submitInApp(body);
  }
}

/**
 * The public appeal path (§9.10) for a terminated person, or anyone who
 * can't sign in: no session is ever issued. Rate-limited by the OTP limits
 * and appeal_rate_limit_per_day.
 */
@Controller({ path: 'appeals', version: '1' })
@AllowAnyTenant()
export class PublicAppealsController {
  constructor(private readonly appeals: AppealsService) {}

  /** Always 202 with the same body: whether the phone has a ban is never revealed. */
  @Post('request-otp')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ type: AppealOtpAcceptedDto })
  requestOtp(
    @Body() body: AppealOtpRequestDto,
    @Req() request: FastifyRequest,
  ): Promise<AppealOtpAccepted> {
    return this.appeals.requestOtp(body.phone, request.ip);
  }

  /** POST so the code never lands in a URL or a log. */
  @Post('status')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: PublicAppealStatusDto })
  status(@Body() body: AppealStatusRequestDto): Promise<PublicAppealStatus> {
    return this.appeals.status(body.phone, body.otp);
  }

  @Post('submit')
  @ApiCreatedResponse({ type: AppealSubmittedDto })
  submit(
    @Body() body: PublicAppealSubmitDto,
    @Req() request: FastifyRequest,
  ): Promise<AppealSubmitted> {
    return this.appeals.submitPublic(body, request.ip, userAgentOf(request));
  }
}

/** An area's bans: moderators issue temporary ones, admins also permanent ones and lifts. */
@Controller({ path: 'bans', version: '1' })
export class BanModerationController {
  constructor(private readonly bans: BansService) {}

  @Get()
  @RequirePermission('bans', 'read')
  @ApiOkResponse({ type: BanListDto })
  list(@Query() query: BanListQueryDto): Promise<BanList> {
    return this.bans.list(query);
  }

  /** A member of this area by exact phone (the phone is not echoed). */
  @Get('members')
  @RequirePermission('bans', 'read')
  @ApiOkResponse({ type: BanMemberLookupDto })
  findMember(@Query() query: BanMemberQueryDto): Promise<BanMemberLookup> {
    return this.bans.findMember(query.phone);
  }

  @Post()
  @RequirePermission('bans', 'write')
  @ApiCreatedResponse({ type: IssuedBanDto })
  issue(@Body() body: IssueBanDto): Promise<IssuedBan> {
    return this.bans.issue(body);
  }

  @Post(':id/lift')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('bans', 'write')
  @ApiOkResponse({ type: LiftedBanDto })
  lift(@Param() params: BanIdParamDto, @Body() body: LiftBanDto): Promise<{ status: 'revoked' }> {
    return this.bans.lift(params.id, body.reason);
  }
}

/** The area's admins: appeals of the area's bans, before any escalation. */
@Controller({ path: 'appeals', version: '1' })
export class AppealModerationController {
  constructor(private readonly appeals: AppealsService) {}

  @Get('queue')
  @RequirePermission('appeals', 'read')
  @ApiOkResponse({ type: AppealQueueDto })
  queue(@Query() query: AppealQueueQueryDto): Promise<AppealQueue> {
    return this.appeals.queue('area', query);
  }

  /** grant and reduce are final; uphold only recommends it to the platform. */
  @Post(':id/decision')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('appeals', 'approve')
  @ApiOkResponse({ type: AppealDecisionResultDto })
  decide(
    @Param() params: AppealIdParamDto,
    @Body() body: AppealDecisionDto,
  ): Promise<AppealDecisionResult> {
    return this.appeals.decide(params.id, body);
  }
}

/** Platform: escalated area appeals and every global one; only platform_admin decides. */
@Controller({ path: 'platform/appeals', version: '1' })
export class PlatformAppealsController {
  constructor(private readonly appeals: AppealsService) {}

  @Get()
  @PlatformAdmin()
  @ApiOkResponse({ type: AppealQueueDto })
  queue(@Query() query: AppealQueueQueryDto): Promise<AppealQueue> {
    return this.appeals.queue('platform', query);
  }

  @Post(':id/decision')
  @PlatformAdmin()
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AppealDecisionResultDto })
  decide(
    @Param() params: AppealIdParamDto,
    @Body() body: AppealDecisionDto,
  ): Promise<AppealDecisionResult> {
    return this.appeals.decide(params.id, body);
  }
}

/** An area's admins recommend someone for the global blacklist; nothing more. */
@Controller({ path: 'blacklist/recommendations', version: '1' })
export class BlacklistRecommendationsController {
  constructor(private readonly blacklist: BlacklistService) {}

  @Get()
  @RequirePermission('blacklist', 'read')
  @ApiOkResponse({ type: BlacklistPageDto })
  mine(@Query() query: BlacklistQueryDto): Promise<BlacklistPage> {
    return this.blacklist.page('area', query);
  }

  @Post()
  @RequirePermission('blacklist', 'write')
  @ApiCreatedResponse({ type: BlacklistRecommendedDto })
  recommend(@Body() body: RecommendBlacklistDto): Promise<{ id: string; reference: string }> {
    return this.blacklist.recommend(body);
  }
}

/** platform_admin approves or rejects recommendations, and revokes entries. */
@Controller({ path: 'platform/blacklist', version: '1' })
export class PlatformBlacklistController {
  constructor(private readonly blacklist: BlacklistService) {}

  @Get()
  @PlatformAdmin()
  @ApiOkResponse({ type: BlacklistPageDto })
  page(@Query() query: BlacklistQueryDto): Promise<BlacklistPage> {
    return this.blacklist.page('platform', query);
  }

  @Post(':id/decision')
  @PlatformAdmin()
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: BlacklistDecisionResultDto })
  decide(
    @Param() params: BlacklistIdParamDto,
    @Body() body: BlacklistDecisionDto,
  ): Promise<{ status: string }> {
    return this.blacklist.decide(params.id, body);
  }

  @Post(':id/revoke')
  @PlatformAdmin()
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: LiftedBanDto })
  revoke(
    @Param() params: BlacklistIdParamDto,
    @Body() body: RevokeBlacklistDto,
  ): Promise<{ status: 'revoked' }> {
    return this.blacklist.revoke(params.id, body.reason);
  }
}

/** Complaints: members file them; the area's moderators and executives work them. */
@Controller({ path: 'complaints', version: '1' })
export class ComplaintsController {
  constructor(private readonly complaints: ComplaintsService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiCreatedResponse({ type: ComplaintSubmittedDto })
  submit(@Body() body: SubmitComplaintDto): Promise<ComplaintSubmitted> {
    return this.complaints.submit(body);
  }

  @Get('mine')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: MyComplaintsDto })
  mine(): Promise<MyComplaints> {
    return this.complaints.mine();
  }

  @Get('queue')
  @RequirePermission('complaints', 'read')
  @ApiOkResponse({ type: ComplaintQueueDto })
  queue(@Query() query: ComplaintQueueQueryDto): Promise<ComplaintQueue> {
    return this.complaints.queue(query);
  }

  @Get('assignees')
  @RequirePermission('complaints', 'read')
  @ApiOkResponse({ type: ComplaintAssigneesDto })
  assignees(): Promise<ComplaintAssignees> {
    return this.complaints.assignees();
  }

  @Patch(':id')
  @RequirePermission('complaints', 'write')
  @ApiOkResponse({ type: ComplaintUpdatedDto })
  update(
    @Param() params: ComplaintIdParamDto,
    @Body() body: UpdateComplaintDto,
  ): Promise<ComplaintUpdated> {
    return this.complaints.update(params.id, body);
  }

  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('complaints', 'write')
  @ApiOkResponse({ type: ComplaintResolvedDto })
  resolve(
    @Param() params: ComplaintIdParamDto,
    @Body() body: ResolveComplaintDto,
  ): Promise<{ status: 'resolved' }> {
    return this.complaints.resolve(params.id, body);
  }
}
