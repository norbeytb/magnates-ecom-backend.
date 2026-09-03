// landings.controller.ts
//
// Endpoints para guardar y consultar las landings ensambladas (el taller las
// llama desde "Ensamblar landing" y desde "Mis Landings") — así la pestaña
// "Mis Landings" puede mostrar todas las landings de todos los productos aunque
// se recargue la página, en vez de perderlas al cerrar el navegador.

import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { LandingsService } from './landings.service';
import { JwtAuthGuard, UsuarioActual, UsuarioAutenticado } from './auth.guard';

@Controller('landings')
@UseGuards(JwtAuthGuard)
export class LandingsController {
  constructor(private readonly landingsService: LandingsService) {}

  @Get()
  async listar(@Query('producto') producto: string | undefined, @UsuarioActual() usuario: UsuarioAutenticado) {
    return this.landingsService.listar(usuario.id, producto);
  }

  @Post()
  async guardar(
    @Body()
    body: {
      nombreProducto: string;
      num: number;
      items: any[];
      botonFlotante?: boolean;
      movimiento?: boolean;
      barra?: boolean;
      barraTexto?: string;
      barraColor?: string;
      barraColorTexto?: string;
    },
    @UsuarioActual() usuario: UsuarioAutenticado,
  ) {
    return this.landingsService.guardar(usuario.id, body);
  }

  @Patch(':id')
  async actualizar(
    @Param('id') id: string,
    @Body()
    body: {
      items?: any[];
      botonFlotante?: boolean;
      movimiento?: boolean;
      barra?: boolean;
      barraTexto?: string;
      barraColor?: string;
      barraColorTexto?: string;
      shopifyUrl?: string;
    },
    @UsuarioActual() usuario: UsuarioAutenticado,
  ) {
    return this.landingsService.actualizar(usuario.id, Number(id), body);
  }

  @Delete(':id')
  async eliminar(@Param('id') id: string, @UsuarioActual() usuario: UsuarioAutenticado) {
    await this.landingsService.eliminar(usuario.id, Number(id));
    return { ok: true };
  }

  // Borra todas las landings ensambladas de un producto (por nombre) — parte de
  // "eliminar producto" en el taller. Va antes que nada más porque es una ruta
  // de 2 segmentos (/landings/producto/:nombre), distinta de /landings/:id.
  @Delete('producto/:nombre')
  async eliminarProducto(@Param('nombre') nombre: string, @UsuarioActual() usuario: UsuarioAutenticado) {
    await this.landingsService.eliminarPorProducto(usuario.id, decodeURIComponent(nombre));
    return { ok: true };
  }
}
