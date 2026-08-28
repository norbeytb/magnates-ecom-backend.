// productos.controller.ts
//
// Endpoints para guardar/leer/borrar las fotos de producto guardadas (ver
// productos.service.ts) — los llama el taller cada vez que se sube/quita una
// foto en Imagen 1/2/3, al cargar la página, y al eliminar un producto.

import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ProductosService } from './productos.service';

@Controller('productos')
export class ProductosController {
  constructor(private readonly productosService: ProductosService) {}

  @Get('fotos')
  async listarFotos() {
    return this.productosService.listarFotos();
  }

  @Post('foto')
  async guardarFotos(@Body() body: { nombreProducto: string; fotos: (string | null)[] }) {
    await this.productosService.guardarFotos(body.nombreProducto, body.fotos);
    return { ok: true };
  }

  @Delete(':nombre')
  async eliminar(@Param('nombre') nombre: string) {
    await this.productosService.eliminar(decodeURIComponent(nombre));
    return { ok: true };
  }
}
