import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  MediaIdParamDto,
  MediaStatusDto,
  PresignMediaDto,
  PresignedMediaDto,
  type MediaStatus,
  type PresignedMedia,
} from './dto/media.dto';
import { MediaService } from './media.service';

/**
 * Uploads never pass through the API: presign, PUT straight to storage,
 * confirm, then poll GET until `ready`.
 */
@Controller({ path: 'media', version: '1' })
@UseGuards(JwtAuthGuard)
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('presign')
  @ApiCreatedResponse({ type: PresignedMediaDto })
  presign(@Body() body: PresignMediaDto): Promise<PresignedMedia> {
    return this.media.presign(body);
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ type: MediaStatusDto })
  confirm(@Param() params: MediaIdParamDto): Promise<MediaStatus> {
    return this.media.confirm(params.id);
  }

  @Get(':id')
  @ApiOkResponse({ type: MediaStatusDto })
  get(@Param() params: MediaIdParamDto): Promise<MediaStatus> {
    return this.media.get(params.id);
  }
}
