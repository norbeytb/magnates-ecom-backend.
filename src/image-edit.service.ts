// image-edit.service.ts
//
// Módulo IA — Agente de Imagen (Prompt 12 de la arquitectura).
// Llama a GPT Image 2 a través de fal.ai para generar cada sección de la
// landing, usando la foto real del producto + toda la ficha técnica que
// la persona llenó en el taller.
//
// Instalar el SDK oficial de fal antes de usar esto:
//   npm install @fal-ai/client

import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { fal } from '@fal-ai/client';

export interface FichaTecnica {
  nombreProducto: string;
  detallesProducto: string;           // 🏷 Detalles del producto
  anguloNombre?: string;               // nombre corto del ángulo de venta
  angulo: string;                      // ↗ Ángulo de venta
  problema: string;                    // ⚠ Problema específico que aborda el ángulo
  avatar: string;                      // ◎ Avatar / público objetivo
  resultado: string;                   // ◎ Resultado deseado
  solucion: string;                    // 💡 Cómo el producto se vuelve la solución ideal
  mecanismo: string;                   // ≡ Mecanismo único de la solución
  instrucciones?: string;              // 💬 Instrucciones adicionales (aplican a todas las secciones)
  personajes?: {
    nacionalidad?: string;
    sexo?: string;
    edadDesde?: string;
    edadHasta?: string;
  };
  oferta?: {
    precio1Venta?: string; precio1Comparacion?: string;
    precio2Venta?: string; precio2Comparacion?: string;
    precio3Venta?: string; precio3Comparacion?: string;
    divisa?: string;
  };
  logistica?: {
    pais?: string;
    metodoPago?: string; // 'Contra entrega' | 'Pago anticipado' | 'Ambos'
  };
}

export interface GenerarSeccionInput {
  seccion: string; // 'hero' | 'oferta' | 'logistica' | 'antesdespues' | 'beneficios' | 'tabla' | 'autoridad' | 'testimonios' | 'modouso' | 'faq'
  imagenProductoUrl: string; // foto real subida por el usuario (imgSlot1/2/3)
  ficha: FichaTecnica;
  colorHex?: string; // color elegido en el selector "Color Predominante del fondo"
  numImagenes?: number;
}

export interface GenerarSeccionResultado {
  imagenesUrl: string[];
  promptUsado: string;
  costoEstimadoUsd: number;
}

@Injectable()
export class ImageEditService {
  constructor() {
    fal.config({
      credentials: process.env.FAL_API_KEY, // nunca hardcodear, nunca enviar al frontend
    });
  }

  async generarSeccion(input: GenerarSeccionInput): Promise<GenerarSeccionResultado> {
    const prompt = this.construirPrompt(input);
    const numImagenes = input.numImagenes ?? 1;

    try {
      const resultado = await fal.subscribe('fal-ai/gpt-image-2', {
        input: {
          image_urls: [input.imagenProductoUrl], // GPT Image 2 acepta hasta 16 imágenes de referencia
          prompt,
          num_images: numImagenes,
          quality: 'high', // 'low' | 'medium' | 'high' — 'high' para la pieza final que se publica
        },
        logs: false,
      });

      const imagenesUrl = (resultado.data.images ?? []).map(
        (img: { url: string }) => img.url,
      );

      const costoEstimadoUsd = numImagenes * this.costoPorCalidad('high');

      return { imagenesUrl, promptUsado: prompt, costoEstimadoUsd };
    } catch (error) {
      throw new InternalServerErrorException(
        'No se pudo generar la sección con GPT Image 2: ' + (error as Error).message,
      );
    }
  }

  private costoPorCalidad(calidad: 'low' | 'medium' | 'high'): number {
    // Precios de referencia (verificar tarifa vigente en fal.ai antes de facturar)
    return { low: 0.006, medium: 0.041, high: 0.211 }[calidad];
  }

  /**
   * Arma el prompt de edición según la sección elegida, incorporando SOLO
   * los campos de la ficha técnica que aplican a esa sección — así el
   * modelo no se satura con datos irrelevantes (ej. precios en un Hero).
   */
  private construirPrompt(input: GenerarSeccionInput): string {
    const f = input.ficha;
    const partes: string[] = [];

    partes.push(
      `Mantén el producto de la imagen de referencia exactamente igual — misma forma, color, materiales y proporciones, sin alterarlo ni reemplazarlo.`,
    );

    if (input.colorHex) {
      partes.push(`Usa ${input.colorHex} como color predominante del fondo y los acentos visuales.`);
    }

    const seccionesConPersonaje = ['hero', 'antesdespues', 'testimonios', 'autoridad', 'modouso'];
    if (seccionesConPersonaje.includes(input.seccion) && f.personajes) {
      const p = f.personajes;
      const rasgos = [
        p.nacionalidad && p.nacionalidad !== 'Seleccionar...' ? `nacionalidad ${p.nacionalidad}` : null,
        p.sexo && p.sexo !== 'Seleccionar...' ? p.sexo.toLowerCase() : null,
        p.edadDesde && p.edadHasta ? `entre ${p.edadDesde} y ${p.edadHasta} años` : null,
      ].filter(Boolean);
      if (rasgos.length) {
        partes.push(`Incluye una persona con estas características: ${rasgos.join(', ')}, interactuando de forma natural con el producto.`);
      }
    }

    switch (input.seccion) {
      case 'hero':
        partes.push(
          `Genera una sección Hero de landing page: titular llamativo con "${f.nombreProducto}", subtítulo basado en "${this.recortar(f.angulo, 120)}", y 3-4 viñetas de beneficios extraídas de: ${this.recortar(f.detallesProducto, 200)}.`,
        );
        break;

      case 'oferta':
        if (f.oferta) {
          const o = f.oferta;
          const filas = [
            o.precio1Venta ? `1 unidad: ${o.precio1Venta}${o.precio1Comparacion ? ` (antes ${o.precio1Comparacion})` : ''}` : null,
            o.precio2Venta ? `2 unidades: ${o.precio2Venta}${o.precio2Comparacion ? ` (antes ${o.precio2Comparacion})` : ''}` : null,
            o.precio3Venta ? `3 unidades: ${o.precio3Venta}${o.precio3Comparacion ? ` (antes ${o.precio3Comparacion})` : ''}` : null,
          ].filter(Boolean);
          partes.push(
            `Genera una sección de Oferta con estos precios exactos (divisa ${o.divisa || 'USD'}): ${filas.join(' · ')}. Incluye un botón de llamado a la acción tipo "Cómpralo ahora".`,
          );
        }
        break;

      case 'logistica':
        if (f.logistica) {
          partes.push(
            `Genera una sección de Logística/envío para ${f.logistica.pais || 'el país configurado'}, mostrando el método de pago "${f.logistica.metodoPago || 'Contra entrega'}" y transmitiendo confianza en la entrega.`,
          );
        }
        break;

      case 'antesdespues':
        partes.push(
          `Genera una sección Antes/Después: el lado "antes" debe representar visualmente el problema (${this.recortar(f.problema, 150)}), el lado "después" el resultado deseado (${this.recortar(f.resultado, 150)}).`,
        );
        break;

      case 'beneficios':
        partes.push(
          `Genera una sección de Beneficios con 3-4 tarjetas, cada una con un ícono y un beneficio corto extraído de: ${this.recortar(f.detallesProducto, 250)}.`,
        );
        break;

      case 'testimonios':
        partes.push(
          `Genera una sección de Testimonios con 2-3 reseñas cortas de clientes que lograron: ${this.recortar(f.resultado, 150)}. Incluye nombre, calificación de 5 estrellas y una foto de la persona descrita.`,
        );
        break;

      case 'autoridad':
        partes.push(
          `Genera una sección de Prueba de Autoridad: una cita de un experto explicando por qué funciona el mecanismo único del producto: ${this.recortar(f.mecanismo, 150)}.`,
        );
        break;

      case 'modouso':
        partes.push(
          `Genera una sección de Modo de Uso con 3 pasos numerados, basados en cómo el producto se convierte en la solución ideal: ${this.recortar(f.solucion, 200)}.`,
        );
        break;

      case 'faq':
        partes.push(
          `Genera una sección de Preguntas Frecuentes con 3-4 pares pregunta/respuesta cortos, cubriendo: qué es el producto (${this.recortar(f.detallesProducto, 100)}), para quién es (${this.recortar(f.avatar, 100)}), y cómo funciona (${this.recortar(f.mecanismo, 100)}).`,
        );
        break;

      case 'tabla':
        partes.push(
          `Genera una sección de Tabla Comparativa: "${f.nombreProducto}" contra la competencia genérica, resaltando las ventajas descritas en: ${this.recortar(f.solucion, 200)}.`,
        );
        break;
    }

    if (f.instrucciones) {
      partes.push(`Instrucción adicional del usuario (aplica a esta y todas las secciones): ${f.instrucciones}`);
    }

    partes.push(
      `Estilo publicitario profesional, tipografía legible y bien contrastada, texto sin errores ortográficos ni caracteres extraños.`,
    );

    return partes.join(' ');
  }

  private recortar(texto: string | undefined, max: number): string {
    if (!texto) return '';
    return texto.length > max ? texto.slice(0, max - 1) + '…' : texto;
  }
}
