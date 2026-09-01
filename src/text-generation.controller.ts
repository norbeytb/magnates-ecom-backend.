// text-generation.controller.ts
//
// Endpoint que llama el botón "✦ Completar los campos de abajo con IA" del
// taller. El frontend ya no manda ninguna API Key: solo el nombre y los
// detalles del producto. La clave de fal.ai (la misma que usa para
// imágenes) se busca en el backend a partir de la sesión del usuario — ver
// integraciones.service.ts.

import { Body, Controller, HttpException, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { TextGenerationService, GenerarCopyResultado } from './text-generation.service';
import { JwtAuthGuard, UsuarioActual, UsuarioAutenticado } from './auth.guard';
import { IntegracionesService } from './integraciones.service';

interface GenerarCopyDto {
  nombreProducto: string;
  detallesProducto: string;
}

@Controller('ia/texto')
@UseGuards(JwtAuthGuard)
export class TextGenerationController {
  constructor(
    private readonly textGenerationService: TextGenerationService,
    private readonly integracionesService: IntegracionesService,
  ) {}

  @Post('generar-copy')
  async generarCopy(@Body() dto: GenerarCopyDto, @UsuarioActual() usuario: UsuarioAutenticado): Promise<GenerarCopyResultado> {
    const falApiKey = await this.integracionesService.obtenerClaveFal(usuario.id);
    if (!falApiKey) {
      throw new HttpException(
        'Todavía no conectaste tu clave de fal.ai. Andá a "Integraciones" y conectala primero.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.textGenerationService.generarCopy({
      nombreProducto: dto.nombreProducto,
      detallesProducto: dto.detallesProducto,
      falApiKey,
    });
  }
}
