// text-generation.controller.ts
//
// Endpoint que llama el botón "✦ Completar los campos de abajo con IA" del
// taller. El frontend ya no manda ninguna API Key: solo el nombre y los
// detalles del producto. La clave de fal.ai (la misma que usa para
// imágenes) se busca en el backend a partir de la sesión del usuario — ver
// integraciones.service.ts.

import { Body, Controller, HttpException, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { TextGenerationService, GenerarCopyResultado, GenerarAngulosResultado } from './text-generation.service';
import { JwtAuthGuard, UsuarioActual, UsuarioAutenticado } from './auth.guard';
import { IntegracionesService } from './integraciones.service';

interface GenerarCopyDto {
  nombreProducto: string;
  detallesProducto: string;
  // Ángulo que el usuario ya eligió entre los 3 que le propuso
  // /generar-angulos — ver GenerarCopyInput en el service.
  anguloElegido?: string;
}

interface GenerarAngulosDto {
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

  private async exigirClaveFal(usuarioId: number): Promise<string> {
    const clave = await this.integracionesService.obtenerClaveFal(usuarioId);
    if (!clave) {
      throw new HttpException(
        'Todavía no conectaste tu clave de fal.ai. Andá a "Integraciones" y conectala primero.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return clave;
  }

  // Primer paso del botón "Completar con IA": le propone al usuario 3
  // ángulos de venta distintos para que elija con cuál seguir.
  @Post('generar-angulos')
  async generarAngulos(@Body() dto: GenerarAngulosDto, @UsuarioActual() usuario: UsuarioAutenticado): Promise<GenerarAngulosResultado> {
    const falApiKey = await this.exigirClaveFal(usuario.id);
    return this.textGenerationService.generarAngulos({
      nombreProducto: dto.nombreProducto,
      detallesProducto: dto.detallesProducto,
      falApiKey,
    });
  }

  // Segundo paso: con el ángulo ya elegido (dto.anguloElegido), redacta el
  // resto de los campos de la landing en base a ese ángulo puntual.
  @Post('generar-copy')
  async generarCopy(@Body() dto: GenerarCopyDto, @UsuarioActual() usuario: UsuarioAutenticado): Promise<GenerarCopyResultado> {
    const falApiKey = await this.exigirClaveFal(usuario.id);
    return this.textGenerationService.generarCopy({
      nombreProducto: dto.nombreProducto,
      detallesProducto: dto.detallesProducto,
      anguloElegido: dto.anguloElegido,
      falApiKey,
    });
  }
}
