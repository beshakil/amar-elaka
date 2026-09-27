import { Controller, Get, Param } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { ShortCodeParamDto, ShortLinkDto, type ShortLink } from './dto/engagement.dto';
import { ShareService } from './share.service';

/** /api/v1/s/:code — which post a share link names (the web's /s/:code page and the app's deep link resolve through it). */
@Controller({ path: 's', version: '1' })
export class ShareController {
  constructor(private readonly share: ShareService) {}

  @Get(':code')
  @ApiOkResponse({ type: ShortLinkDto })
  resolve(@Param() params: ShortCodeParamDto): Promise<ShortLink> {
    return this.share.resolve(params.code);
  }
}
