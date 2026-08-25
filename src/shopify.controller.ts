// shopify.controller.ts
//
// Expone POST /shopify/publicar para que el frontend pida publicar (o
// actualizar) una landing ensamblada como Página en Shopify. El frontend
// nunca ve el token de Shopify — solo este backend lo usa.

import { Body, Controller, HttpException, HttpStatus, Post } from '@nestjs/common';
import { PublicarLandingInput, ShopifyService } from './shopify.service';

@Controller('shopify')
export class ShopifyController {
  constructor(private readonly shopifyService: ShopifyService) {}

  @Post('publicar')
  async publicar(@Body() body: PublicarLandingInput) {
    try {
      return await this.shopifyService.publicarLanding(body);
    } catch (error) {
      throw new HttpException((error as Error).message, HttpStatus.BAD_GATEWAY);
    }
  }
}
