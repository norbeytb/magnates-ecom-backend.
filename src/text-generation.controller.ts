// text-generation.controller.ts
//
// Endpoint que llama el botón "✦ Completar los campos de abajo con IA" del
// taller. El frontend ya no manda ninguna API Key: solo el nombre y los
// detalles del producto. La key vive únicamente en este servidor.

import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { TextGenerationService, GenerarCopyResultado } from './text-generation.service';
import { JwtAuthGuard } from './auth.guard';

interface GenerarCopyDto {
  nombreProducto: string;
  detallesProducto: string;
}

@Controller('ia/texto')
@UseGuards(JwtAuthGuard)
export class TextGenerationController {
  constructor(private readonly textGenerationService: TextGenerationService) {}

  @Post('generar-copy')
  async generarCopy(@Body() dto: GenerarCopyDto): Promise<GenerarCopyResultado> {
    return this.textGenerationService.generarCopy({
      nombreProducto: dto.nombreProducto,
      detallesProducto: dto.detallesProducto,
    });
  }
}
