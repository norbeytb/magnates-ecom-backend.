// text-generation.service.ts
//
// Módulo IA — Agente de Copywriting (texto). Antes esta llamada la hacía el
// propio navegador del usuario, pidiéndole que pegara su propia API Key de
// Anthropic; después pasó a vivir en el backend usando una ANTHROPIC_API_KEY
// compartida del servidor.
//
// Ahora usa la MISMA clave de fal.ai que el usuario ya conectó para generar
// imágenes (ver integraciones.service.ts / image-edit.service.ts) — a
// propósito, para que cada estudiante tenga UNA sola clave que pagar y
// conectar, no dos. fal.ai expone modelos de texto (incluido Claude) a
// través de su endpoint unificado "fal-ai/any-llm", autenticado con la misma
// clave que los modelos de imagen — por eso ya no hace falta una
// ANTHROPIC_API_KEY aparte ni que el usuario pegue una segunda clave.

import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { createFalClient } from '@fal-ai/client';

export interface GenerarCopyInput {
  nombreProducto: string;
  detallesProducto: string;
  // La clave de fal.ai DE ESE USUARIO — el controlador la busca antes de
  // llamar acá y avisa con un error claro si el usuario todavía no la
  // conectó en "Integraciones".
  falApiKey: string;
}

export interface GenerarCopyResultado {
  angulo: string;
  problema: string;
  avatar: string;
  resultado: string;
  solucion: string;
  mecanismo: string;
}

// Modelo de Claude servido a través del router de fal.ai (fal-ai/any-llm) —
// mismo modelo (Haiku) que se usaba antes llamando directo a la API de
// Anthropic: alcanza de sobra para esta tarea (redactar texto corto y
// estructurado) y es el más económico de la familia Claude.
const MODELO_TEXTO = 'anthropic/claude-haiku-4.5';

@Injectable()
export class TextGenerationService {
  async generarCopy(input: GenerarCopyInput): Promise<GenerarCopyResultado> {
    if (!input.falApiKey) {
      throw new InternalServerErrorException('Todavía no conectaste tu clave de fal.ai. Andá a "Integraciones" y conectala primero.');
    }

    const systemPrompt = `Eres un equipo experto compuesto por: especialista en eCommerce, copywriter senior de respuesta directa, especialista en Meta Ads y TikTok Ads, especialista en CRO (Conversion Rate Optimization), y diseñador de landing pages de alta conversión.

Tu tarea es analizar la ficha técnica de un producto (de cualquier categoría: hogar, belleza, salud, fitness, mascotas, tecnología, moda, etc.) y construir una estrategia de marketing completa, específica para ese producto y nunca genérica.

Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional antes ni después, sin bloques de markdown, con exactamente estas claves (todos los valores en español, redactados con enfoque de copywriting persuasivo y de conversión, cada uno de 1 a 3 frases concretas):
{"angulo":"...","problema":"...","avatar":"...","resultado":"...","solucion":"...","mecanismo":"..."}

Significado de cada clave:
- angulo: el ángulo de venta principal con mayor potencial de conversión.
- problema: el problema específico que resuelve y cómo lo vive el cliente hoy.
- avatar: el público objetivo ideal (edad, intereses, comportamiento).
- resultado: el resultado final y transformación que el cliente busca.
- solucion: por qué este producto es la solución ideal frente a otras alternativas (alternativas de PRODUCTO, ej. otras marcas o métodos caseros — nunca alternativas médicas, ver regla abajo).
- mecanismo: el mecanismo único o diferenciador frente a la competencia.

REGLA IMPORTANTE (aplica a las 6 claves, especialmente para productos de belleza/moda/salud/fitness): este texto se usa después para generar imágenes con IA, y cualquier mención a cirugía, procedimientos médicos/quirúrgicos, tratamientos clínicos, riesgos de salud, o comparaciones tipo "sin cirugía"/"sin necesidad de operarte" hace que la generación de imagen se bloquee por filtros de contenido. NUNCA menciones cirugía, procedimientos quirúrgicos/médicos, ni riesgos de salud, ni siquiera para decir que el producto es la alternativa segura o más rápida. Describe el producto solo por sus beneficios directos (comodidad, estilo, practicidad, apariencia, confianza), nunca comparándolo con un procedimiento médico.`;

    const userMsg = `Nombre del producto: ${input.nombreProducto}\n\nFicha técnica / detalles del producto:\n${input.detallesProducto}`;

    const falClient = createFalClient({ credentials: input.falApiKey });

    let resultado;
    try {
      resultado = await falClient.subscribe('fal-ai/any-llm', {
        input: {
          model: MODELO_TEXTO,
          prompt: userMsg,
          system_prompt: systemPrompt,
          max_tokens: 1000,
          temperature: 0.7,
        },
        logs: false,
      });
    } catch (error) {
      if (this.esErrorDeClaveFalInvalida(error)) {
        throw new InternalServerErrorException(
          'fal.ai rechazó tu clave — revisá que la hayas pegado completa en "Integraciones" y que tengas créditos cargados en tu cuenta de fal.ai.',
        );
      }
      throw new InternalServerErrorException('No se pudo contactar a fal.ai: ' + this.extraerDetalleError(error));
    }

    const texto = (resultado?.data as any)?.output;
    if (!texto || typeof texto !== 'string') {
      throw new InternalServerErrorException('La respuesta de fal.ai no incluyó texto.');
    }

    const clean = texto
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/, '')
      .replace(/```\s*$/, '')
      .trim();

    try {
      return JSON.parse(clean);
    } catch {
      throw new InternalServerErrorException('La respuesta de fal.ai no fue un JSON válido.');
    }
  }

  // Sacar el detalle real del error de fal.ai (no solo "Unprocessable
  // Entity" genérico) — el SDK de fal suele traer el motivo exacto en
  // error.body.detail (mismo patrón que usa image-edit.service.ts).
  private extraerDetalleError(error: unknown): string {
    const err = error as any;
    return (
      (Array.isArray(err?.body?.detail)
        ? err.body.detail.map((d: any) => d.msg || JSON.stringify(d)).join('; ')
        : err?.body?.detail) ||
      err?.message ||
      String(error)
    );
  }

  private esErrorDeClaveFalInvalida(error: unknown): boolean {
    const status = (error as any)?.status;
    return status === 401 || status === 403;
  }
}
