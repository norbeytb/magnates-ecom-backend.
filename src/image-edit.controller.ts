// image-edit.controller.ts
//
// Endpoint que el botón "✨ Generar Sección" del taller llamaría en vez de
// simular la generación. El frontend nunca ve la API key de fal.ai: solo
// habla con TU backend, y es tu backend quien habla con fal.ai.

import { Body, Controller, Post } from '@nestjs/common';
import { ImageEditService, GenerarSeccionResultado } from './image-edit.service';

interface PersonajesDto {
  nacionalidad?: string;
  sexo?: string;
  edadDesde?: string;
  edadHasta?: string;
}

interface OfertaDto {
  precio1Venta?: string; precio1Comparacion?: string;
  precio2Venta?: string; precio2Comparacion?: string;
  precio3Venta?: string; precio3Comparacion?: string;
  divisa?: string;
}

interface LogisticaDto {
  pais?: string;
  metodoPago?: string;
}

interface GenerarSeccionDto {
  seccion: string;
  imagenProductoUrl: string;
  plantillaReferenciaUrl?: string;
  plantillaDescripcion?: string;
  colorHex?: string;
  calidad?: 'low' | 'medium' | 'high';

  // --- ficha técnica (misma estructura que el formulario del taller) ---
  nombreProducto: string;
  detallesProducto: string;
  anguloNombre?: string;
  angulo: string;
  problema: string;
  avatar: string;
  resultado: string;
  solucion: string;
  mecanismo: string;
  instrucciones?: string;

  // --- bloques de configuración condicionales ---
  personajes?: PersonajesDto;
  oferta?: OfertaDto;
  logistica?: LogisticaDto;
}

@Controller('ia/imagenes')
export class ImageEditController {
  constructor(private readonly imageEditService: ImageEditService) {}

  @Post('generar-seccion')
  async generarSeccion(@Body() dto: GenerarSeccionDto): Promise<GenerarSeccionResultado> {
    return this.imageEditService.generarSeccion({
      seccion: dto.seccion,
      imagenProductoUrl: dto.imagenProductoUrl,
      plantillaReferenciaUrl: dto.plantillaReferenciaUrl,
      plantillaDescripcion: dto.plantillaDescripcion,
      colorHex: dto.colorHex,
      calidad: dto.calidad,
      ficha: {
        nombreProducto: dto.nombreProducto,
        detallesProducto: dto.detallesProducto,
        anguloNombre: dto.anguloNombre,
        angulo: dto.angulo,
        problema: dto.problema,
        avatar: dto.avatar,
        resultado: dto.resultado,
        solucion: dto.solucion,
        mecanismo: dto.mecanismo,
        instrucciones: dto.instrucciones,
        personajes: dto.personajes,
        oferta: dto.oferta,
        logistica: dto.logistica,
      },
    });
  }

  // Sube (a fal.storage) la foto que el usuario acaba de poner en un slot de
  // Imagen 1/2/3, sin generar nada — solo para tener una URL real y liviana que
  // guardar en el backend (ver ProductosController) y que la foto reaparezca
  // cada vez que se abra ese producto, incluso si nunca se genera una sección.
  @Post('subir-foto-producto')
  async subirFotoProducto(@Body('dataUri') dataUri: string): Promise<{ url: string }> {
    const url = await this.imageEditService.subirFotoProducto(dataUri);
    return { url };
  }
}
