import { Controller, Get, Param, Res, StreamableFile } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { ListingIdParamDto } from '../dto/seo.dto';
import { OgImageService } from './og-image.service';

/** GET /api/v1/posts/:id/og.png — a public listing's share image (ADR 039). */
@Controller({ path: 'posts', version: '1' })
export class OgImageController {
  constructor(private readonly images: OgImageService) {}

  @Get(':id/og.png')
  @ApiOkResponse({ description: 'A 1200×630 PNG.' })
  async image(
    @Param() params: ListingIdParamDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile> {
    const png = await this.images.png(params.id);
    // Set only on success: an error must still go out as JSON.
    void reply
      .header('Content-Type', 'image/png')
      // A day in shared caches; the web asks with ?v=<updatedAt>, so a changed post is a new URL.
      .header('Cache-Control', 'public, max-age=86400');
    return new StreamableFile(png);
  }
}
