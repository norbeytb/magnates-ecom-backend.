// importar-producto.controller.ts
//
// Endpoint que llama la extensión de navegador "Product Marker" (pedido
// 16/09) cuando el estudiante hace clic en "Importar a Creadora de Landing"
// estando en una página de producto de AliExpress/Amazon/Temu — ver la nota
// grande en importar-producto.service.ts para el detalle completo del
// piloto automático.

import { Body, Controller, HttpException, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ImportarProductoService, ImportarProductoResultado, PlataformaOrigen, ResenaOrigen } from './importar-producto.service';
import { JwtAuthGuard, UsuarioActual, UsuarioAutenticado } from './auth.guard';
import { IntegracionesService } from './integraciones.service';

interface PilotoAutomaticoDto {
  url: string;
  plataforma: PlataformaOrigen;
  titulo: string;
  descripcion: string;
  fotos: string[];
  precioOriginal?: number;
  moneda?: string;
  // Reseñas reales scrapeadas de la página de origen (16/09, ver
  // importar-producto.service.ts) — opcional.
  resenas?: ResenaOrigen[];
}

@Controller('importar-producto')
@UseGuards(JwtAuthGuard)
export class ImportarProductoController {
  constructor(
    private readonly importarProductoService: ImportarProductoService,
    private readonly integracionesService: IntegracionesService,
  ) {}

  // La extensión manda acá lo que scrapeó de la página de origen — este
  // backend se encarga de todo lo demás (ángulo, copy, imágenes, precio
  // sugerido, guardado) sin que el estudiante tenga que hacer nada más.
  @Post('piloto-automatico')
  async pilotoAutomatico(
    @Body() dto: PilotoAutomaticoDto,
    @UsuarioActual() usuario: UsuarioAutenticado,
  ): Promise<ImportarProductoResultado> {
    const falApiKey = await this.integracionesService.obtenerClaveFal(usuario.id);
    if (!falApiKey) {
      throw new HttpException(
        'Todavía no conectaste tu clave de fal.ai. Andá a "Integraciones" y conectala primero.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.importarProductoService.pilotoAutomatico(usuario.id, falApiKey, {
      usuarioId: usuario.id,
      falApiKey,
      url: dto?.url,
      plataforma: dto?.plataforma,
      titulo: dto?.titulo,
      descripcion: dto?.descripcion,
      fotos: dto?.fotos || [],
      precioOriginal: dto?.precioOriginal,
      moneda: dto?.moneda,
      resenas: dto?.resenas || [],
    });
  }
}
