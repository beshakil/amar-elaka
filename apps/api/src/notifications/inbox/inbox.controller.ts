import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import {
  InboxPageDto,
  InboxQueryDto,
  NotificationIdParamDto,
  UnreadCountDto,
  type InboxPage,
  type UnreadCount,
} from './inbox.dto';
import { InboxService } from './inbox.service';

/**
 * The signed-in user's notifications, newest first, with the unread badge;
 * each carries its rendered title and body (ADR 059).
 */
@Controller({ path: 'notifications', version: '1' })
@UseGuards(JwtAuthGuard)
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get()
  @ApiOkResponse({ type: InboxPageDto })
  page(@Query() query: InboxQueryDto): Promise<InboxPage> {
    return this.inbox.page(query);
  }

  @Get('unread-count')
  @ApiOkResponse({ type: UnreadCountDto })
  unreadCount(): Promise<UnreadCount> {
    return this.inbox.unreadCount();
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: UnreadCountDto })
  markAllRead(): Promise<UnreadCount> {
    return this.inbox.markAllRead();
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async markRead(@Param() params: NotificationIdParamDto): Promise<void> {
    await this.inbox.markRead(params.id);
  }
}
