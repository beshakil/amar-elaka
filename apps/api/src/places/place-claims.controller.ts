import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { RequirePermission } from '../rbac/require-permission.decorator';
import {
  ApproveClaimDto,
  ClaimDecisionResultDto,
  ClaimDto,
  ClaimIdParamDto,
  ClaimOtpDto,
  ClaimOtpSentDto,
  ClaimQueueDto,
  CreateClaimDto,
  PageQueryDto,
  PlaceIdParamDto,
  RejectClaimDto,
  type ClaimDecisionResult,
  type ClaimOtpSent,
  type ClaimQueuePage,
  type ClaimView,
} from './dto/places.dto';
import { PlaceClaimsService } from './place-claims.service';

/**
 * "এই দোকানটি আমার" (ADR 047): a member claims a place
 * (/places/:id/claim…), moderators decide (/place-claims/…).
 */
@Controller({ version: '1' })
export class PlaceClaimsController {
  constructor(private readonly claims: PlaceClaimsService) {}

  /** Sends a code to a number already on the place (when the area accepts OTP evidence). */
  @Post('places/:id/claim/otp')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('places', 'write')
  @ApiOkResponse({ type: ClaimOtpSentDto })
  requestOtp(
    @Param() params: PlaceIdParamDto,
    @Body() body: ClaimOtpDto,
    @Req() request: FastifyRequest,
  ): Promise<ClaimOtpSent> {
    return this.claims.requestOtp(params.id, body, request.ip);
  }

  /**
   * Claim the place with at least one kind of evidence. An OTP-verified claim
   * comes back `approved` when the area allows auto-approval; otherwise
   * `pending` until a moderator decides.
   */
  @Post('places/:id/claim')
  @RequirePermission('places', 'write')
  @ApiCreatedResponse({ type: ClaimDto })
  create(@Param() params: PlaceIdParamDto, @Body() body: CreateClaimDto): Promise<ClaimView> {
    return this.claims.create(params.id, body);
  }

  /** Pending claims, oldest first. */
  @Get('place-claims/queue')
  @RequirePermission('places', 'approve')
  @ApiOkResponse({ type: ClaimQueueDto })
  queue(@Query() query: PageQueryDto): Promise<ClaimQueuePage> {
    return this.claims.queue(query);
  }

  /** Approve: the claimant's store is created (or `storeId` linked) and the place becomes its pin. */
  @Post('place-claims/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('places', 'approve')
  @ApiOkResponse({ type: ClaimDecisionResultDto })
  approve(
    @Param() params: ClaimIdParamDto,
    @Body() body: ApproveClaimDto,
  ): Promise<ClaimDecisionResult> {
    return this.claims.approve(params.id, body);
  }

  @Post('place-claims/:id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('places', 'approve')
  @ApiOkResponse({ type: ClaimDecisionResultDto })
  reject(
    @Param() params: ClaimIdParamDto,
    @Body() body: RejectClaimDto,
  ): Promise<ClaimDecisionResult> {
    return this.claims.reject(params.id, body);
  }
}
