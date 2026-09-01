// shopify.controller.ts
//
// Expone POST /shopify/publicar para que el frontend pida publicar (o
// actualizar) una landing ensamblada como producto en la tienda de Shopify
// DEL USUARIO QUE ESTÁ CONECTADO. El frontend nunca ve el token de Shopify —
// este backend busca las credenciales guardadas de ese usuario
// (IntegracionesService, ver integraciones.service.ts) y las usa por él.

import { Body, Controller, HttpException, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { PublicarLandingInput, ShopifyService } from './shopify.service';
import { JwtAuthGuard, UsuarioActual, UsuarioAutenticado } from './auth.guard';
import { IntegracionesService } from './integraciones.service';

// Protegido con sesión igual que el resto — publicar en Shopify llama a la
// Admin API real de la tienda del usuario, no debe quedar abierto para
// cualquiera que encuentre la URL del backend. Cada usuario solo puede
// publicar en SU PROPIA tienda: las credenciales siempre se buscan a partir
// de @UsuarioActual(), nunca de algo que venga en el body.
@Controller('shopify')
@UseGuards(JwtAuthGuard)
export class ShopifyController {
  constructor(
    private readonly shopifyService: ShopifyService,
    private readonly integracionesService: IntegracionesService,
  ) {}

  @Post('publicar')
  async publicar(@Body() body: PublicarLandingInput, @UsuarioActual() usuario: UsuarioAutenticado) {
    const credenciales = await this.integracionesService.obtenerCredencialesShopify(usuario.id);
    if (!credenciales) {
      throw new HttpException(
        'Todavía no conectaste tu tienda de Shopify. Andá a "Integraciones" y conectala primero.',
        HttpStatus.BAD_REQUEST,
      );
    }
    try {
      return await this.shopifyService.publicarLanding(credenciales, body);
    } catch (error) {
      throw new HttpException((error as Error).message, HttpStatus.BAD_GATEWAY);
    }
  }
}
