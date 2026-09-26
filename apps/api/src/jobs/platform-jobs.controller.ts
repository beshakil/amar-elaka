import {
  applyDecorators,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiOkResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PlatformAdminOnlyGuard } from '../categories/platform-admin-only';
import { AllowAnyTenant } from '../database/allow-any-tenant.decorator';
import { REQUIRE_PERMISSION_KEY, type RequiredPermission } from '../rbac/permission.metadata';
import { PlatformAdminGuard } from '../rbac/platform-admin.guard';
import {
  JobCodeParamDto,
  JobHealthDto,
  JobRunDto,
  JobTriggeredDto,
  type JobHealth,
  type JobRun,
  type JobTriggered,
} from './dto/platform-jobs.dto';
import { PlatformJobsService } from './platform-jobs.service';

/**
 * Platform admins only (not support or finance). The permission metadata is
 * for the global AuditLogInterceptor: every manual trigger lands in audit_logs.
 */
const PlatformJobsAdmin = (action: 'read' | 'write'): ReturnType<typeof applyDecorators> =>
  applyDecorators(
    AllowAnyTenant(),
    UseGuards(JwtAuthGuard, PlatformAdminGuard, PlatformAdminOnlyGuard),
    SetMetadata(REQUIRE_PERMISSION_KEY, { module: 'jobs', action } satisfies RequiredPermission),
  );

/** /api/v1/platform/jobs — the scheduled lifecycle jobs: health, run history, manual trigger (ADR 031). */
@Controller({ path: 'platform/jobs', version: '1' })
export class PlatformJobsController {
  constructor(private readonly jobs: PlatformJobsService) {}

  /** Every job: its schedule and next run, last run, last success and last failure. */
  @Get()
  @PlatformJobsAdmin('read')
  @ApiOkResponse({ type: JobHealthDto, isArray: true })
  health(): Promise<JobHealth[]> {
    return this.jobs.health();
  }

  @Get(':code/runs')
  @PlatformJobsAdmin('read')
  @ApiOkResponse({ type: JobRunDto, isArray: true })
  runs(@Param() params: JobCodeParamDto): Promise<JobRun[]> {
    return this.jobs.history(params.code);
  }

  /** Runs the job now, in the worker (for testing); it shows up in the history as a manual run. */
  @Post(':code/run')
  @HttpCode(HttpStatus.ACCEPTED)
  @PlatformJobsAdmin('write')
  @ApiAcceptedResponse({ type: JobTriggeredDto })
  trigger(@Param() params: JobCodeParamDto): Promise<JobTriggered> {
    return this.jobs.trigger(params.code);
  }
}
