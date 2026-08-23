// historial.controller.ts
//
// Endpoint para consultar lo que se ha generado — el taller lo puede usar más
// adelante para mostrar un historial real en vez de perder todo al cerrar el navegador.

import { Controller, Get, Query } from '@nestjs/common';
import { HistorialService } from './historial.service';

@Controller('historial')
export class HistorialController {
  constructor(private readonly historialService: HistorialService) {}

  @Get()
  async listar(@Query('producto') producto?: string) {
    return this.historialService.listar(producto);
  }
}
