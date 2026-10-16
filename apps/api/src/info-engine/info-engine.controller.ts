import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { ActiveAccountRequired } from '../auth/ban-access.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { TenantContext } from '../database/tenant-context';
import { ContactRevealDto, type ContactReveal } from '../engagement/dto/engagement.dto';
import { localeOf } from '../engagement/engagement.controller';
import type { ViewerSignals } from '../engagement/viewer-key';
import { DirectoryService } from './directory.service';
import {
  CreatedDto,
  InfoDecisionDto,
  DirectoryQueryDto,
  GovListQueryDto,
  GovServiceDetailDto,
  GovServiceInputDto,
  GovVersionDto,
  GovVersionParamDto,
  InfoEngineIdParamDto,
  InfoListDto,
  InfoReportDto,
  InfoServicesDto,
  LostFoundContactDto,
  LostFoundDetailDto,
  LostFoundInputDto,
  LostFoundListQueryDto,
  ModerationParamDto,
  ModerationQueueDto,
  NoticeDetailDto,
  NoticeInputDto,
  NoticeListQueryDto,
  OriginOnlyDto,
  OutageAdminListDto,
  OutageInputDto,
  OutageReportInputDto,
  OutageReportResultDto,
  PrayerSettingsDto,
  PublishedDto,
  RouteAdminListDto,
  RouteDetailDto,
  RouteInputDto,
  RouteListQueryDto,
  SlugParamDto,
  type Created,
  type GovServiceDetail,
  type GovVersion,
  type InfoList,
  type InfoServices,
  type LostFoundDetail,
  type ModerationQueue,
  type NoticeDetail,
  type OutageAdminList,
  type OutageReportResult,
  type PrayerSettings,
  type Published,
  type RouteAdminList,
  type RouteDetail,
} from './dto/info-engine.dto';
import { GovServicesService } from './gov-services.service';
import { InfoModerationService } from './info-moderation.service';
import { LostFoundService } from './lost-found.service';
import { NoticesService } from './notices.service';
import { OutagesService } from './outages.service';
import { PrayerService } from './prayer.service';
import { TransportService } from './transport.service';

/** /api/v1/info — which services the area offers, and how it calculates prayer times (ADR 065). */
@Controller({ path: 'info', version: '1' })
export class InfoServicesController {
  constructor(private readonly prayer: PrayerService) {}

  @Get('services')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: InfoServicesDto })
  services(): Promise<InfoServices> {
    return this.prayer.services();
  }

  /** The settings the apps calculate prayer times with — on the device, never here. */
  @Get('prayer/settings')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: PrayerSettingsDto })
  prayerSettings(): Promise<PrayerSettings> {
    return this.prayer.settings();
  }
}

/** /api/v1/info/outages: scheduled and reported outages near the viewer. */
@Controller({ path: 'info/outages', version: '1' })
export class OutagesController {
  constructor(private readonly outages: OutagesService) {}

  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: InfoListDto })
  list(@Query() query: OriginOnlyDto): Promise<InfoList> {
    return this.outages.list(query);
  }

  /** "No power here now": counts once enough neighbours agree. */
  @Post('reports')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ActiveAccountRequired()
  @ApiOkResponse({ type: OutageReportResultDto })
  report(@Body() body: OutageReportInputDto): Promise<OutageReportResult> {
    return this.outages.report(body);
  }

  @Get('manage')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: OutageAdminListDto })
  manage(): Promise<OutageAdminList> {
    return this.outages.teamList();
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiCreatedResponse({ type: CreatedDto })
  create(@Body() body: OutageInputDto): Promise<Created> {
    return this.outages.create(body);
  }

  @Put(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiNoContentResponse()
  update(@Param() params: InfoEngineIdParamDto, @Body() body: OutageInputDto): Promise<void> {
    return this.outages.update(params.id, body);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiNoContentResponse()
  cancel(@Param() params: InfoEngineIdParamDto): Promise<void> {
    return this.outages.cancel(params.id);
  }
}

/** /api/v1/info/notices: local, community (janaza included) and advisory notices. */
@Controller({ path: 'info/notices', version: '1' })
export class NoticesController {
  constructor(private readonly notices: NoticesService) {}

  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: InfoListDto })
  list(@Query() query: NoticeListQueryDto): Promise<InfoList> {
    return this.notices.list(query);
  }

  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: NoticeDetailDto })
  detail(@Param() params: InfoEngineIdParamDto): Promise<NoticeDetail> {
    return this.notices.detail(params.id);
  }

  /** A member's community notice waits for a moderator; the area team's is published. */
  @Post()
  @UseGuards(JwtAuthGuard)
  @ActiveAccountRequired()
  @ApiCreatedResponse({ type: CreatedDto })
  create(@Body() body: NoticeInputDto): Promise<Created> {
    return this.notices.create(body);
  }

  @Post(':id/report')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiNoContentResponse()
  report(@Param() params: InfoEngineIdParamDto, @Body() body: InfoReportDto): Promise<void> {
    return this.notices.report(params.id, body);
  }
}

/** /api/v1/info/lost-found: people, pets and items; moderated; contact tracked. */
@Controller({ path: 'info/lost-found', version: '1' })
export class LostFoundController {
  constructor(
    private readonly items: LostFoundService,
    private readonly context: TenantContext,
  ) {}

  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: InfoListDto })
  list(@Query() query: LostFoundListQueryDto): Promise<InfoList> {
    return this.items.list(query);
  }

  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: LostFoundDetailDto })
  detail(@Param() params: InfoEngineIdParamDto): Promise<LostFoundDetail> {
    return this.items.detail(params.id);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  @ActiveAccountRequired()
  @ApiCreatedResponse({ type: CreatedDto })
  create(@Body() body: LostFoundInputDto): Promise<Created> {
    return this.items.create(body);
  }

  @Post(':id/resolve')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiNoContentResponse()
  resolve(@Param() params: InfoEngineIdParamDto): Promise<void> {
    return this.items.resolve(params.id);
  }

  /** The reporter's number, as a lead. */
  @Post(':id/contact')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ActiveAccountRequired()
  @ApiOkResponse({ type: ContactRevealDto })
  contact(
    @Param() params: InfoEngineIdParamDto,
    @Body() body: LostFoundContactDto,
    @Req() request: FastifyRequest,
  ): Promise<ContactReveal> {
    const installId = request.headers['x-install-id'];
    const signals: ViewerSignals = {
      userId: this.context.current()?.userId,
      installId: typeof installId === 'string' ? installId : undefined,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    };
    return this.items.contact(params.id, body.channel, signals, localeOf(request));
  }

  @Post(':id/report')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiNoContentResponse()
  report(@Param() params: InfoEngineIdParamDto, @Body() body: InfoReportDto): Promise<void> {
    return this.items.report(params.id, body);
  }
}

/** /api/v1/info/moderation: the engine's one queue and decision (staff). */
@Controller({ path: 'info/moderation', version: '1' })
@UseGuards(JwtAuthGuard)
export class InfoModerationController {
  constructor(private readonly moderation: InfoModerationService) {}

  @Get('queue')
  @ApiOkResponse({ type: ModerationQueueDto })
  queue(): Promise<ModerationQueue> {
    return this.moderation.queue();
  }

  @Post(':kind/:id/decision')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse()
  decide(
    @Param() params: ModerationParamDto,
    @Body() body: InfoDecisionDto,
  ): Promise<{ status: string }> {
    return this.moderation.decide(params.kind, params.id, body);
  }
}

/** /api/v1/info/transport: routes, stops, timetables, next departures. */
@Controller({ path: 'info/transport', version: '1' })
export class TransportController {
  constructor(private readonly transport: TransportService) {}

  @Get('routes')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: InfoListDto })
  list(@Query() query: RouteListQueryDto): Promise<InfoList> {
    return this.transport.list(query);
  }

  @Get('manage')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: RouteAdminListDto })
  manage(): Promise<RouteAdminList> {
    return this.transport.teamList();
  }

  @Get('routes/:id')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: RouteDetailDto })
  detail(@Param() params: InfoEngineIdParamDto): Promise<RouteDetail> {
    return this.transport.detail(params.id);
  }

  @Post('routes')
  @UseGuards(JwtAuthGuard)
  @ApiCreatedResponse({ type: CreatedDto })
  create(@Body() body: RouteInputDto): Promise<Created> {
    return this.transport.save(null, body);
  }

  @Put('routes/:id')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: CreatedDto })
  update(@Param() params: InfoEngineIdParamDto, @Body() body: RouteInputDto): Promise<Created> {
    return this.transport.save(params.id, body);
  }

  @Post('routes/:id/verify')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiNoContentResponse()
  verify(@Param() params: InfoEngineIdParamDto): Promise<void> {
    return this.transport.verify(params.id);
  }

  @Delete('routes/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiNoContentResponse()
  remove(@Param() params: InfoEngineIdParamDto): Promise<void> {
    return this.transport.remove(params.id);
  }
}

/** /api/v1/info/gov-services: the government service guide, versioned. */
@Controller({ path: 'info/gov-services', version: '1' })
export class GovServicesController {
  constructor(private readonly gov: GovServicesService) {}

  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: InfoListDto })
  list(@Query() query: GovListQueryDto): Promise<InfoList> {
    return this.gov.list(query.category ?? null);
  }

  @Get('manage')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: InfoListDto })
  manage(): Promise<InfoList> {
    return this.gov.teamList();
  }

  @Get(':slug')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: GovServiceDetailDto })
  detail(@Param() params: SlugParamDto): Promise<GovServiceDetail> {
    return this.gov.detail(params.slug);
  }

  @Get(':slug/versions/:no')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: GovVersionDto })
  version(@Param() params: GovVersionParamDto): Promise<GovVersion> {
    return this.gov.version(params.slug, params.no);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiCreatedResponse({ type: PublishedDto })
  create(@Body() body: GovServiceInputDto): Promise<Published> {
    return this.gov.publish(null, body);
  }

  /** A new version (the old ones stay). */
  @Put(':id')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: PublishedDto })
  update(
    @Param() params: InfoEngineIdParamDto,
    @Body() body: GovServiceInputDto,
  ): Promise<Published> {
    return this.gov.publish(params.id, body);
  }

  @Post(':id/verify')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiNoContentResponse()
  verify(@Param() params: InfoEngineIdParamDto): Promise<void> {
    return this.gov.verify(params.id);
  }

  @Post(':id/hide')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiNoContentResponse()
  hide(@Param() params: InfoEngineIdParamDto): Promise<void> {
    return this.gov.setActive(params.id, false);
  }

  @Post(':id/show')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiNoContentResponse()
  show(@Param() params: InfoEngineIdParamDto): Promise<void> {
    return this.gov.setActive(params.id, true);
  }
}

/** /api/v1/info/directory: hospitals, pharmacies, schools… (places) near the viewer. */
@Controller({ path: 'info/directory', version: '1' })
export class DirectoryController {
  constructor(private readonly directory: DirectoryService) {}

  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: InfoListDto })
  list(@Query() query: DirectoryQueryDto): Promise<InfoList> {
    return this.directory.list(query);
  }
}
