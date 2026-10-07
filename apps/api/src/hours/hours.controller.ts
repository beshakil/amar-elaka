import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import {
  ClosedTodayDto,
  ClosedTodayResultDto,
  EntityIdParamDto,
  HoursViewDto,
  SpecialDaysDto,
  StoreWeeklyDto,
  type ClosedTodayResult,
  type HoursView,
  type SpecialDayView,
} from './dto/hours.dto';
import { HoursService } from './hours.service';

/**
 * Business hours (ADR 049). A place's weekly schedule is PATCH /places/:id
 * (`businessHours`, versioned); here: a store's weekly schedule, special days
 * (holidays, exceptions) and the owner's "closed today". Place routes need
 * `places:write` (and the place's RLS: staff, agents, its owner); store
 * routes only sign-in — the store's RLS (its managers, staff) decides.
 */
@Controller({ version: '1' })
export class HoursController {
  constructor(private readonly hours: HoursService) {}

  @Get('stores/:id/hours')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOkResponse({ type: HoursViewDto })
  storeHours(@Param() params: EntityIdParamDto): Promise<HoursView> {
    return this.hours.storeHours(params.id);
  }

  @Put('stores/:id/hours')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: HoursViewDto })
  setStoreWeekly(
    @Param() params: EntityIdParamDto,
    @Body() body: StoreWeeklyDto,
  ): Promise<HoursView> {
    return this.hours.setStoreWeekly(params.id, body);
  }

  @Put('stores/:id/special-days')
  @UseGuards(JwtAuthGuard)
  setStoreSpecialDays(
    @Param() params: EntityIdParamDto,
    @Body() body: SpecialDaysDto,
  ): Promise<SpecialDayView[]> {
    return this.hours.setSpecialDays('store', params.id, body);
  }

  @Put('places/:id/special-days')
  @RequirePermission('places', 'write')
  setPlaceSpecialDays(
    @Param() params: EntityIdParamDto,
    @Body() body: SpecialDaysDto,
  ): Promise<SpecialDayView[]> {
    return this.hours.setSpecialDays('place', params.id, body);
  }

  /** `{closed: true}`: closed until the next midnight in the area's time zone. */
  @Post('stores/:id/closed-today')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: ClosedTodayResultDto })
  storeClosedToday(
    @Param() params: EntityIdParamDto,
    @Body() body: ClosedTodayDto,
  ): Promise<ClosedTodayResult> {
    return this.hours.setClosedToday('store', params.id, body.closed);
  }

  /** The claimed owner (or staff) only. */
  @Post('places/:id/closed-today')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('places', 'write')
  @ApiOkResponse({ type: ClosedTodayResultDto })
  placeClosedToday(
    @Param() params: EntityIdParamDto,
    @Body() body: ClosedTodayDto,
  ): Promise<ClosedTodayResult> {
    return this.hours.setClosedToday('place', params.id, body.closed);
  }
}
