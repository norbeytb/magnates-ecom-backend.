// shopify.controller.ts
//
// Expone POST /shopify/publicar para que el frontend pida publicar (o
// actualizar) una landing ensamblada como Página en Shopify. El frontend
// nunca ve el token de Shopify — solo este backend lo usa.

import { Body, Controller, HttpException, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { PublicarLandingInput, ShopifyService } from './shopify.service';
import { JwtAuthGuard } from './auth.guard';

// Protegido con sesión igual que el resto — publicar en Shopify llama a la
// Admin API real de la tienda, no debe quedar abierto para cualquiera que
// encuentre la URL del backend. No queda "escopado" por usuario dentro de
// Shopify mismo (los productos publicados no tienen dueño ahí, es una tienda
// compartida) — eso es aparte de qué cuenta del taller puede pedir la
// publicación.
@Controller('shopify')
@UseGuards(JwtAuthGuard)
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
