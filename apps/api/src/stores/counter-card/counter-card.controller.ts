import { Controller, Get, Param, Query, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { createZodDto } from '../../common/pipes/zod-dto';
import { StoreIdParamDto } from '../dto/stores.dto';
import { COUNTER_CARD_SIZES, CounterCardService } from './counter-card.service';

const counterCardQuerySchema = z
  .object({ size: z.enum(COUNTER_CARD_SIZES).default('a5') })
  .strict();
export class CounterCardQueryDto extends createZodDto(counterCardQuerySchema) {}

/** /api/v1/stores/:id/counter-card.pdf — the printable QR card for the shop counter (ADR 057). */
@Controller({ path: 'stores', version: '1' })
export class CounterCardController {
  constructor(private readonly cards: CounterCardService) {}

  @Get(':id/counter-card.pdf')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ description: 'A print-ready PDF: A5, or a square sticker.' })
  async pdf(
    @Param() params: StoreIdParamDto,
    @Query() query: CounterCardQueryDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile> {
    const file = await this.cards.pdf(params.id, query.size);
    void reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${file.filename}"`)
      .header('Cache-Control', 'no-store');
    return new StreamableFile(file.body);
  }

  @Get(':id/counter-card.png')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ description: 'The same card as a PNG, for previewing.' })
  async png(
    @Param() params: StoreIdParamDto,
    @Query() query: CounterCardQueryDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile> {
    const png = await this.cards.png(params.id, query.size);
    void reply.header('Content-Type', 'image/png').header('Cache-Control', 'private, no-store');
    return new StreamableFile(png);
  }
}
