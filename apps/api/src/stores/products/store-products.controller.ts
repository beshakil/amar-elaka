import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { StoreIdParamDto } from '../dto/stores.dto';
import { StoreProductsDto, StoreProductsQueryDto, type StoreProducts } from './store-products.dto';
import { StoreProductsService } from './store-products.service';

/**
 * /api/v1/stores/:id/products — the seller panel's product table (ADR 057).
 * Price, stock, sold, hide, repost and delete go through /posts/:id…, which
 * let the store's owner and managers act on any of its posts.
 */
@Controller({ path: 'stores', version: '1' })
export class StoreProductsController {
  constructor(private readonly products: StoreProductsService) {}

  @Get(':id/products')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: StoreProductsDto })
  list(
    @Param() params: StoreIdParamDto,
    @Query() query: StoreProductsQueryDto,
  ): Promise<StoreProducts> {
    return this.products.list(params.id, query);
  }
}
