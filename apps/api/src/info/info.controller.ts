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
import { BazarBoardService } from './bazar-board.service';
import { BazarService } from './bazar.service';
import { BloodService } from './blood.service';
import {
  AvailabilityDto,
  BazarBoardDto,
  BazarBoardQueryDto,
  BazarCatalogueDto,
  BazarCatalogueInputDto,
  BazarEntryInputDto,
  BazarEntryQueryDto,
  BazarEntryResultDto,
  BazarEntrySheetDto,
  BazarSponsorAdminDto,
  BazarSponsorInputDto,
  BloodRequestDetailDto,
  BloodRequestListDto,
  BloodRequestListQueryDto,
  CloseBloodRequestDto,
  CreateBloodRequestDto,
  CreatedBloodRequestDto,
  DonationDto,
  DonorContactInputDto,
  DonorContactResultDto,
  DonorContactsDto,
  DonorPageDto,
  DonorSearchQueryDto,
  EmergencyAdminListDto,
  EmergencyContactInputDto,
  EmergencyPageDto,
  InfoIdParamDto,
  MyDonorDto,
  OriginQueryDto,
  RegisterDonorDto,
  RemoveBloodRequestDto,
  RequestContactInputDto,
  type BazarBoard,
  type BazarCatalogue,
  type BazarEntrySheet,
  type BazarSponsorAdmin,
  type BloodRequestDetail,
  type BloodRequestList,
  type CreatedBloodRequest,
  type DonorContactResult,
  type DonorContacts,
  type DonorPage,
  type EmergencyAdminList,
  type EmergencyPage,
  type MyDonor,
} from './dto/info.dto';
import { EmergencyService } from './emergency.service';

function signalsOf(request: FastifyRequest, context: TenantContext): ViewerSignals {
  const installId = request.headers['x-install-id'];
  return {
    userId: context.current()?.userId,
    installId: typeof installId === 'string' ? installId : undefined,
    ip: request.ip,
    userAgent: request.headers['user-agent'],
  };
}

/**
 * /api/v1/info/emergency (ADR 064): the emergency page — national hotlines
 * and local contacts near the viewer, grouped by type. Public: the one screen
 * that must work for anyone, signed in or not.
 */
@Controller({ path: 'info/emergency', version: '1' })
export class EmergencyController {
  constructor(private readonly emergency: EmergencyService) {}

  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: EmergencyPageDto })
  page(@Query() query: OriginQueryDto): Promise<EmergencyPage> {
    return this.emergency.page(query);
  }

  /** The area's own contacts, inactive ones too: staff and field agents. */
  @Get('contacts')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: EmergencyAdminListDto })
  list(): Promise<EmergencyAdminList> {
    return this.emergency.adminList();
  }

  @Post('contacts')
  @UseGuards(JwtAuthGuard)
  @ApiCreatedResponse()
  create(@Body() body: EmergencyContactInputDto): Promise<{ id: string }> {
    return this.emergency.create(body);
  }

  @Put('contacts/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiNoContentResponse()
  update(@Param() params: InfoIdParamDto, @Body() body: EmergencyContactInputDto): Promise<void> {
    return this.emergency.update(params.id, body);
  }

  /** A field check: the numbers still work (last_verified_at). */
  @Post('contacts/:id/verify')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiNoContentResponse()
  verify(@Param() params: InfoIdParamDto): Promise<void> {
    return this.emergency.verify(params.id);
  }

  @Delete('contacts/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiNoContentResponse()
  remove(@Param() params: InfoIdParamDto): Promise<void> {
    return this.emergency.remove(params.id);
  }
}

/**
 * /api/v1/blood (ADR 064): the donor registry and urgent requests. Signed-in
 * users only (health-adjacent data, schema.md §10.4). A number leaves only
 * through the two contact routes, each a lead.
 */
@Controller({ path: 'blood', version: '1' })
@UseGuards(JwtAuthGuard)
export class BloodController {
  constructor(
    private readonly blood: BloodService,
    private readonly context: TenantContext,
  ) {}

  /** Available, eligible donors of a group near the viewer (any area), nearest first. */
  @Get('donors')
  @ApiOkResponse({ type: DonorPageDto })
  donors(@Query() query: DonorSearchQueryDto): Promise<DonorPage> {
    return this.blood.searchDonors(query);
  }

  /** Call a donor who shares their number, or ask one who doesn't. */
  @Post('donors/:id/contact')
  @HttpCode(HttpStatus.OK)
  @ActiveAccountRequired()
  @ApiOkResponse({ type: DonorContactResultDto })
  contactDonor(
    @Param() params: InfoIdParamDto,
    @Body() body: DonorContactInputDto,
    @Req() request: FastifyRequest,
  ): Promise<DonorContactResult> {
    return this.blood.contactDonor(
      params.id,
      body,
      signalsOf(request, this.context),
      localeOf(request),
    );
  }

  @Get('me')
  @ApiOkResponse({ type: MyDonorDto })
  me(): Promise<MyDonor> {
    return this.blood.me();
  }

  /** Opt in as a donor (or update): consent and eligibility are required. */
  @Put('me')
  @ActiveAccountRequired()
  @ApiOkResponse({ type: MyDonorDto })
  register(@Body() body: RegisterDonorDto, @Req() request: FastifyRequest): Promise<MyDonor> {
    const ua = request.headers['user-agent'];
    return this.blood.register(body, {
      ip: request.ip ?? null,
      userAgent: typeof ua === 'string' ? ua : null,
    });
  }

  /** Pause or resume instantly. */
  @Patch('me/availability')
  @ApiOkResponse({ type: MyDonorDto })
  availability(@Body() body: AvailabilityDto): Promise<MyDonor> {
    return this.blood.setAvailability(body.available);
  }

  /** A donation: off the list for blood_donation_interval_days. */
  @Post('me/donations')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: MyDonorDto })
  donation(@Body() body: DonationDto): Promise<MyDonor> {
    return this.blood.recordDonation(body.donatedOn);
  }

  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  withdraw(): Promise<void> {
    return this.blood.withdraw();
  }

  /** Who contacted me, newest first. */
  @Get('me/contacts')
  @ApiOkResponse({ type: DonorContactsDto })
  contacts(): Promise<DonorContacts> {
    return this.blood.myContacts();
  }

  /** An urgent request: matching donors near the hospital get a push. */
  @Post('requests')
  @ActiveAccountRequired()
  @ApiCreatedResponse({ type: CreatedBloodRequestDto })
  createRequest(@Body() body: CreateBloodRequestDto): Promise<CreatedBloodRequest> {
    return this.blood.createRequest(body);
  }

  /** Open requests near the viewer (any area), most urgent first. */
  @Get('requests')
  @ApiOkResponse({ type: BloodRequestListDto })
  requests(@Query() query: BloodRequestListQueryDto): Promise<BloodRequestList> {
    return this.blood.listRequests(query);
  }

  @Get('requests/mine')
  @ApiOkResponse({ type: BloodRequestListDto })
  mine(): Promise<BloodRequestList> {
    return this.blood.myRequests();
  }

  /** Staff: the area's requests, any status. */
  @Get('requests/area')
  @ApiOkResponse({ type: BloodRequestListDto })
  area(): Promise<BloodRequestList> {
    return this.blood.areaRequests();
  }

  @Get('requests/:id')
  @ApiOkResponse({ type: BloodRequestDetailDto })
  request(@Param() params: InfoIdParamDto): Promise<BloodRequestDetail> {
    return this.blood.requestDetail(params.id);
  }

  /** The requester's number, for a donor who can help. */
  @Post('requests/:id/contact')
  @HttpCode(HttpStatus.OK)
  @ActiveAccountRequired()
  @ApiOkResponse({ type: ContactRevealDto })
  contactRequester(
    @Param() params: InfoIdParamDto,
    @Body() body: RequestContactInputDto,
    @Req() request: FastifyRequest,
  ): Promise<ContactReveal> {
    return this.blood.contactRequester(
      params.id,
      body.channel,
      signalsOf(request, this.context),
      localeOf(request),
    );
  }

  @Post('requests/:id/close')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  close(@Param() params: InfoIdParamDto, @Body() body: CloseBloodRequestDto): Promise<void> {
    return this.blood.closeRequest(params.id, body.outcome);
  }

  /** A moderator's takedown (with moderation_actions). */
  @Post('requests/:id/remove')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(@Param() params: InfoIdParamDto, @Body() body: RemoveBloodRequestDto): Promise<void> {
    return this.blood.removeRequest(params.id, body.reasonCode, body.reasonText);
  }
}

/** /api/v1/bazar (ADR 064): the public price board and the area team's entry. */
@Controller({ path: 'bazar', version: '1' })
export class BazarController {
  constructor(
    private readonly board: BazarBoardService,
    private readonly bazar: BazarService,
  ) {}

  /** Today vs yesterday vs the trend, the stale flag and the sponsor. */
  @Get('board')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: BazarBoardDto })
  getBoard(@Query() query: BazarBoardQueryDto): Promise<BazarBoard> {
    return this.board.board(query.board);
  }

  /** The fast entry sheet: staff and field agents. */
  @Get('entry')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: BazarEntrySheetDto })
  sheet(@Query() query: BazarEntryQueryDto): Promise<BazarEntrySheet> {
    return this.bazar.entrySheet(query.date, query.board);
  }

  @Put('entry')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: BazarEntryResultDto })
  enter(@Body() body: BazarEntryInputDto): Promise<{ saved: number }> {
    return this.bazar.enter(body);
  }

  @Get('catalogue')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: BazarCatalogueDto })
  catalogue(): Promise<BazarCatalogue> {
    return this.bazar.catalogue();
  }

  @Put('catalogue')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiNoContentResponse()
  setCatalogue(@Body() body: BazarCatalogueInputDto): Promise<void> {
    return this.bazar.setCatalogue(body);
  }

  @Get('sponsor')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: BazarSponsorAdminDto })
  sponsor(): Promise<BazarSponsorAdmin> {
    return this.bazar.sponsor();
  }

  @Put('sponsor')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiNoContentResponse()
  setSponsor(@Body() body: BazarSponsorInputDto): Promise<void> {
    return this.bazar.setSponsor(body);
  }

  @Delete('sponsor')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiNoContentResponse()
  clearSponsor(): Promise<void> {
    return this.bazar.setSponsor(null);
  }
}
