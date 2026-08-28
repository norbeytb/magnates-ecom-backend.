// landings.controller.ts
//
// Endpoints para guardar y consultar las landings ensambladas (el taller las
// llama desde "Ensamblar landing" y desde "Mis Landings") — así la pestaña
// "Mis Landings" puede mostrar todas las landings de todos los productos aunque
// se recargue la página, en vez de perderlas al cerrar el navegador.

import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { LandingsService } from './landings.service';

@Controller('landings')
export class LandingsController {
  constructor(private readonly landingsService: LandingsService) {}

  @Get()
  async listar(@Query('producto') producto?: string) {
    return this.landingsService.listar(producto);
  }

  @Post()
  async guardar(@Body() body: { nombreProducto: string; num: number; items: any[]; botonFlotante?: boolean }) {
    return this.landingsService.guardar(body);
  }

  @Patch(':id')
  async actualizar(
    @Param('id') id: string,
    @Body() body: { items?: any[]; botonFlotante?: boolean; shopifyUrl?: string },
  ) {
    return this.landingsService.actualizar(Number(id), body);
  }

  @Delete(':id')
  async eliminar(@Param('id') id: string) {
    await this.landingsService.eliminar(Number(id));
    return { ok: true };
  }

  // Borra todas las landings ensambladas de un producto (por nombre) — parte de
  // "eliminar producto" en el taller. Va antes que nada más porque es una ruta
  // de 2 segmentos (/landings/producto/:nombre), distinta de /landings/:id.
  @Delete('producto/:nombre')
  async eliminarProducto(@Param('nombre') nombre: string) {
    await this.landingsService.eliminarPorProducto(decodeURIComponent(nombre));
    return { ok: true };
  }
}
