// importar-producto.controller.ts
//
// Dos caminos para el módulo "Product Marker":
//  1) POST /piloto-automatico: lo llama la extensión de navegador (pedido
//     16/09) cuando el estudiante hace clic en "Importar a Creadora de
//     Landing" estando en una página de producto de AliExpress/Amazon/Temu
//     — la extensión ya le manda todo lo que scrapeó.
//  2) POST /por-link + GET /estado/:id: lo llama el módulo "Product Marker"
//     DENTRO del propio taller (pedido 17/09 — Norbey ya no quiere que
//     dependa de una extensión: el estudiante pega el link directo en la
//     web, sin instalar nada). Acá el link lo lee el PROPIO SERVIDOR, no un
//     content script en el navegador del estudiante — ver la nota grande en
//     importar-producto.service.ts (scrapearUrlProducto) para las
//     diferencias/limitaciones de leerlo así (reseñas reales, por ejemplo,
//     no se pueden sacar de esta forma).
//     Es asíncrono a propósito (pedido explícito de Norbey: que seguir
//     armándose en el servidor aunque el estudiante cierre la pestaña, pero
//     mostrando una barra de progreso mientras se queda mirando): /por-link
//     devuelve un id al toque y arranca el trabajo en segundo plano;
//     /estado/:id se consulta cada pocos segundos (polling) para saber en
//     qué va.

import { Body, Controller, Get, HttpException, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import {
  EstadoImportacionPorLink,
  ImportarProductoService,
  ImportarProductoResultado,
  PlataformaOrigen,
  ResenaOrigen,
} from './importar-producto.service';
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

  // Paso 1 del módulo "Product Marker" dentro del taller: recibe SOLO el
  // link, arranca el trabajo en segundo plano (scrapear + armar la landing,
  // ver ImportarProductoService.iniciarImportacionPorLink) y devuelve un id
  // al toque — no espera a que termine, para eso está /estado/:id.
  @Post('por-link')
  async importarPorLink(
    @Body() dto: { url?: string },
    @UsuarioActual() usuario: UsuarioAutenticado,
  ): Promise<{ id: string }> {
    const url = (dto?.url || '').trim();
    if (!url) {
      throw new HttpException('Falta el link del producto.', HttpStatus.BAD_REQUEST);
    }
    const falApiKey = await this.integracionesService.obtenerClaveFal(usuario.id);
    if (!falApiKey) {
      throw new HttpException(
        'Todavía no conectaste tu clave de fal.ai. Andá a "Integraciones" y conectala primero.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const id = this.importarProductoService.iniciarImportacionPorLink(usuario.id, falApiKey, url);
    return { id };
  }

  // Paso 2: el taller consulta esto cada pocos segundos (polling) mientras
  // el estudiante se queda mirando la barra de progreso — si cierra la
  // pestaña y vuelve más tarde, esto le sigue contestando igual, porque el
  // trabajo real corre en el servidor sin depender de que alguien esté
  // consultando.
  @Get('estado/:id')
  obtenerEstado(@Param('id') id: string): EstadoImportacionPorLink {
    const estado = this.importarProductoService.obtenerEstadoImportacion(id);
    if (!estado) {
      throw new HttpException('No se encontró esa importación (puede que el servidor se haya reiniciado mientras tanto).', HttpStatus.NOT_FOUND);
    }
    return estado;
  }
}
