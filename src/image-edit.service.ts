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
  // Pedido 07/09: se quitó el campo separado "Instrucciones adicionales" del taller —
  // cualquier instrucción puntual del usuario (precio, personaje, color, nombre exacto,
  // un prompt propio, etc.) ahora se escribe directamente en detallesProducto de arriba,
  // y construirPrompt() la manda completa a la IA como instrucción a seguir (ver abajo),
  // no solo como texto de referencia recortado. Un solo cuadro de texto en vez de dos.
  idioma?: string;                     // 🌐 Idioma de Salida — en qué idioma debe salir el texto de la imagen generada (por defecto 'Español')
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
        // Por defecto el modelo devuelve PNG (pesado, sin necesidad — estas
        // piezas son fotos/composiciones, no necesitan transparencia). Se pide
        // JPEG directo acá: el precio de fal.ai depende solo de calidad y
        // tamaño, NUNCA del formato de salida (confirmado en su
        // documentación), así que esto no cuesta nada extra y ya entrega el
        // archivo liviano desde el origen. Se eligió JPEG y no WebP a
        // propósito: la imagen se vuelve a subir después a Shopify, y Shopify
        // ya convierte automáticamente a WebP/AVIF las imágenes que aloja él
        // mismo — mandarle un WebP ya comprimido arriesga una doble
        // compresión si en algún momento tiene que derivar una versión de
        // respaldo para un navegador viejo (ver shopify.service.ts,
        // publicarLanding, para dónde termina alojada cada imagen).
        output_format: 'jpeg',
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
    // Se define acá afuera (no solo dentro del bloque de plantillaDescripcion
    // más abajo) para poder repetirla en el recordatorio de cierre — el
    // modelo pesa mucho lo último que lee, igual que ya se hace con el tipo
    // de sección.
    let tienePersonaEnPlantilla = false;

    // Pedido 09/09: el modelo de texto (text-generation.service.ts) ya se le presenta a la IA
    // como "experta en creación de landings de alta conversión para ecommerce" — al modelo de
    // IMAGEN nunca se le había dicho nada equivalente (gpt-image-2/edit no tiene un campo aparte
    // de system_prompt, así que esta frase va como la primera línea del prompt normal). Aplica a
    // TODAS las secciones/plantillas por igual.
    partes.push(
      `Eres un experto en diseño de imágenes publicitarias de alta conversión para landing pages de ecommerce.`,
    );

    // Directiva de apertura, deliberadamente lo primero que lee el modelo (después de la frase de
    // arriba): fija el TIPO de sección antes que cualquier otra instrucción (plantilla, ángulo
    // de venta, etc.) para evitar que el modelo "por defecto" arme un Hero/pieza
    // de venta genérica cuando en realidad se pidió otra sección (ej. Logística).
    partes.push(
      `Vas a generar EXCLUSIVAMENTE la sección "${etiquetaSeccion}" de una landing page. Todo el contenido, mensaje y composición deben corresponder a ESE tipo de sección — por ejemplo, si es Logística/Envío no generes un titular de venta tipo Hero, y si es Testimonios no generes una tabla de precios. No inventes la estructura de OTRA sección (ej. no agregues una grilla de tarjetas de beneficios si esto no es la sección de Beneficios). Las instrucciones específicas de esta sección, y la disposición exacta a seguir, están más abajo — seguilas a esas, no un formato genérico distinto.`,
    );

    // Pedido 07/09: el selector "🌐 Idioma de Salida" del taller le permite al estudiante armar
    // la landing para otro país/idioma (ej. Estados Unidos → English) — antes esto no llegaba a
    // la IA para nada, así que TODO el texto generado salía siempre en español sin importar lo
    // que el estudiante eligiera ahí. Se pone temprano en el prompt porque afecta a TODO el
    // texto que se genere en la imagen, no solo a una parte puntual.
    const idioma = (f.idioma || 'Español').trim() || 'Español';
    if (idioma.toLowerCase() !== 'español') {
      partes.push(
        `IMPORTANTE — Idioma: todo el texto que aparezca DENTRO de la imagen (titulares, subtítulos, botones, bullets, cualquier palabra) debe estar escrito en ${idioma}, no en español — el estudiante está armando esta landing para vender en un país donde se habla ${idioma}.`,
      );
    }

    partes.push(
      `Se te da UNA imagen: el producto real que debes usar. Consérvalo exactamente igual (misma forma, color, materiales y proporciones, sin alterarlo ni reemplazarlo) e intégralo de forma natural en la composición que armes.`,
    );

    // Pedido 07/09: Norbey reportó que en algunas piezas el producto salía con un tamaño poco
    // realista dentro de la escena (demasiado grande o demasiado chico en relación a lo que lo
    // rodea — una mano, una mesa, una persona, etc.), aunque la forma/color/proporciones DEL
    // PRODUCTO EN SÍ (la instrucción de arriba) sí se respetaban. Son dos cosas distintas: una
    // es "no cambies cómo se ve el producto" (ya cubierto arriba) y otra es "no cambies qué tan
    // grande se ve el producto EN LA ESCENA respecto a todo lo demás" — esta última no estaba
    // explícita, así que se agrega aparte.
    partes.push(
      `Además, mantén una escala realista y creíble del producto dentro de la escena: no lo agrandes ni lo achiques para que se vea más grande, más pequeño, más imponente o más humilde de lo que es en la vida real. Si en la composición aparece una mano, una persona, una mesa u otro objeto de referencia, el tamaño relativo del producto frente a ellos debe ser el mismo que tendría en la realidad.`,
    );

    // Norbey pidió (04/09) que la IA respete la plantilla de referencia con
    // mucha más fidelidad que antes: la posición de cada parte debe quedar
    // "casi igual" a la descrita, y si la plantilla muestra una persona, la
    // imagen generada NUNCA puede quedar sin persona (antes el prompt decía
    // "no es obligatorio copiarla al pixel", lo cual dejaba margen de sobra
    // para que el modelo reacomodara todo o directamente omitiera a la
    // persona — eso es justo lo que se reportó como fallando "uno que otro"
    // de cada 10 generaciones). Las 281 descripciones de plantillas (arriba,
    // PLANTILLA_DESCRIPCIONES en el frontend) ya venían con detalle de
    // posición por elemento (arriba/abajo/izquierda/derecha/centro) y ya
    // aclaran explícitamente cuando una plantilla NO tiene persona — el
    // problema no era la descripción en sí, sino que el prompt le daba al
    // modelo permiso de tomarla como sugerencia libre en vez de requisito.
    if (input.plantillaDescripcion) {
      const desc = input.plantillaDescripcion;
      // Si la propia descripción aclara explícitamente que esa plantilla NO
      // tiene persona (las 281 descripciones reales usan varias frases para
      // esto: "sin ninguna persona en esta plantilla", "No hay personas en
      // esta plantilla", "No aparecen personas...", "No hay fotografías de
      // personas...", "sin fotos de personas..."), eso manda por sobre
      // cualquier otra palabra suelta que pudiera parecer una mención de
      // persona. Verificado a mano contra las 281 descripciones reales
      // (04/09): con esta lista de patrones, 258 quedan marcadas con
      // persona, 20 marcadas explícitamente sin persona, y solo 3 quedan
      // ambiguas (colages de solo un brazo/bíceps en primer plano o una
      // tabla comparativa sin nadie) — para esas 3 no se agrega ninguna
      // instrucción extra de más, se sigue solo la descripción base.
      const sinPersonaExplicito =
        /\b(sin\s+(ninguna\s+)?personas?|no\s+hay\s+(fotos?\s+de\s+|fotograf[ií]as?\s+de\s+)?personas?|no\s+aparecen\s+personas?|ni\s+fotograf[ií]as?\s+de\s+personas?|sin\s+fotos?\s+de\s+personas?|sin\s+fotograf[ií]as?\s+de\s+personas?)\b/i.test(
          desc,
        );
      // Lista de palabras que indican una persona REAL fotografiada en la
      // escena (no solo un ícono decorativo tipo "persona corriendo" dentro
      // de un bullet de beneficio — esos son minoría y el costo de una falsa
      // alarma ahí es bajo comparado con el costo de omitir una persona que
      // sí debía estar). Incluye formas plurales (antes faltaban y hacían
      // que casos reales con "dos hombres"/"tres personas" pasaran
      // desapercibidos) y varios roles que aparecen en el catálogo además de
      // "hombre/mujer": pareja, ciclista, mensajero/a, boxeador/a, etc.
      const tienePersona =
        !sinPersonaExplicito &&
        /\b(hombres?|mujer(es)?|personas?|parejas?|modelos?|chicos?|chicas?|atletas?|entrenador(a|es|as)?|se[ñn]or(a|es|as)?|corredor(a|es|as)?|corriendo|ciclistas?|mensajer[oa]s?|boxeador(a|es|as)?|deportistas?|triatleta)\b/i.test(
          desc,
        );
      tienePersonaEnPlantilla = tienePersona;

      // Pedido 09/09: Norbey reportó que en varias generaciones aparecía dentro de la imagen una
      // palabra que no tenía nada que ver con el producto real (ej. "RENDIMIENTO" en un producto
      // que no es de rendimiento físico/deportivo). Causa raíz confirmada: las 281 descripciones
      // de plantillas (PLANTILLA_DESCRIPCIONES en el frontend) se redactaron describiendo casos
      // reales de ejemplo (varias usan de ejemplo un suplemento deportivo tipo "Creatina
      // Monohidratada"), y para poder describir la posición de cada elemento con precisión
      // incluyen, entre comillas, el texto EXACTO que aparecía ahí (titulares, bullets, nombres
      // de producto, sellos). La frase de abajo ya le pedía a la IA "no copiar frases textuales",
      // pero el modelo de imagen no sigue esa instrucción con el 100% de fidelidad (ver nota de
      // confiabilidad más abajo en este archivo) y a veces terminaba copiando alguna de esas
      // palabras de ejemplo tal cual — en un caso hasta apareció el nombre de un producto de
      // ejemplo casi idéntico al de otro cliente, pura coincidencia de rubro.
      //
      // En vez de confiar en que la IA "ignore" esas palabras, se las borra del prompt ANTES de
      // mandarlo — así físicamente no puede copiar lo que ya no está. neutralizarTextoLiteral()
      // reemplaza cada fragmento de texto literal (entre comillas simples, hasta 350 caracteres
      // para no arrastrar de más si alguna descripción tiene una comilla suelta) por un marcador
      // neutro "[texto]". Toda la información de POSICIÓN, TAMAÑO y JERARQUÍA —que va en el texto
      // alrededor de las comillas, no dentro de ellas— se conserva intacta. La detección de
      // persona de arriba sigue usando la descripción ORIGINAL (esas palabras nunca están dentro
      // de las comillas), así que no se ve afectada por este reemplazo.
      const descSinTextoLiteral = this.neutralizarTextoLiteral(desc);

      partes.push(
        `Tienes la descripción EXACTA de la composición/layout de la plantilla de referencia que el usuario eligió (no ves su imagen, pero esta descripción la reemplaza con el mismo nivel de detalle) — es un requisito de diseño a seguir con fidelidad, no una simple inspiración libre: "${descSinTextoLiteral}". Reproduce la distribución de los elementos en las MISMAS posiciones relativas que se describen (qué va arriba, abajo, a la izquierda, a la derecha o al centro, y en qué orden de tamaño/importancia visual), casi como si estuvieras calcando la estructura. Donde la descripción dice [texto] entre comillas, ahí NO hay ninguna palabra fija que debas reproducir — ese texto se quitó a propósito porque pertenecía a un producto de ejemplo distinto al de este pedido. En su lugar, generá ahí tu propio copy usando EXCLUSIVAMENTE el producto, el ángulo y los detalles reales de esta ficha (ver más abajo), manteniendo el mismo tipo de elemento (título, viñeta, sello, dato técnico, etc.) y la misma posición/tamaño relativo indicados. Usa el producto real que se te dio en vez de lo que diga la descripción sobre el producto — pero la UBICACIÓN de cada parte (títulos, íconos, bullets, producto, persona si la hay) debe coincidir lo más posible con la descripción. Nunca copies marcas ni nombres propios que hayan quedado mencionados fuera de las comillas, solo la disposición visual.`,
      );

      if (tienePersona) {
        partes.push(
          `IMPORTANTE: la plantilla de referencia SÍ muestra una persona en su composición (ver descripción de arriba). La imagen que generes DEBE incluir una persona — nunca generes la escena solo con el producto y el fondo, omitiendo a la persona. Ubícala en la misma posición y con una pose/actividad similar a la descrita.`,
        );
      } else if (sinPersonaExplicito) {
        partes.push(
          `La plantilla de referencia NO muestra ninguna persona, solo el producto y elementos gráficos/de texto — no agregues ninguna persona a la composición, mantenla enfocada exclusivamente en el producto.`,
        );
      }
    }

    // Pedido 09/09: Norbey reportó que en algunas generaciones el fondo salía oscuro (el color
    // de la plantilla de ejemplo) en vez del color real del producto — mientras que en otras de
    // la MISMA tanda sí se respetaba el color del producto. Causa probable: las descripciones de
    // plantilla (arriba) describen su propio color de fondo en palabras (ej. "Fondo azul oscuro
    // degradado...", "Fondo negro con rayos eléctricos...") — eso es texto estructural que SÍ se
    // conserva (no es el texto literal de marketing que neutralizarTextoLiteral() borra), así que
    // compite directamente contra esta instrucción de color y la IA no siempre resuelve ese
    // conflicto a favor de la correcta. Se aclara ahora explícitamente que este color tiene
    // prioridad sobre cualquier color de fondo mencionado en la plantilla de referencia.
    // Pedido 09/09 (cuarta vuelta): se probaron 3 versiones de esto y se testeó cada una contra
    // una foto REAL de producto (un bote sobre un escritorio de madera, con pared y una planta de
    // fondo — no es una foto de estudio con fondo blanco). Resultado del análisis pixel por pixel
    // contra esa foto real: el cálculo automático (extraerColoresDeImagen en el frontend), aunque
    // ya excluye el color del borde y agrupa tonos parecidos entre sí, TODAVÍA elige el color de
    // la madera del escritorio en vez del rojo del producto — porque en fotos "de la vida real"
    // el fondo casi siempre ocupa MÁS área total de la imagen que el producto, incluso la parte
    // del fondo que no toca el borde de la foto (la que se ve alrededor/detrás del producto). Es
    // una limitación real de "contar píxeles" contra "reconocer qué es el producto", no algo que
    // se arregle con otro ajuste al algoritmo.
    //
    // La vuelta anterior (tercera) le mandaba ese cálculo como una ORDEN de color fija — pero al
    // sacarle a la IA el margen para corregirlo con su propio criterio visual, cuando el cálculo
    // está mal (como en este caso) el resultado sale mal SIEMPRE, sin excepción. La vuelta de acá
    // atrás (segunda: pedirle a la IA que mire la foto y reconozca ella misma el producto) daba
    // mejor resultado en la práctica (la mayoría de las piezas salían con el color correcto). Se
    // vuelve a esa versión — y esta vez NO se le manda el colorHex calculado como referencia,
    // porque ya se demostró que puede estar mal para fotos con fondo real, y mencionárselo corría
    // el riesgo de desviar su propio criterio visual (que es más confiable que nuestro cálculo de
    // píxeles en estos casos).
    partes.push(
      `Para el color predominante del fondo y los acentos visuales de TODA la composición: mirá la imagen de referencia del producto que se te dio y fijate cuál es el color real del PRODUCTO en sí (su envase, etiqueta o empaque) — NUNCA el color de lo que lo rodea en esa foto (mesa, escritorio, pared, piso, planta, sombra, o cualquier otro elemento del entorno). Ese color del PRODUCTO tiene PRIORIDAD sobre cualquier color de fondo que mencione la descripción de la plantilla de referencia (si esa descripción dice, por ejemplo, "fondo azul oscuro" o "fondo negro", ignora ese color puntual: la plantilla se sigue solo para la POSICIÓN de los elementos, nunca para su color).`,
    );

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
            `Genera una sección de Oferta con estos precios exactos (divisa ${o.divisa || 'USD'}): ${filas.join(' · ')}.`,
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

    // Pedido 07/09: reemplaza al viejo campo separado "Instrucciones adicionales" (f.instrucciones,
    // ya eliminado del taller). Ahora detallesProducto ya se usa arriba en varias secciones, pero
    // SIEMPRE recortado a un fragmento corto (ver los "this.recortar(f.detallesProducto, ...)" de
    // cada case de arriba) — acá se manda una vez más, pero COMPLETO y como instrucción explícita a
    // seguir (no solo como texto de referencia), para que cualquier pedido puntual que el usuario
    // haya escrito ahí (un precio, un personaje, un color exacto, un prompt propio, etc.) no se
    // pierda por quedar recortado en las otras menciones.
    // Pedido 09/09: Norbey reportó una generación donde el modelo terminó armando una grilla de
    // tarjetas de beneficios completa (título + 4 íconos con texto) en vez de la sección Hero con
    // persona que se le pidió, aparentemente "inspirado" en el párrafo largo de detallesProducto
    // de abajo. Se agrega una aclaración explícita de que estos detalles son solo CONTENIDO/datos
    // a incorporar — nunca deben pisar el tipo de sección ni la disposición ya definidos arriba.
    if (f.detallesProducto) {
      partes.push(
        `Detalles adicionales del producto, escritos por el usuario (puede incluir pedidos puntuales para la imagen — un precio, un personaje, un color específico, el nombre exacto del producto, etc. — trátalo como una instrucción a seguir para el CONTENIDO): ${this.recortar(f.detallesProducto, 1200)}. Importante: estos detalles aportan información/contenido para usar DENTRO de la sección y la disposición ya indicadas arriba — nunca cambian el tipo de sección pedido, ni la disposición de sus elementos, ni si debe o no aparecer una persona.`,
      );
    }

    // Recordatorio de cierre en formato checklist (el modelo pesa mucho lo último que lee):
    // en vez de dos frases sueltas, se agrupan los puntos no negociables en una sola lista
    // corta y directa — más fácil de verificar por el modelo que dos párrafos separados. El
    // punto 4 (color) ahora es incondicional (antes solo aparecía si había colorHex) porque la
    // instrucción de color de arriba también es incondicional desde el pedido del 09/09. Vuelve a
    // decir "es el color real del producto" (no un hex fijo) porque volvimos a la cuarta vuelta:
    // que la IA lo reconozca ella misma en la foto, sin un cálculo nuestro de por medio.
    partes.push(
      `Antes de terminar, revisa estos puntos no negociables: 1) el resultado es una sección de "${etiquetaSeccion}" y de ningún otro tipo (no una portada/Hero de venta directa ni una grilla de Beneficios, salvo que el tipo pedido sea justamente ese); 2) la disposición de los elementos coincide con la plantilla de referencia descrita arriba, no es una composición libre; 3) ${tienePersonaEnPlantilla ? 'la imagen SÍ incluye una persona, en la posición descrita — nunca la omitas' : 'no agregaste ningún elemento que pertenezca a otro tipo de sección'}; 4) el color de fondo y acentos es el color real del PRODUCTO de la foto de referencia (su envase/etiqueta) — NO el color de lo que lo rodea en esa foto, ni el que haya descrito la plantilla de referencia.`,
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

  // Pedido 09/09 — ver el comentario grande en construirPrompt(), justo donde se usa esta
  // función, para el porqué completo. En corto: quita el texto literal (entre comillas simples)
  // que viene escrito dentro de las descripciones de plantilla, para que la IA de imagen no
  // pueda copiar palabras de un producto de ejemplo ajeno al pedido real.
  //
  // El límite de 350 caracteres por fragmento es a propósito: casi todo texto legítimo entre
  // comillas en estas descripciones (un titular, un bullet, un sello, un dato técnico) es corto.
  // Un puñado de las 281 descripciones (menos de 10) tiene una comilla suelta por un apóstrofe
  // suelto dentro del texto (ej. un número escrito "100'000", o una cita larga de testimonio que
  // termina con el nombre pegado fuera de la comilla) — sin este límite, esa comilla suelta haría
  // que la expresión regular agarre por error todo el texto ESTRUCTURAL (posiciones, tamaños,
  // jerarquía) hasta la siguiente comilla real, y ese texto sí es importante para mantener la
  // fidelidad de la plantilla. Con el límite, esos casos puntuales simplemente no se tocan (se
  // deja pasar ese fragmento sin filtrar) en vez de arriesgar borrar información real de layout.
  private neutralizarTextoLiteral(descripcion: string): string {
    return descripcion.replace(/'([^']{0,350})'/g, `'[texto]'`);
  }
}
