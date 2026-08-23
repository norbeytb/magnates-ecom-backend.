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
  imagenProductoUrl: string; // foto real subida por el usuario (imgSlot1/2/3) — acepta URL pública o data URI base64
  plantillaReferenciaUrl?: string; // miniatura de la plantilla elegida en la Galería EcomMagic — mismo formato de imagen que imagenProductoUrl
  ficha: FichaTecnica;
  colorHex?: string; // color elegido en el selector "Color Predominante del fondo"
  numImagenes?: number;
  calidad?: 'low' | 'medium' | 'high'; // por defecto 'low' — ver nota de costo en generarSeccion()
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
      // fal.ai rechaza (422 Unprocessable Entity) un data URI base64 puesto
      // directamente en image_urls: necesita una URL real ya alojada. Si el
      // taller nos manda la foto como base64 (data:image/...;base64,...), la
      // subimos primero al storage de fal.ai y usamos la URL que nos regresa.
      const imagenUrl = await this.resolverImagenUrl(input.imagenProductoUrl);

      // Si el taller mandó también la miniatura de la plantilla elegida, la
      // subimos igual y la mandamos como PRIMERA imagen de referencia — así
      // el modelo tiene la composición/layout real que debe imitar, no solo
      // una descripción en texto de "genera una sección Hero".
      const plantillaUrl = input.plantillaReferenciaUrl
        ? await this.resolverImagenUrl(input.plantillaReferenciaUrl)
        : null;
      const imageUrls = plantillaUrl ? [plantillaUrl, imagenUrl] : [imagenUrl];

      // IMPORTANTE: 'openai/gpt-image-2' (sin /edit) es solo texto->imagen y
      // NO acepta image_urls. Para editar/generar usando la foto real del
      // producto como referencia hay que usar la variante /edit.
      //
      // ---- Nota de costo (importante, no bajar la guardia aquí) ----
      // gpt-image-2/edit SIEMPRE procesa las imágenes de referencia (plantilla +
      // producto) en alta fidelidad — ese parámetro (input_fidelity) viene fijo
      // por el modelo y NO se puede bajar desde acá. La palanca de costo que SÍ
      // controlamos es 'quality' (por defecto 'low', ~4x más barato que 'medium'
      // y ~10x más barato que 'high'). 'high' queda disponible a futuro solo para
      // una exportación final puntual (pasando calidad:'high' desde el frontend),
      // nunca como default.
      //
      // 'image_size': se probó primero un tamaño horizontal ('landscape_4_3') para
      // bajar costo, pero rompió la generación (422) en varias secciones porque las
      // piezas de este taller son verticales tipo teléfono. Luego se probó dejarlo
      // en 'auto' (el default de fal), pero eso dejó que fal eligiera un tamaño más
      // corto/cuadrado que el marco vertical del taller — el resultado quedaba con
      // contenido solo arriba y un espacio en blanco abajo (no cabía en el marco).
      // Fijo ahora en 'portrait_16_9' (el preset vertical más alto disponible en el
      // modelo): coincide con la proporción de teléfono que usa el taller para
      // mostrar cada sección, así la imagen generada llena el marco completo.
      const calidad = input.calidad ?? 'low';

      try {
        const imagenesUrl = await this.llamarFal(imageUrls, prompt, numImagenes, calidad);
        const costoEstimadoUsd = numImagenes * this.costoPorCalidad(calidad);
        return { imagenesUrl, promptUsado: prompt, costoEstimadoUsd };
      } catch (error) {
        // El filtro de contenido de OpenAI revisa TANTO el texto como las imágenes que
        // le mandamos. Muchas plantillas de este catálogo (fotos de personas en ropa
        // ajustada, torsos descubiertos, etc.) lo disparan aunque el texto sea neutro —
        // no es algo que podamos desactivar. Si la imagen de plantilla de referencia fue
        // la causa, reintentamos UNA vez sin ella (solo con la foto real del producto,
        // que casi nunca dispara el filtro) — se pierde la copia exacta de composición,
        // pero el modelo igual tiene toda la descripción en texto de qué debe generar.
        if (this.esErrorDeContentChecker(error) && plantillaUrl) {
          const imagenesUrl = await this.llamarFal([imagenUrl], prompt, numImagenes, calidad);
          const costoEstimadoUsd = numImagenes * this.costoPorCalidad(calidad);
          return { imagenesUrl, promptUsado: prompt, costoEstimadoUsd };
        }
        throw error;
      }
    } catch (error) {
      throw new InternalServerErrorException(
        'No se pudo generar la sección con GPT Image 2: ' + this.extraerDetalleError(error),
      );
    }
  }

  private async llamarFal(
    imageUrls: string[],
    prompt: string,
    numImagenes: number,
    calidad: 'low' | 'medium' | 'high',
  ): Promise<string[]> {
    const resultado = await fal.subscribe('openai/gpt-image-2/edit', {
      input: {
        image_urls: imageUrls,
        prompt,
        num_images: numImagenes,
        quality: calidad,
        image_size: 'portrait_16_9',
      },
      logs: false,
    });
    return (resultado.data.images ?? []).map((img: { url: string }) => img.url);
  }

  // Sacar el detalle real del error de validación/moderación de fal.ai (no solo
  // "Unprocessable Entity" genérico) — el SDK de fal suele traer el motivo exacto
  // en error.body.detail.
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

  private esErrorDeContentChecker(error: unknown): boolean {
    const detalle = this.extraerDetalleError(error).toLowerCase();
    return detalle.includes('content checker') || detalle.includes('flagged');
  }

  /**
   * Si la imagen viene como data URI base64 (foto subida directamente en el
   * taller, sin backend propio de assets todavía), la sube al storage de
   * fal.ai y devuelve la URL pública resultante. Si ya es una URL normal
   * (http/https), la deja tal cual.
   */
  private async resolverImagenUrl(imagenProductoUrl: string): Promise<string> {
    if (!imagenProductoUrl || !imagenProductoUrl.startsWith('data:')) {
      return imagenProductoUrl; // ya es una URL pública, no hay nada que subir
    }
    const match = imagenProductoUrl.match(/^data:([^;]+);base64,(.*)$/);
    if (!match) {
      throw new InternalServerErrorException(
        'Formato de imagen no reconocido (se esperaba una URL o un data URI base64 válido).',
      );
    }
    const [, mimeType, base64Data] = match;
    const buffer = Buffer.from(base64Data, 'base64');
    const blob = new Blob([buffer], { type: mimeType });
    return fal.storage.upload(blob);
  }

  private costoPorCalidad(calidad: 'low' | 'medium' | 'high'): number {
    // Precios de referencia para image_size 'portrait_16_9' (~1024x1536, el
    // vertical que usamos ahora) — verificar tarifa vigente en fal.ai antes de
    // facturar. Con 'low' el promedio queda en ~$18 USD por cada 1000 imágenes.
    return { low: 0.018, medium: 0.054, high: 0.178 }[calidad];
  }

  private readonly ETIQUETAS_SECCION: Record<string, string> = {
    hero: 'Hero (portada / titular principal)',
    oferta: 'Oferta y Precios',
    logistica: 'Logística / Envío y método de pago',
    antesdespues: 'Antes y Después',
    beneficios: 'Beneficios',
    testimonios: 'Testimonios',
    autoridad: 'Prueba de Autoridad',
    modouso: 'Modo de Uso',
    faq: 'Preguntas Frecuentes',
    tabla: 'Tabla Comparativa',
  };

  /**
   * Arma el prompt de edición según la sección elegida, incorporando SOLO
   * los campos de la ficha técnica que aplican a esa sección — así el
   * modelo no se satura con datos irrelevantes (ej. precios en un Hero).
   */
  private construirPrompt(input: GenerarSeccionInput): string {
    const f = input.ficha;
    const partes: string[] = [];
    const etiquetaSeccion = this.ETIQUETAS_SECCION[input.seccion] || input.seccion;

    // Directiva de apertura, deliberadamente lo primero que lee el modelo: fija
    // el TIPO de sección antes que cualquier otra instrucción (plantilla, ángulo
    // de venta, etc.) para evitar que el modelo "por defecto" arme un Hero/pieza
    // de venta genérica cuando en realidad se pidió otra sección (ej. Logística).
    partes.push(
      `Vas a generar EXCLUSIVAMENTE la sección "${etiquetaSeccion}" de una landing page. Todo el contenido, mensaje y composición deben corresponder a ESE tipo de sección — por ejemplo, si es Logística/Envío no generes un titular de venta tipo Hero, y si es Testimonios no generes una tabla de precios. Las instrucciones específicas de esta sección están más abajo.`,
    );

    if (input.plantillaReferenciaUrl) {
      partes.push(
        `Se te dan dos imágenes. La PRIMERA imagen es una plantilla de diseño de referencia: reproduce su misma composición exacta — disposición de los elementos, tamaños relativos, tipografía, jerarquía visual y estilo gráfico — como si fuera la plantilla/molde de esta pieza. La SEGUNDA imagen es el producto real que debes usar: consérvalo exactamente igual (misma forma, color, materiales y proporciones, sin alterarlo ni reemplazarlo) y colócalo en el lugar donde la plantilla tiene su producto. Todo el texto de la plantilla original debe reemplazarse por el contenido nuevo indicado abajo — no copies el texto de la plantilla. IMPORTANTE sobre personas: si en la plantilla de referencia aparece una persona o modelo, NO la copies ni la repitas en el resultado bajo ninguna circunstancia — debes generar una persona completamente distinta y nueva (rostro, cuerpo y apariencia diferentes a los de la plantilla), conservando únicamente la pose/composición general de la escena. Las características que debe tener esa persona nueva se indican más abajo si el usuario las especificó.`,
      );
    } else {
      partes.push(
        `Mantén el producto de la imagen de referencia exactamente igual — misma forma, color, materiales y proporciones, sin alterarlo ni reemplazarlo.`,
      );
    }

    if (input.colorHex) {
      partes.push(`Usa ${input.colorHex} como color predominante del fondo y los acentos visuales.`);
    }

    // El ángulo de venta se define UNA vez al crear el producto/ficha (no por sección) y debe
    // guiar el TONO y mensaje de fondo de TODAS las secciones — pero es secundario al tipo de
    // sección: no debe convertir una sección de Logística/Testimonios/Tabla, etc. en un Hero.
    if (f.angulo) {
      partes.push(
        `Ten en cuenta este ángulo de venta SOLO como tono/mensaje de fondo de la marca${f.anguloNombre ? ` (ángulo "${f.anguloNombre}")` : ''}: ${this.recortar(f.angulo, 200)}. No lo uses como titular ni conviertas esta pieza en un Hero de venta si el tipo de sección pedido es otro — el tipo de sección manda sobre el ángulo de venta.`,
      );
    }

    // Se aplica a CUALQUIER sección (no solo a una lista fija): si el usuario
    // definió características de personaje, se incluyen siempre que la
    // escena resultante muestre una persona — y esa persona debe ser nueva,
    // nunca la misma que aparece en la imagen de plantilla de referencia.
    if (f.personajes) {
      const p = f.personajes;
      const rasgos = [
        p.nacionalidad && p.nacionalidad !== 'Seleccionar...' ? `nacionalidad ${p.nacionalidad}` : null,
        p.sexo && p.sexo !== 'Seleccionar...' ? p.sexo.toLowerCase() : null,
        p.edadDesde && p.edadHasta ? `entre ${p.edadDesde} y ${p.edadHasta} años` : null,
      ].filter(Boolean);
      if (rasgos.length) {
        partes.push(
          `Si la escena incluye una persona, esa persona (nueva, distinta a la de la plantilla de referencia) debe tener EXACTAMENTE estas características: ${rasgos.join(', ')}. Debe interactuar de forma natural con el producto. No uses una persona con características diferentes a las indicadas.`,
        );
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

      case 'logistica': {
        // f.logistica.pais puede traer el texto placeholder del selector ("Selecciona el
        // país") si el usuario nunca lo tocó — filtrarlo para no meterle al modelo una
        // instrucción rota tipo "envío para Selecciona el país".
        const paisValido =
          f.logistica?.pais && !/seleccion/i.test(f.logistica.pais) ? f.logistica.pais : null;
        partes.push(
          `Genera una sección de Logística/Envío: debe transmitir confianza en la entrega ${paisValido ? `hacia ${paisValido}` : 'a nivel nacional'}, mostrando el método de pago "${f.logistica?.metodoPago || 'Contra entrega'}". Usa iconografía y composición típica de envío/entrega (ej. caja, camión, mensajero, sello de garantía/confianza) — NO generes un titular de venta ni una tabla de precios, esta sección es sobre el envío, no sobre vender el producto.`,
        );
        break;
      }

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

    // Recordatorio de cierre (el modelo también pesa mucho lo último que lee): refuerza
    // una vez más el tipo de sección para que no "derive" hacia un Hero genérico.
    partes.push(
      `Recuerda: el resultado final debe verse y sentirse como una sección de "${etiquetaSeccion}", no como una portada/Hero de venta directa, salvo que el tipo de sección pedido sea justamente ese.`,
    );

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
