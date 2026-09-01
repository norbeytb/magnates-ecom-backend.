// image-edit.service.ts
//
// Módulo IA — Agente de Imagen (Prompt 12 de la arquitectura).
// Llama a GPT Image 2 a través de fal.ai para generar cada sección de la
// landing, usando la foto real del producto + toda la ficha técnica que
// la persona llenó en el taller.
//
// CADA USUARIO USA SU PROPIA CLAVE DE fal.ai (módulo de Integraciones, ver
// integraciones.service.ts): antes este servicio configuraba una sola clave
// global (FAL_API_KEY de Railway) con fal.config() al arrancar el backend.
// Ahora cada llamada recibe la clave del usuario que la pidió (falApiKey) y
// crea con ella un cliente de fal AISLADO con createFalClient({credentials})
// — nunca se usa fal.config()/el cliente "fal" global, porque ese es un
// estado compartido por todas las peticiones a la vez (este servicio es un
// singleton) y dos usuarios generando al mismo tiempo pisarían la clave del
// otro. createFalClient() en cambio da una instancia nueva e independiente
// por llamada, segura para varias peticiones en simultáneo.
//
// Instalar el SDK oficial de fal antes de usar esto:
//   npm install @fal-ai/client

import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { createFalClient, FalClient } from '@fal-ai/client';
import { HistorialService } from './historial.service';

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
  // Quién pidió esta generación (ver auth.guard.ts) — se usa solo para que el
  // historial guardado quede a nombre de esta cuenta (ver exito() más abajo).
  usuarioId: number;
  // La clave de fal.ai DE ESE USUARIO (ver integraciones.service.ts) — el
  // controlador la busca antes de llamar acá y avisa con un error claro si
  // el usuario todavía no conectó ninguna en "Integraciones".
  falApiKey: string;
  seccion: string; // 'hero' | 'oferta' | 'logistica' | 'antesdespues' | 'beneficios' | 'tabla' | 'autoridad' | 'testimonios' | 'modouso' | 'faq'
  imagenProductoUrl: string; // foto real subida por el usuario (imgSlot1/2/3) — acepta URL pública o data URI base64
  plantillaReferenciaUrl?: string; // YA NO SE USA para generar (ver nota de costo abajo) — se deja en la interfaz solo por compatibilidad con llamadas viejas, se ignora.
  plantillaDescripcion?: string; // descripción en texto del layout/composición de la plantilla elegida en la galería — reemplaza a la imagen de la plantilla como referencia
  templateId?: string; // id de la plantilla elegida en la galería — se guarda en el historial para poder mostrar de nuevo la "plantilla de referencia" al ver esta pieza, incluso después de recargar la página
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
  constructor(private readonly historialService: HistorialService) {}

  // Instancia de fal AISLADA para esta llamada puntual — nunca la global
  // "fal" (ver nota grande arriba del archivo).
  private clienteFal(apiKey: string): FalClient {
    return createFalClient({ credentials: apiKey });
  }

  async generarSeccion(input: GenerarSeccionInput): Promise<GenerarSeccionResultado> {
    if (!input.falApiKey) {
      throw new InternalServerErrorException('Todavía no conectaste tu clave de fal.ai. Andá a "Integraciones" y conectala primero.');
    }
    const falClient = this.clienteFal(input.falApiKey);
    const prompt = this.construirPrompt(input);
    const numImagenes = input.numImagenes ?? 1;

    try {
      // fal.ai rechaza (422 Unprocessable Entity) un data URI base64 puesto
      // directamente en image_urls: necesita una URL real ya alojada. Si el
      // taller nos manda la foto como base64 (data:image/...;base64,...), la
      // subimos primero al storage de fal.ai y usamos la URL que nos regresa.
      const imagenUrl = await this.resolverImagenUrl(falClient, input.imagenProductoUrl);

      // ---- Nota de costo (importante, no bajar la guardia aquí) ----
      // Antes se mandaba TAMBIÉN la miniatura de la plantilla elegida como
      // segunda imagen de referencia, para que el modelo copiara su
      // composición exacta. Se quitó a propósito: gpt-image-2/edit procesa
      // CADA imagen de referencia en alta fidelidad (input_fidelity fijo,
      // no configurable) — mandar 2 imágenes en vez de 1 cuesta más, y
      // además muchas plantillas del catálogo (personas con ropa ajustada,
      // torsos descubiertos, etc.) disparaban el filtro de contenido de
      // OpenAI aunque el texto fuera neutro. Ahora solo se manda la foto
      // real del producto como imagen de referencia; la composición de la
      // plantilla elegida se describe en TEXTO (input.plantillaDescripcion,
      // generada una sola vez por plantilla y cacheada en el frontend) y se
      // incorpora al prompt en construirPrompt() — el usuario sigue viendo
      // y eligiendo la plantilla igual que antes, solo cambió qué se le
      // manda a la IA para generar.
      const imageUrls = [imagenUrl];

      // IMPORTANTE: 'openai/gpt-image-2' (sin /edit) es solo texto->imagen y
      // NO acepta image_urls. Para editar/generar usando la foto real del
      // producto como referencia hay que usar la variante /edit.
      //
      // La palanca de costo que SÍ controlamos es 'quality' (por defecto
      // 'low', ~4x más barato que 'medium' y ~10x más barato que 'high').
      // 'high' queda disponible a futuro solo para una exportación final
      // puntual (pasando calidad:'high' desde el frontend), nunca como
      // default.
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
        const imagenesUrl = await this.llamarFal(falClient, imageUrls, prompt, numImagenes, calidad);
        return this.exito(imagenesUrl, prompt, calidad, numImagenes, input, imagenUrl);
      } catch (error) {
        // El filtro de contenido de OpenAI revisa TANTO el texto como la foto del
        // producto que le mandamos. Ya no mandamos la imagen de la plantilla (ver
        // nota arriba), así que si esto se dispara, es la foto del producto o el
        // texto de la ficha — no hay una segunda llamada más barata que intentar,
        // así que se avisa directo con un mensaje específico.
        if (this.esErrorDeContentChecker(error)) {
          throw new InternalServerErrorException(
            `La sección "${input.seccion}" quedó bloqueada por el filtro de contenido de OpenAI — la causa es la foto del producto o el texto de la ficha. Prueba con otra foto del producto (ej. en maniquí, empacado, o sin una persona puesta) y vuelve a intentar.`,
          );
        }
        if (this.esErrorDeClaveFalInvalida(error)) {
          throw new InternalServerErrorException(
            'fal.ai rechazó tu clave — revisá que la hayas pegado completa en "Integraciones" y que tengas créditos cargados en tu cuenta de fal.ai.',
          );
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      throw new InternalServerErrorException(
        'No se pudo generar la sección con GPT Image 2: ' + this.extraerDetalleError(error),
      );
    }
  }

  // Arma el resultado final y guarda el historial en PostgreSQL — sin bloquear
  // la respuesta al taller: si guardar el historial falla, no debe tumbar la
  // generación (el usuario ya tiene su imagen, eso es lo importante).
  private exito(
    imagenesUrl: string[],
    prompt: string,
    calidad: 'low' | 'medium' | 'high',
    numImagenes: number,
    input: GenerarSeccionInput,
    fotoProductoUrl: string,
  ): GenerarSeccionResultado {
    const costoEstimadoUsd = numImagenes * this.costoPorCalidad(calidad);
    this.historialService.guardar(input.usuarioId, {
      nombreProducto: input.ficha.nombreProducto,
      seccion: input.seccion,
      imagenUrl: imagenesUrl[0] || '',
      promptUsado: prompt,
      costoEstimadoUsd,
      fichaJson: input.ficha,
      // La foto del producto ya resuelta a una URL real de fal.storage (nunca el
      // data URI base64 crudo — eso sería enorme para guardar en cada fila). Sirve
      // para que el taller pueda mostrar esta foto de nuevo al reabrir el producto,
      // aunque sea desde otro navegador o después de recargar la página.
      fotoProductoUrl,
      // Igual con el id de la plantilla: sin esto, al recargar la página el taller
      // pierde de qué plantilla salió cada pieza y el bloque "Referencia" (la miniatura
      // de la plantilla original) del visor de una pieza queda vacío para siempre.
      templateId: input.templateId,
    });
    return { imagenesUrl, promptUsado: prompt, costoEstimadoUsd };
  }

  private async llamarFal(
    falClient: FalClient,
    imageUrls: string[],
    prompt: string,
    numImagenes: number,
    calidad: 'low' | 'medium' | 'high',
  ): Promise<string[]> {
    const resultado = await falClient.subscribe('openai/gpt-image-2/edit', {
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

  // Distingue un token/clave de fal.ai inválida (401/403 — el usuario pegó
  // mal la clave, o la borró/regeneró en su cuenta de fal.ai) de cualquier
  // otro error (moderación, tamaño de imagen, etc.), para poder darle al
  // usuario un mensaje que lo mande directo a revisar su conexión.
  private esErrorDeClaveFalInvalida(error: unknown): boolean {
    const status = (error as any)?.status;
    return status === 401 || status === 403;
  }

  /**
   * Si la imagen viene como data URI base64 (foto subida directamente en el
   * taller, sin backend propio de assets todavía), la sube al storage de
   * fal.ai (con la clave de ESE usuario) y devuelve la URL pública
   * resultante. Si ya es una URL normal (http/https), la deja tal cual.
   */
  private async resolverImagenUrl(falClient: FalClient, imagenProductoUrl: string): Promise<string> {
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
    return falClient.storage.upload(blob);
  }

  // Wrapper público del mismo helper de arriba — lo usa el endpoint
  // "subir-foto-producto" para guardar de una vez, al subir la foto (Imagen 1/2/3),
  // una URL real y persistente en fal.storage, en vez de guardar el data URI
  // base64 crudo (enorme) en la base de datos. Así el taller puede recordar la
  // foto del producto aunque el usuario nunca llegue a generar ninguna sección.
  // Recibe la clave de fal.ai de ese usuario — la sube con SU cuenta, no con
  // una compartida.
  async subirFotoProducto(dataUri: string, falApiKey: string): Promise<string> {
    if (!falApiKey) {
      throw new InternalServerErrorException('Todavía no conectaste tu clave de fal.ai. Andá a "Integraciones" y conectala primero.');
    }
    return this.resolverImagenUrl(this.clienteFal(falApiKey), dataUri);
  }

  private costoPorCalidad(calidad: 'low' | 'medium' | 'high'): number {
    // Precios de referencia para image_size 'portrait_16_9' (~1024x1536, el
    // vertical que usamos ahora), basados en la tabla de fal.ai por tamaño de
    // salida — NO incluyen el costo aparte de las imágenes de referencia que
    // se procesan en alta fidelidad (eso no lo publica fal.ai con un número
    // fijo). Desde que se dejó de mandar la plantilla como segunda imagen
    // (ahora solo se manda la foto del producto), el costo real por pieza
    // debería bajar frente a como estaba antes — hay que confirmar la cifra
    // real revisando el "Estimated spend" del dashboard de fal.ai después de
    // generar un lote, no solo confiar en este número de referencia.
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

    partes.push(
      `Se te da UNA imagen: el producto real que debes usar. Consérvalo exactamente igual (misma forma, color, materiales y proporciones, sin alterarlo ni reemplazarlo) e intégralo de forma natural en la composición que armes.`,
    );

    if (input.plantillaDescripcion) {
      partes.push(
        `No tienes la imagen de la plantilla de referencia que el usuario eligió como inspiración de diseño, pero aquí tienes su descripción de composición/layout — úsala como guía de cómo distribuir los elementos visuales de esta pieza (no es obligatorio copiarla al pixel, es una referencia de estructura): "${input.plantillaDescripcion}". Arma la composición final inspirado en esa estructura, pero con el producto real y el contenido de texto de esta sección — nunca copies frases ni marcas mencionadas en la descripción, solo la disposición visual.`,
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
    // escena resultante muestre una persona.
    if (f.personajes) {
      const p = f.personajes;
      const rasgos = [
        p.nacionalidad && p.nacionalidad !== 'Seleccionar...' ? `nacionalidad ${p.nacionalidad}` : null,
        p.sexo && p.sexo !== 'Seleccionar...' ? p.sexo.toLowerCase() : null,
        p.edadDesde && p.edadHasta ? `entre ${p.edadDesde} y ${p.edadHasta} años` : null,
      ].filter(Boolean);
      if (rasgos.length) {
        partes.push(
          `Si la escena incluye una persona, esa persona debe tener EXACTAMENTE estas características: ${rasgos.join(', ')}. Debe interactuar de forma natural con el producto. No uses una persona con características diferentes a las indicadas.`,
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
