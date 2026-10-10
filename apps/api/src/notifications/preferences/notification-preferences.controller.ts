import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import {
  ForgetPushTokenDto,
  PreferencesDto,
  PushTokenDto,
  UpdatePreferencesDto,
  type Preferences,
} from './notification-preferences.dto';
import { NotificationPreferencesService } from './notification-preferences.service';

/** The signed-in user's notification settings and this device's push token (ADR 059). */
@Controller({ path: 'me', version: '1' })
@UseGuards(JwtAuthGuard)
export class NotificationPreferencesController {
  constructor(private readonly preferences: NotificationPreferencesService) {}

  /** Every type the user gets, per channel: on or off, and whether they may change it. */
  @Get('notification-preferences')
  @ApiOkResponse({ type: PreferencesDto })
  get(): Promise<Preferences> {
    return this.preferences.get();
  }

  /** Switch channels per type; a locked one is refused (NOTIFICATION_PREFERENCE_LOCKED). */
  @Put('notification-preferences')
  @ApiOkResponse({ type: PreferencesDto })
  update(@Body() body: UpdatePreferencesDto): Promise<Preferences> {
    return this.preferences.update(body);
  }

  /** Register or refresh this device's FCM token (on start, and whenever FCM rotates it). */
  @Put('devices/push-token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async register(@Body() body: PushTokenDto): Promise<void> {
    await this.preferences.registerPushToken(body);
  }

  /** Forget a token (sign-out on this device): no more pushes to it. */
  @Delete('devices/push-token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async forget(@Body() body: ForgetPushTokenDto): Promise<void> {
    await this.preferences.forgetPushToken(body.token);
  }
}
