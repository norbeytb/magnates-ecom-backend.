// integraciones.controller.ts
//
// Endpoints del módulo de Integraciones — cada usuario conecta/desconecta
// SU PROPIA tienda de Shopify y SU PROPIA clave de fal.ai desde acá. Todo
// requiere sesión iniciada (@UseGuards(JwtAuthGuard) a nivel de clase) y
// siempre se opera sobre la cuenta de quien está conectado (@UsuarioActual()),
// nunca sobre un id que venga del body — así un usuario nunca puede tocar la
// integración de otro.

import { Body, Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';
import { IntegracionesService } from './integraciones.service';
import { JwtAuthGuard, UsuarioActual, UsuarioAutenticado } from './auth.guard';

interface GuardarShopifyDto {
  storeDomain: string;
  clientId: string;
  clientSecret: string;
}

interface GuardarFalDto {
  apiKey: string;
}

@Controller('integraciones')
@UseGuards(JwtAuthGuard)
export class IntegracionesController {
  constructor(private readonly integracionesService: IntegracionesService) {}

  // El taller lo llama al abrir la vista de "Integraciones" para mostrar el
  // estado actual (conectado/no conectado + últimos 4 caracteres).
  @Get()
  async obtener(@UsuarioActual() usuario: UsuarioAutenticado) {
    return this.integracionesService.obtener(usuario.id);
  }

  @Post('shopify')
  async guardarShopify(@Body() dto: GuardarShopifyDto, @UsuarioActual() usuario: UsuarioAutenticado) {
    return this.integracionesService.guardarShopify(usuario.id, dto?.storeDomain, dto?.clientId, dto?.clientSecret);
  }

  @Delete('shopify')
  async desconectarShopify(@UsuarioActual() usuario: UsuarioAutenticado) {
    return this.integracionesService.desconectarShopify(usuario.id);
  }

  @Post('fal')
  async guardarFal(@Body() dto: GuardarFalDto, @UsuarioActual() usuario: UsuarioAutenticado) {
    return this.integracionesService.guardarFal(usuario.id, dto?.apiKey);
  }

  @Delete('fal')
  async desconectarFal(@UsuarioActual() usuario: UsuarioAutenticado) {
    return this.integracionesService.desconectarFal(usuario.id);
  }
}
