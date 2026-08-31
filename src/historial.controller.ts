// historial.controller.ts
//
// Endpoint para consultar lo que se ha generado — el taller lo puede usar más
// adelante para mostrar un historial real en vez de perder todo al cerrar el navegador.

import { Controller, Delete, Get, Param, Query, UseGuards } from '@nestjs/common';
import { HistorialService } from './historial.service';
import { JwtAuthGuard, UsuarioActual, UsuarioAutenticado } from './auth.guard';

@Controller('historial')
@UseGuards(JwtAuthGuard)
export class HistorialController {
  constructor(private readonly historialService: HistorialService) {}

  @Get()
  async listar(@Query('producto') producto: string | undefined, @UsuarioActual() usuario: UsuarioAutenticado) {
    return this.historialService.listar(usuario.id, producto);
  }

  // Borra todo el historial de un producto (por nombre) — parte de "eliminar
  // producto" en el taller. El nombre va codificado en la URL porque puede
  // traer espacios y acentos.
  @Delete('producto/:nombre')
  async eliminarProducto(@Param('nombre') nombre: string, @UsuarioActual() usuario: UsuarioAutenticado) {
    await this.historialService.eliminarPorProducto(usuario.id, decodeURIComponent(nombre));
    return { ok: true };
  }
}
