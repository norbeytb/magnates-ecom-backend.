// plantillas-guardadas.controller.ts
//
// Endpoints para la pestaña "💾 Plantillas guardadas" del modal "Plantillas de Secciones" —
// ver plantillas-guardadas.service.ts para el porqué de esta funcionalidad.

import { Body, Controller, Delete, Get, HttpException, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { PlantillasGuardadasService, SeleccionesPlantillas } from './plantillas-guardadas.service';
import { JwtAuthGuard, UsuarioActual, UsuarioAutenticado } from './auth.guard';

interface CrearPlantillaGuardadaDto {
  nombre: string;
  selecciones: SeleccionesPlantillas;
}

@Controller('plantillas-guardadas')
@UseGuards(JwtAuthGuard)
export class PlantillasGuardadasController {
  constructor(private readonly plantillasGuardadasService: PlantillasGuardadasService) {}

  @Get()
  async listar(@UsuarioActual() usuario: UsuarioAutenticado) {
    return this.plantillasGuardadasService.listar(usuario.id);
  }

  @Post()
  async crear(@Body() dto: CrearPlantillaGuardadaDto, @UsuarioActual() usuario: UsuarioAutenticado) {
    const nombre = (dto.nombre || '').trim();
    if (!nombre) {
      throw new HttpException('Ponele un nombre a esta combinación de plantillas antes de guardarla.', HttpStatus.BAD_REQUEST);
    }
    if (!dto.selecciones || Object.keys(dto.selecciones).length === 0) {
      throw new HttpException('No hay ninguna plantilla seleccionada para guardar.', HttpStatus.BAD_REQUEST);
    }
    return this.plantillasGuardadasService.crear(usuario.id, nombre, dto.selecciones);
  }

  @Delete(':id')
  async eliminar(@Param('id') id: string, @UsuarioActual() usuario: UsuarioAutenticado) {
    await this.plantillasGuardadasService.eliminar(usuario.id, Number(id));
    return { ok: true };
  }
}
