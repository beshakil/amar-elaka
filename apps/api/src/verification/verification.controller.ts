import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import {
  EvidenceMediaParamDto,
  EvidencePresignDto,
  EvidencePresignedDto,
  EvidenceStatusDto,
  MyVerificationsDto,
  StoreEvidenceMediaParamDto,
  VerificationStoreParamDto,
  StoreVerificationDto,
  SubmitBusinessDto,
  SubmitIdentityDto,
  VerificationDecisionDto,
  VerificationDecisionResultDto,
  VerificationDetailDto,
  VerificationIdParamDto,
  VerificationQueueDto,
  VerificationQueueQueryDto,
  VerificationSubmittedDto,
  type DecisionResult,
  type EvidencePresigned,
  type EvidenceStatus,
  type MyVerifications,
  type StoreVerification,
  type VerificationDetail,
  type VerificationQueue,
} from './dto/verification.dto';
import { VerificationModerationService } from './verification-moderation.service';
import { VerificationService } from './verification.service';

/** A member's own identity verification (ADR 062), in their area. */
@Controller({ path: 'me/verifications', version: '1' })
@UseGuards(JwtAuthGuard)
export class MyVerificationController {
  constructor(private readonly verification: VerificationService) {}

  /** The caller's badge level, whether they can request now, and their requests. */
  @Get()
  @ApiOkResponse({ type: MyVerificationsDto })
  mine(): Promise<MyVerifications> {
    return this.verification.mine();
  }

  /** NID number (hashed at once, never stored) + a selfie uploaded through `evidence`. */
  @Post('identity')
  @ApiCreatedResponse({ type: VerificationSubmittedDto })
  identity(@Body() body: SubmitIdentityDto): Promise<{ id: string; status: 'submitted' }> {
    return this.verification.submitIdentity(body);
  }

  /** A private upload for a verification: PUT it to `upload.url`, confirm, wait until ready. */
  @Post('evidence')
  @ApiCreatedResponse({ type: EvidencePresignedDto })
  presign(@Body() body: EvidencePresignDto): Promise<EvidencePresigned> {
    return this.verification.presignOwn(body);
  }

  @Post('evidence/:mediaId/confirm')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ type: EvidenceStatusDto })
  confirm(@Param() params: EvidenceMediaParamDto): Promise<EvidenceStatus> {
    return this.verification.confirmOwn(params.mediaId);
  }

  @Get('evidence/:mediaId')
  @ApiOkResponse({ type: EvidenceStatusDto })
  status(@Param() params: EvidenceMediaParamDto): Promise<EvidenceStatus> {
    return this.verification.statusOwn(params.mediaId);
  }
}

/** A store's business verification (ADR 062), in the store's area; its owner submits. */
@Controller({ path: 'stores/:id/verification', version: '1' })
@UseGuards(JwtAuthGuard)
export class StoreVerificationController {
  constructor(private readonly verification: VerificationService) {}

  @Get()
  @ApiOkResponse({ type: StoreVerificationDto })
  get(@Param() params: VerificationStoreParamDto): Promise<StoreVerification> {
    return this.verification.store(params.id);
  }

  /** Trade licence (photo or PDF) + a shop-front photo with the owner. Needs the owner's identity checked. */
  @Post()
  @ApiCreatedResponse({ type: VerificationSubmittedDto })
  submit(
    @Param() params: VerificationStoreParamDto,
    @Body() body: SubmitBusinessDto,
  ): Promise<{ id: string; status: 'submitted' }> {
    return this.verification.submitBusiness(params.id, body);
  }

  @Post('evidence')
  @ApiCreatedResponse({ type: EvidencePresignedDto })
  presign(
    @Param() params: VerificationStoreParamDto,
    @Body() body: EvidencePresignDto,
  ): Promise<EvidencePresigned> {
    return this.verification.presignForStore(params.id, body);
  }

  @Post('evidence/:mediaId/confirm')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ type: EvidenceStatusDto })
  confirm(@Param() params: StoreEvidenceMediaParamDto): Promise<EvidenceStatus> {
    return this.verification.confirmForStore(params.id, params.mediaId);
  }

  @Get('evidence/:mediaId')
  @ApiOkResponse({ type: EvidenceStatusDto })
  status(@Param() params: StoreEvidenceMediaParamDto): Promise<EvidenceStatus> {
    return this.verification.statusForStore(params.id, params.mediaId);
  }
}

/** The area's verification queue (ADR 062): moderators with verifications:approve. */
@Controller({ path: 'verifications', version: '1' })
export class VerificationModerationController {
  constructor(private readonly moderation: VerificationModerationService) {}

  @Get('queue')
  @RequirePermission('verifications', 'read')
  @ApiOkResponse({ type: VerificationQueueDto })
  queue(@Query() query: VerificationQueueQueryDto): Promise<VerificationQueue> {
    return this.moderation.queue(query);
  }

  /** One request with its evidence, each behind a short-lived signed URL. */
  @Get(':id')
  @RequirePermission('verifications', 'read')
  @ApiOkResponse({ type: VerificationDetailDto })
  detail(@Param() params: VerificationIdParamDto): Promise<VerificationDetail> {
    return this.moderation.detail(params.id);
  }

  /** approve (optionally until an earlier date), reject with a reason, or request a field visit. */
  @Post(':id/decision')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('verifications', 'approve')
  @ApiOkResponse({ type: VerificationDecisionResultDto })
  decide(
    @Param() params: VerificationIdParamDto,
    @Body() body: VerificationDecisionDto,
  ): Promise<DecisionResult> {
    return this.moderation.decide(params.id, body);
  }
}
