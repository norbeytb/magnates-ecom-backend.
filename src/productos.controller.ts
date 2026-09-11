// productos.controller.ts
//
// Endpoints para guardar/leer/borrar las fotos de producto guardadas (ver
// productos.service.ts) — los llama el taller cada vez que se sube/quita una
// foto en Imagen 1/2/3, al cargar la página, y al eliminar un producto.

import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ProductosService } from './productos.service';
import { JwtAuthGuard, UsuarioActual, UsuarioAutenticado } from './auth.guard';

@Controller('productos')
@UseGuards(JwtAuthGuard)
export class ProductosController {
  constructor(private readonly productosService: ProductosService) {}

  @Get('fotos')
  async listarFotos(@UsuarioActual() usuario: UsuarioAutenticado) {
    return this.productosService.listarFotos(usuario.id);
  }

  @Post('foto')
  async guardarFotos(@Body() body: { nombreProducto: string; fotos: (string | null)[] }, @UsuarioActual() usuario: UsuarioAutenticado) {
    await this.productosService.guardarFotos(usuario.id, body.nombreProducto, body.fotos);
    return { ok: true };
  }

  // Pedido 11/09: sección "Testimonios" en modo Personalizada — ver la nota
  // grande en productos.service.ts sobre por qué esto vive a nivel producto.
  @Post('resenas')
  async guardarResenas(
    @Body() body: { nombreProducto: string; testimoniosModo: string; resenas: any[] },
    @UsuarioActual() usuario: UsuarioAutenticado,
  ) {
    await this.productosService.guardarResenas(usuario.id, body.nombreProducto, body.testimoniosModo, body.resenas);
    return { ok: true };
  }

  @Delete(':nombre')
  async eliminar(@Param('nombre') nombre: string, @UsuarioActual() usuario: UsuarioAutenticado) {
    await this.productosService.eliminar(usuario.id, decodeURIComponent(nombre));
    return { ok: true };
  }
}
