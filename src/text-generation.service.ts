// text-generation.service.ts
//
// Módulo IA — Agente de Copywriting (texto). Antes esta llamada la hacía el
// propio navegador del usuario, pidiéndole que pegara su propia API Key de
// Anthropic. Ahora vive aquí, en el backend, usando la ANTHROPIC_API_KEY
// del servidor (variable de entorno en Railway) — el usuario del taller ya
// no necesita tener ni pegar ninguna key.

import { Injectable, InternalServerErrorException } from '@nestjs/common';

export interface GenerarCopyInput {
  nombreProducto: string;
  detallesProducto: string;
}

export interface GenerarCopyResultado {
  angulo: string;
  problema: string;
  avatar: string;
  resultado: string;
  solucion: string;
  mecanismo: string;
}

@Injectable()
export class TextGenerationService {
  async generarCopy(input: GenerarCopyInput): Promise<GenerarCopyResultado> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new InternalServerErrorException(
        'El servidor no tiene configurada la variable de entorno ANTHROPIC_API_KEY.',
      );
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
- solucion: por qué este producto es la solución ideal frente a otras alternativas.
- mecanismo: el mecanismo único o diferenciador frente a la competencia.`;

    const userMsg = `Nombre del producto: ${input.nombreProducto}\n\nFicha técnica / detalles del producto:\n${input.detallesProducto}`;

    let response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          // Haiku 4.5: suficiente para esta tarea (extraer/redactar texto corto
          // y estructurado) y mucho más económico que un modelo más grande.
          model: 'claude-haiku-4-5',
          max_tokens: 1000,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMsg }],
        }),
      });
    } catch (error) {
      throw new InternalServerErrorException(
        'No se pudo contactar la API de Claude: ' + (error as Error).message,
      );
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new InternalServerErrorException(
        `La API de Claude respondió ${response.status}: ${errText.slice(0, 220)}`,
      );
    }

    const data = await response.json();
    const textBlock = (data.content ?? []).find(
      (b: { type: string }) => b.type === 'text',
    );
    if (!textBlock) {
      throw new InternalServerErrorException('La respuesta de Claude no incluyó texto.');
    }

    const clean = (textBlock.text as string)
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/, '')
      .replace(/```\s*$/, '')
      .trim();

    try {
      return JSON.parse(clean);
    } catch {
      throw new InternalServerErrorException('La respuesta de Claude no fue un JSON válido.');
    }
  }
}
