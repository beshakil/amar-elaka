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
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { ActiveAccountRequired } from '../auth/ban-access.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AgentSubmissionsService } from './agent-submissions.service';
import { AgentWorkService } from './agent-work.service';
import { AgentsAdminService } from './agents-admin.service';
import {
  AgentCreatedDto,
  AgentIdParamDto,
  AgentListDto,
  AgentMeDto,
  AgentStatsDto,
  AgentTodayDto,
  CommissionReportDto,
  CreateAgentDto,
  CreateTaskDto,
  DayQueryDto,
  PeriodQueryDto,
  PhoneCheckDto,
  PhoneOtpRequestDto,
  PhoneOtpSentDto,
  PhoneOtpVerifyDto,
  SubmissionDayDto,
  SubmissionIdParamDto,
  SubmissionInputDto,
  SubmissionResultDto,
  TaskListDto,
  UpdateAgentDto,
  UpdateTaskDto,
  type AgentList,
  type AgentMe,
  type AgentStats,
  type AgentToday,
  type CommissionReport,
  type SubmissionDay,
  type SubmissionResult,
} from './dto/agents.dto';

/** /api/v1/agent: the field agent's own (ADR 066) — the phone's agent mode. */
@Controller({ path: 'agent', version: '1' })
@UseGuards(JwtAuthGuard)
export class AgentController {
  constructor(
    private readonly work: AgentWorkService,
    private readonly submissions: AgentSubmissionsService,
  ) {}

  /** Who I am as an agent, and the settings the phone needs offline. */
  @Get('me')
  @ApiOkResponse({ type: AgentMeDto })
  me(): Promise<AgentMe> {
    return this.work.me();
  }

  /** Today's route: open tasks due by today and those done today. */
  @Get('today')
  @ApiOkResponse({ type: AgentTodayDto })
  today(): Promise<AgentToday> {
    return this.work.today();
  }

  @Get('me/stats')
  @ApiOkResponse({ type: AgentStatsDto })
  stats(): Promise<AgentStats> {
    return this.work.stats();
  }

  /**
   * A queued capture. Idempotent by its `id` (the phone's UUID): the same
   * submission sent again returns the first answer and makes nothing new.
   */
  @Post('submissions')
  @HttpCode(HttpStatus.OK)
  @ActiveAccountRequired()
  @ApiOkResponse({ type: SubmissionResultDto })
  submit(@Body() body: SubmissionInputDto): Promise<SubmissionResult> {
    return this.submissions.submit(body);
  }

  /** Sends the shop's phone a code (the owner reads it out to the agent). */
  @Post('submissions/:id/phone-otp')
  @HttpCode(HttpStatus.OK)
  @ActiveAccountRequired()
  @ApiOkResponse({ type: PhoneOtpSentDto })
  requestPhoneOtp(
    @Param() params: SubmissionIdParamDto,
    @Body() body: PhoneOtpRequestDto,
    @Req() request: FastifyRequest,
  ): Promise<{ resendAfterSeconds: number }> {
    return this.work.requestPhoneOtp(params.id, body.phone, request.ip);
  }

  @Post('submissions/:id/phone-otp/verify')
  @HttpCode(HttpStatus.OK)
  @ActiveAccountRequired()
  @ApiOkResponse({ type: PhoneCheckDto })
  verifyPhoneOtp(
    @Param() params: SubmissionIdParamDto,
    @Body() body: PhoneOtpVerifyDto,
  ): Promise<{ status: 'verified' | 'failed' }> {
    return this.work.verifyPhoneOtp(params.id, body.phone, body.code);
  }
}

/** /api/v1/agents: the area team's agent management (ADR 066). */
@Controller({ path: 'agents', version: '1' })
@UseGuards(JwtAuthGuard)
export class AgentsAdminController {
  constructor(private readonly admin: AgentsAdminService) {}

  @Get()
  @ApiOkResponse({ type: AgentListDto })
  list(): Promise<AgentList> {
    return this.admin.list();
  }

  @Post()
  @ApiCreatedResponse({ type: AgentCreatedDto })
  create(@Body() body: CreateAgentDto): Promise<{ id: string }> {
    return this.admin.create(body);
  }

  /** A day's submissions in the area (the map and the review list). */
  @Get('submissions')
  @ApiOkResponse({ type: SubmissionDayDto })
  day(@Query() query: DayQueryDto): Promise<SubmissionDay> {
    return this.admin.day(query);
  }

  /** Estimated commission per agent for a period (calculation only). */
  @Get('commissions')
  @ApiOkResponse({ type: CommissionReportDto })
  commissions(@Query() query: PeriodQueryDto): Promise<CommissionReport> {
    return this.admin.commissions(query);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  update(@Param() params: AgentIdParamDto, @Body() body: UpdateAgentDto): Promise<void> {
    return this.admin.update(params.id, body);
  }

  @Get(':id/tasks')
  @ApiOkResponse({ type: TaskListDto })
  tasks(@Param() params: AgentIdParamDto) {
    return this.admin.tasks(params.id);
  }

  @Post(':id/tasks')
  @ApiCreatedResponse({ type: AgentCreatedDto })
  createTask(
    @Param() params: AgentIdParamDto,
    @Body() body: CreateTaskDto,
  ): Promise<{ id: string }> {
    return this.admin.createTask(params.id, body);
  }

  @Patch('tasks/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  setTask(@Param() params: AgentIdParamDto, @Body() body: UpdateTaskDto): Promise<void> {
    return this.admin.setTaskStatus(params.id, body.status);
  }
}
