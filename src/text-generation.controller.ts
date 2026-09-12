// text-generation.controller.ts
//
// Endpoint que llama el botón "✦ Completar los campos de abajo con IA" del
// taller. El frontend ya no manda ninguna API Key: solo el nombre y los
// detalles del producto. La clave de fal.ai (la misma que usa para
// imágenes) se busca en el backend a partir de la sesión del usuario — ver
// integraciones.service.ts.

import { Body, Controller, HttpException, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { TextGenerationService, GenerarCopyResultado, GenerarAngulosResultado, AdaptarResenaResultado } from './text-generation.service';
import { JwtAuthGuard, UsuarioActual, UsuarioAutenticado } from './auth.guard';
import { IntegracionesService } from './integraciones.service';

interface GenerarCopyDto {
  nombreProducto: string;
  detallesProducto: string;
  // Ángulo que el usuario ya eligió entre los 3 que le propuso
  // /generar-angulos — ver GenerarCopyInput en el service.
  anguloElegido?: string;
  // Pedido 07/09: "🌐 Idioma de Salida" del taller — si el estudiante va a vender en otro
  // país/idioma, este copy (problema/avatar/resultado/solución/mecanismo) debe redactarse
  // en ESE idioma, no siempre en español. Ver GenerarCopyInput en el service.
  idioma?: string;
  // Pedido 09/09: "🌍 País donde vas a vender" del taller — adapta el tono/modismos del
  // copy generado para ese país (ver TONO_POR_PAIS en el service). No reemplaza a idioma:
  // un mismo idioma (ej. español) puede venderse en varios países distintos.
  pais?: string;
}

interface GenerarAngulosDto {
  nombreProducto: string;
  detallesProducto: string;
  idioma?: string;
  pais?: string;
}

// Pedido 11/09: sección "Testimonios" en modo Personalizada — ver
// AdaptarResenaInput en el service. Queda sin usar desde el frontend tras el
// pivote a foto-únicamente (ver GenerarResenaDesdeFotoDto abajo), pero se
// deja el endpoint funcionando por si hace falta volver a este flujo.
interface AdaptarResenaDto {
  textoOriginal: string;
  nombreProducto: string;
  idioma?: string;
  pais?: string;
  nombresUsados?: string[];
  ciudadesUsadas?: string[];
}

// Pedido 11/09 (pivote intermedio, ya sin usar desde el frontend — ver
// GenerarTextoResenaDto más abajo, que es la versión final): el estudiante
// ya no escribe texto — sube solo una foto real y la IA redacta la reseña
// completa mirando esa foto. Ver GenerarResenaDesdeFotoInput en el service.
interface GenerarResenaDesdeFotoDto {
  fotoUrl: string;
  nombreProducto: string;
  idioma?: string;
  pais?: string;
  nombresUsados?: string[];
  ciudadesUsadas?: string[];
}

// Pedido 11/09 (versión final, confirmada con Norbey): la IA ya no mira
// ninguna foto — solo inventa el nombre/ciudad/estrellas/texto de la
// reseña a partir del producto, país e idioma. Ver GenerarTextoResenaInput
// en el service.
interface GenerarTextoResenaDto {
  nombreProducto: string;
  idioma?: string;
  pais?: string;
  nombresUsados?: string[];
  ciudadesUsadas?: string[];
  // Pedido 12/09: ver el comentario grande junto a ENFOQUES_RESENA en
  // text-generation.service.ts — evita que todas las reseñas de un mismo
  // producto salgan con la misma estructura de frase.
  textosUsados?: string[];
  indice?: number;
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
      idioma: dto.idioma,
      pais: dto.pais,
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
      idioma: dto.idioma,
      pais: dto.pais,
      falApiKey,
    });
  }

  // Sección "Testimonios" en modo Personalizada: adapta una reseña real
  // (foto + texto que subió el estudiante) sin inventar contenido nuevo.
  @Post('adaptar-resena')
  async adaptarResena(@Body() dto: AdaptarResenaDto, @UsuarioActual() usuario: UsuarioAutenticado): Promise<AdaptarResenaResultado> {
    const falApiKey = await this.exigirClaveFal(usuario.id);
    return this.textGenerationService.adaptarResena({
      textoOriginal: dto.textoOriginal,
      nombreProducto: dto.nombreProducto,
      idioma: dto.idioma,
      pais: dto.pais,
      nombresUsados: dto.nombresUsados,
      ciudadesUsadas: dto.ciudadesUsadas,
      falApiKey,
    });
  }

  // Sección "Testimonios" en modo Personalizada (flujo actual): el
  // estudiante sube solo una foto real por reseña y la IA redacta el texto
  // completo mirando esa foto (nunca a partir de un texto real del cliente).
  @Post('generar-resena-foto')
  async generarResenaDesdeFoto(
    @Body() dto: GenerarResenaDesdeFotoDto,
    @UsuarioActual() usuario: UsuarioAutenticado,
  ): Promise<AdaptarResenaResultado> {
    const falApiKey = await this.exigirClaveFal(usuario.id);
    return this.textGenerationService.generarResenaDesdeFoto({
      fotoUrl: dto.fotoUrl,
      nombreProducto: dto.nombreProducto,
      idioma: dto.idioma,
      pais: dto.pais,
      nombresUsados: dto.nombresUsados,
      ciudadesUsadas: dto.ciudadesUsadas,
      falApiKey,
    });
  }

  // Sección "Testimonios" en modo Personalizada (versión final): la IA
  // inventa la reseña de texto sin mirar ninguna foto — el avatar se genera
  // aparte (ver ImageEditController.generarAvatarResena) y la foto de la
  // reseña es la que subió el estudiante, tal cual, sin pasar por la IA.
  @Post('generar-texto-resena')
  async generarTextoResena(
    @Body() dto: GenerarTextoResenaDto,
    @UsuarioActual() usuario: UsuarioAutenticado,
  ): Promise<AdaptarResenaResultado> {
    const falApiKey = await this.exigirClaveFal(usuario.id);
    return this.textGenerationService.generarTextoResena({
      nombreProducto: dto.nombreProducto,
      idioma: dto.idioma,
      pais: dto.pais,
      nombresUsados: dto.nombresUsados,
      ciudadesUsadas: dto.ciudadesUsadas,
      textosUsados: dto.textosUsados,
      indice: dto.indice,
      falApiKey,
    });
  }
}
