// importar-producto.service.ts
//
// Módulo "Product Marker" (pedido 16/09): el estudiante ve un producto en
// AliExpress/Amazon/Temu, una extensión de navegador saca de ahí el título,
// la descripción, las fotos y el precio, y se lo manda a este backend — este
// servicio arma la landing COMPLETA solo (ángulo, copy, imágenes de cada
// sección, precio sugerido) encadenando los mismos servicios que ya usa el
// taller paso a paso, pero de una sola vez, sin que el estudiante tenga que
// ir clic por clic. Al terminar, la landing queda GUARDADA y lista para que
// el estudiante entre a revisarla — nunca se publica sola a Shopify, eso
// sigue siendo un paso manual (ver ShopifyService).
//
// Decisiones de diseño (16/09, ver conversación con Norbey):
//  - Precio: como el precio de origen (AliExpress/Amazon/Temu) es el COSTO,
//    no el precio de venta, se le aplica un margen automático (MARKUP más
//    abajo) para sugerir un precio de venta — pero nunca se inventa un
//    precio "antes" tachado (comparación de precio falsa = tema delicado de
//    publicidad engañosa). El estudiante revisa/ajusta el precio sugerido
//    antes de publicar.
//  - Plantilla visual: NO se usa una plantilla de referencia puntual del
//    catálogo de 281 (esa lista vive solo en el frontend, no en este
//    backend) — cada sección se compone libremente según la ficha técnica.
//    El estudiante puede regenerar cualquier sección a mano después
//    eligiendo una plantilla, igual que con cualquier producto normal.
//  - Secciones automáticas: Hero, Beneficios, Oferta, Testimonios y FAQ — un
//    combo estándar que no depende de datos que el scraping no puede traer
//    (Logística necesita el país de venta del estudiante; Antes/Después y
//    Tabla Comparativa dependen más del criterio de cada uno). Se pueden
//    seguir agregando secciones a mano después, como cualquier producto.
//  - Fotos de origen: las fotos que trae el scraping son URLs externas del
//    sitio de origen (CDN de AliExpress/Amazon/Temu), que pueden tener
//    protección contra hotlinking o vencer con el tiempo. Antes de usarlas
//    para generar cualquier sección, se descargan UNA vez y se resuben al
//    storage de fal.ai (mismo mecanismo que ya usa resolverImagenUrl() en
//    ImageEditService para fotos base64) — así queda una copia propia y
//    estable, independiente del sitio de origen.
//
// Actualización 16/09 (mismo día, tras la primera prueba real): Norbey
// probó el v1 con un producto real y notó que la sección "Testimonios" no
// traía las reseñas reales del producto — tenía razón: el v1 original le
// pedía a la IA que INVENTARA 2-3 reseñas de la nada (misma lógica que usa
// el taller manual en modo "Plantilla" para testimonios). Eso no era lo que
// pidió desde el principio (mencionó explícitamente "los comentarios" al
// describir la idea completa). Fix: si la extensión trae reseñas reales
// (ver ResenaOrigen abajo — content-aliexpress.js las scrapea del JSON-LD o,
// si no hay, de heurísticas de DOM), la sección de Testimonios YA NO se
// genera con IA de imagen: se COMPONE de forma determinística con la
// librería "sharp" (instalar con: npm install sharp), pegando el texto
// REAL de cada reseña, su calificación real (si vino) y, si la reseña trae
// una foto adjunta real del comprador, esa foto TAL CUAL sin tocarla (decisión
// explícita de Norbey: prefiere la foto real del comprador antes que una
// generada por IA). Si una reseña puntual no trae foto, se usa un avatar
// genérico generado por IA (generarAvatarResena(), ya existente en
// ImageEditService, mismo mecanismo que usa el taller manual en modo
// Personalizada) — nunca se inventa una foto de comprador que no existe.
// Si NO llegan reseñas reales (ej. el scraper no las encontró en esa página
// puntual), se cae de vuelta al comportamiento viejo (IA inventa el texto)
// para que la landing igual quede completa.

import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { createFalClient, FalClient } from '@fal-ai/client';
// sharp se exporta con "export =" (estilo CommonJS clásico) — con
// "import sharp from 'sharp'" TypeScript trae el valor pero no el
// namespace de tipos (sharp.OverlayOptions, etc.), por eso se importa así.
import sharp = require('sharp');
import { ImageEditService, FichaTecnica } from './image-edit.service';
import { TextGenerationService } from './text-generation.service';
import { ProductosService } from './productos.service';
import { LandingsService, ItemLanding } from './landings.service';

export type PlataformaOrigen = 'aliexpress' | 'amazon' | 'temu';

// Una reseña real tal como la trae el scraper de la extensión — ver la nota
// grande de arriba del archivo ("Actualización 16/09").
export interface ResenaOrigen {
  texto: string;
  calificacion?: number; // 1 a 5 — si no viene, se muestran 5 estrellas por defecto
  autor?: string; // nombre/alias visible en la reseña de origen
  fotoUrl?: string; // foto que el comprador adjuntó a SU reseña (no su avatar de perfil) — URL externa del sitio de origen
}

export interface ImportarProductoInput {
  usuarioId: number;
  falApiKey: string;
  url: string;
  plataforma: PlataformaOrigen;
  titulo: string;
  descripcion: string;
  // URLs públicas de las fotos, tal cual las sacó la extensión de la página
  // de origen — se usa la primera como foto principal del producto.
  fotos: string[];
  // Precio del producto en el sitio de origen (el COSTO, no el de venta) —
  // si no viene, se arma la landing igual pero sin sección de Oferta.
  precioOriginal?: number;
  moneda?: string; // por defecto 'USD'
  // Reseñas reales scrapeadas de la página de origen (hasta 3, ver
  // content-aliexpress.js) — opcional: si no vienen, Testimonios se arma
  // igual que antes (inventado por IA a partir del resultado del producto).
  resenas?: ResenaOrigen[];
}

export interface ImportarProductoResultado {
  nombreProducto: string;
  anguloElegido: string;
  precioSugerido?: string;
  secciones: string[];
  costoEstimadoUsd: number;
  landingGuardada: boolean;
}

@Injectable()
export class ImportarProductoService {
  private readonly logger = new Logger(ImportarProductoService.name);

  // Margen aplicado sobre el precio de origen para sugerir un precio de
  // venta (3.5x es un margen típico de dropshipping para cubrir anuncios +
  // ganancia — fácil de ajustar acá si Norbey/su jefe prefieren otro número).
  private readonly MARKUP = 3.5;

  // Combo estándar de secciones para el piloto automático — ver nota grande
  // arriba del archivo sobre por qué estas 5 y no las 10 disponibles.
  // Orden (pedido explícito de Norbey 17/09): Testimonios va AL FINAL,
  // después de Preguntas Frecuentes — antes quedaba entre Oferta y FAQ.
  private readonly SECCIONES_AUTOMATICAS: string[] = ['hero', 'beneficios', 'oferta', 'faq', 'testimonios'];

  private readonly ETIQUETAS_SECCION: Record<string, string> = {
    hero: 'Hero (portada / titular principal)',
    beneficios: 'Beneficios',
    oferta: 'Oferta y Precios',
    testimonios: 'Testimonios',
    faq: 'Preguntas Frecuentes',
  };

  // Máximo de reseñas reales que se componen en la imagen de Testimonios —
  // decisión de Norbey (16/09): 3 alcanza y mantiene la imagen legible.
  private readonly MAX_RESENAS_REALES = 3;

  // Estimado de costo de generar UN avatar de respaldo por IA (mismo valor
  // que costoPorCalidad('low') en ImageEditService — se duplica acá porque
  // generarAvatarResena() no devuelve costo propio y no queremos modificar
  // ese método compartido con el taller manual solo por esto).
  private readonly COSTO_AVATAR_RESPALDO_USD = 0.018;

  constructor(
    private readonly textGenerationService: TextGenerationService,
    private readonly imageEditService: ImageEditService,
    private readonly productosService: ProductosService,
    private readonly landingsService: LandingsService,
  ) {}

  private clienteFal(apiKey: string): FalClient {
    return createFalClient({ credentials: apiKey });
  }

  // Ver nota grande arriba del archivo ("Fotos de origen") — descarga la
  // imagen desde el sitio de origen y la resube al storage de fal.ai, para
  // no depender de que ese CDN externo siga sirviendo esa URL más adelante.
  private async descargarYSubirAFal(falClient: FalClient, urlExterna: string): Promise<string> {
    const buffer = await this.descargarBytes(urlExterna, 'la foto del producto');
    return falClient.storage.upload(this.bufferABlob(buffer, 'image/jpeg'));
  }

  // Envuelve un Buffer de Node en un Blob de forma compatible con distintas
  // versiones de @types/node/TypeScript: en algunas, el tipo de Buffer
  // (Buffer<ArrayBufferLike>) no matchea exactamente el ArrayBufferView que
  // pide el constructor de Blob (pide ArrayBufferView<ArrayBuffer>, más
  // estricto). Copiarlo a un Uint8Array nuevo evita ese choque de tipos sin
  // cambiar el contenido de los bytes.
  private bufferABlob(buffer: Buffer, tipo: string): Blob {
    return new Blob([new Uint8Array(buffer)], { type: tipo });
  }

  // Descarga cruda de bytes desde una URL externa (sitio de origen) — la
  // usan tanto las fotos de producto (arriba) como las fotos reales de
  // reseñas (ver componerImagenTestimoniosReales). `etiqueta` es solo para
  // que el mensaje de error diga qué se estaba descargando.
  private async descargarBytes(urlExterna: string, etiqueta: string): Promise<Buffer> {
    let resp: Response;
    try {
      resp = await fetch(urlExterna);
    } catch {
      throw new InternalServerErrorException(
        `No se pudo descargar ${etiqueta} desde la página de origen — probá de nuevo.`,
      );
    }
    if (!resp.ok) {
      throw new InternalServerErrorException(
        `La página de origen no dejó descargar ${etiqueta} (código ${resp.status}).`,
      );
    }
    return Buffer.from(await resp.arrayBuffer());
  }

  private formatearPrecio(valor: number, moneda: string): string {
    const simbolo = moneda === 'USD' ? '$' : '';
    return `${simbolo}${valor.toFixed(2)}${simbolo ? '' : ` ${moneda}`}`;
  }

  // ---------------------------------------------------------------------
  // Composición determinística de la sección de Testimonios con reseñas
  // reales (ver nota grande "Actualización 16/09" arriba del archivo).
  // No usa IA de imagen: arma un JPEG con sharp pegando texto real + fotos
  // reales (o avatares de respaldo) — así el contenido nunca se "alucina".
  // ---------------------------------------------------------------------

  private escaparXml(texto: string): string {
    return String(texto)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // Corta el texto de la reseña en líneas de ancho parecido para que entre
  // prolijo dentro de la tarjeta — es un cálculo aproximado por cantidad de
  // caracteres (no mide el ancho real de cada letra), suficiente para este
  // tamaño de fuente/tarjeta. Si el texto es muy largo, se corta con "…" en
  // vez de desbordar la tarjeta.
  private envolverTexto(texto: string, maxCaracteresPorLinea: number, maxLineas: number): string[] {
    const palabras = texto.trim().split(/\s+/);
    const lineas: string[] = [];
    let actual = '';
    for (const palabra of palabras) {
      const propuesta = actual ? `${actual} ${palabra}` : palabra;
      if (propuesta.length > maxCaracteresPorLinea) {
        if (actual) lineas.push(actual);
        actual = palabra;
      } else {
        actual = propuesta;
      }
      if (lineas.length >= maxLineas) break;
    }
    if (actual && lineas.length < maxLineas) lineas.push(actual);
    if (lineas.length === maxLineas) {
      const ultima = lineas[maxLineas - 1];
      const seCortoAlgo =
        lineas.join(' ').length < texto.trim().length && lineas.reduce((acc, l) => acc + l.length, 0) < texto.length;
      if (seCortoAlgo) lineas[maxLineas - 1] = ultima.replace(/[.,;:]?$/, '') + '…';
    }
    return lineas;
  }

  private estrellas(calificacion?: number): string {
    const n = Math.max(0, Math.min(5, Math.round(calificacion ?? 5)));
    return '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
  }

  // Descarga la foto real adjunta a la reseña y la recorta en círculo. Si
  // falla la descarga (URL vencida, hotlink bloqueado, etc.) o la reseña no
  // trae foto, cae a un avatar genérico generado por IA (generarAvatarResena,
  // el mismo mecanismo que usa el taller manual en modo Personalizada) — y
  // si hasta ESO falla, cae a un círculo de color liso para que la landing
  // no se caiga completa por una sola foto de reseña problemática.
  private async avatarCircularParaResena(
    falApiKey: string,
    resena: ResenaOrigen,
    tamano: number,
  ): Promise<{ buffer: Buffer; costoEstimadoUsd: number; esFotoReal: boolean }> {
    const mascara = Buffer.from(
      `<svg width="${tamano}" height="${tamano}"><circle cx="${tamano / 2}" cy="${tamano / 2}" r="${tamano / 2}" fill="#fff"/></svg>`,
    );

    if (resena.fotoUrl) {
      try {
        const bytes = await this.descargarBytes(resena.fotoUrl, 'la foto de una reseña');
        const redondo = await sharp(bytes)
          .resize(tamano, tamano, { fit: 'cover' })
          .composite([{ input: mascara, blend: 'dest-in' }])
          .png()
          .toBuffer();
        return { buffer: redondo, costoEstimadoUsd: 0, esFotoReal: true };
      } catch (error) {
        this.logger.warn(`No se pudo usar la foto real de una reseña, se cae a avatar genérico: ${(error as Error).message}`);
      }
    }

    try {
      const { avatarUrl } = await this.imageEditService.generarAvatarResena({ falApiKey });
      const bytes = await this.descargarBytes(avatarUrl, 'el avatar generado para una reseña');
      const redondo = await sharp(bytes)
        .resize(tamano, tamano, { fit: 'cover' })
        .composite([{ input: mascara, blend: 'dest-in' }])
        .png()
        .toBuffer();
      return { buffer: redondo, costoEstimadoUsd: this.COSTO_AVATAR_RESPALDO_USD, esFotoReal: false };
    } catch (error) {
      this.logger.warn(`No se pudo generar un avatar de respaldo para una reseña, se usa un círculo liso: ${(error as Error).message}`);
      const liso = await sharp({ create: { width: tamano, height: tamano, channels: 3, background: { r: 210, g: 205, b: 198 } } })
        .composite([{ input: mascara, blend: 'dest-in' }])
        .png()
        .toBuffer();
      return { buffer: liso, costoEstimadoUsd: 0, esFotoReal: false };
    }
  }

  // Arma el JPEG final con hasta MAX_RESENAS_REALES tarjetas de reseña
  // apiladas verticalmente, cada una con foto (real o de respaldo),
  // nombre, estrellas y el texto REAL de la reseña.
  private async componerImagenTestimoniosReales(
    falApiKey: string,
    nombreProducto: string,
    resenas: ResenaOrigen[],
  ): Promise<{ buffer: Buffer; costoEstimadoUsd: number }> {
    // El filtrado a "solo positivas" (>= 4 estrellas) ya se hizo antes de
    // llegar acá (ver pilotoAutomatico → resenasReales) — acá solo se
    // recorta a la cantidad máxima a mostrar en la imagen.
    const usadas = resenas
      .filter((r) => r.texto && r.texto.trim().length > 0)
      .slice(0, this.MAX_RESENAS_REALES);

    const ANCHO = 1024;
    const ALTO_HEADER = 190;
    const ESPACIO = 24;
    const MARGEN_INFERIOR = 40;
    // Alto de tarjeta MÍNIMO fijo (nombre + estrellas + avatar) + un extra
    // por cada línea de más que ocupe el texto de la reseña — antes esto
    // era un alto fijo de 420px para todas las tarjetas, lo que dejaba un
    // hueco enorme en blanco debajo de reseñas cortas (reportado 16/09 por
    // Norbey: "el texto no se veía" en la vista previa chica del teléfono —
    // en realidad SÍ estaba, solo que perdido en todo ese espacio vacío).
    const ALTO_TARJETA_BASE = 250;
    const ALTO_POR_LINEA_EXTRA = 36;
    const PADDING_INFERIOR_TARJETA = 40;

    const TAMANO_AVATAR = 120;
    let costoEstimadoUsd = 0;
    const capas: sharp.OverlayOptions[] = [];

    // Primera pasada: envuelve el texto de cada reseña y calcula el alto que
    // le corresponde a su tarjeta según cuántas líneas ocupe.
    const tarjetas = usadas.map((resena) => {
      const lineasTexto = this.envolverTexto(resena.texto, 44, 6);
      const altoTarjeta =
        ALTO_TARJETA_BASE + Math.max(0, lineasTexto.length - 1) * ALTO_POR_LINEA_EXTRA + PADDING_INFERIOR_TARJETA;
      return { resena, lineasTexto, altoTarjeta };
    });

    const ALTO =
      ALTO_HEADER +
      tarjetas.reduce((acc, t) => acc + t.altoTarjeta, 0) +
      Math.max(0, tarjetas.length - 1) * ESPACIO +
      MARGEN_INFERIOR;

    let yTarjeta = ALTO_HEADER;
    for (const { resena, lineasTexto, altoTarjeta } of tarjetas) {
      const nombreMostrado = resena.autor?.trim() || `Comprador verificado`;
      const tspans = lineasTexto
        .map((linea, idx) => `<tspan x="64" dy="${idx === 0 ? 0 : 36}">${this.escaparXml(linea)}</tspan>`)
        .join('');

      const tarjetaSvg = Buffer.from(`<svg width="${ANCHO}" height="${altoTarjeta}">
        <rect x="20" y="0" width="${ANCHO - 40}" height="${altoTarjeta - 20}" rx="28" fill="#ffffff" stroke="#ece6dc" stroke-width="2"/>
        <text x="184" y="70" font-size="30" font-family="Arial, sans-serif" font-weight="bold" fill="#232323">${this.escaparXml(nombreMostrado)}</text>
        <text x="184" y="108" font-size="30" fill="#f5a623">${this.estrellas(resena.calificacion)}</text>
        <text font-size="26" font-family="Arial, sans-serif" fill="#3d3d3d" y="168">${tspans}</text>
      </svg>`);

      const { buffer: avatarBuffer, costoEstimadoUsd: costoAvatar } = await this.avatarCircularParaResena(
        falApiKey,
        resena,
        TAMANO_AVATAR,
      );
      costoEstimadoUsd += costoAvatar;

      capas.push({ input: tarjetaSvg, left: 0, top: yTarjeta });
      capas.push({ input: avatarBuffer, left: 44, top: yTarjeta + 34 });
      yTarjeta += altoTarjeta + ESPACIO;
    }

    const encabezadoSvg = Buffer.from(`<svg width="${ANCHO}" height="${ALTO_HEADER}">
      <text x="${ANCHO / 2}" y="90" font-size="46" font-family="Arial, sans-serif" font-weight="bold" fill="#232323" text-anchor="middle">Lo que dicen nuestros clientes</text>
      <text x="${ANCHO / 2}" y="140" font-size="26" font-family="Arial, sans-serif" fill="#6b6b6b" text-anchor="middle">${this.escaparXml(`Reseñas reales de ${nombreProducto}`.slice(0, 70))}</text>
    </svg>`);

    const fondo = sharp({ create: { width: ANCHO, height: ALTO, channels: 3, background: { r: 250, g: 247, b: 242 } } });
    const resultado = await fondo
      .composite([{ input: encabezadoSvg, left: 0, top: 0 }, ...capas])
      .jpeg({ quality: 90 })
      .toBuffer();

    return { buffer: resultado, costoEstimadoUsd };
  }

  async pilotoAutomatico(usuarioId: number, falApiKey: string, input: ImportarProductoInput): Promise<ImportarProductoResultado> {
    const nombreProducto = String(input.titulo || '').trim().slice(0, 200);
    if (!nombreProducto) {
      throw new InternalServerErrorException('El producto importado no trae título.');
    }
    const detallesProducto = String(input.descripcion || '').trim() || `Producto importado desde ${input.plataforma}: ${input.url}`;
    const fotosOrigen = (input.fotos || []).filter((f) => !!f);
    if (fotosOrigen.length === 0) {
      throw new InternalServerErrorException('El producto importado no trae ninguna foto.');
    }
    // Reseñas reales tal como las trajo el scraper — ver ResenaOrigen arriba.
    // Si el sitio de origen no tenía reseñas visibles en el momento de
    // scrapear, esto llega vacío y Testimonios se arma como antes (con IA).
    // Pedido de Norbey (16/09): la landing debe mostrar solo reseñas
    // POSITIVAS — se descartan las que sí trajeron una calificación
    // detectada y es menor a 4 estrellas (si no se pudo detectar la
    // calificación, se deja pasar: mejor mostrarla sin la estrellita exacta
    // que perder una reseña real válida por un dato que no se pudo leer).
    // Se ordenan las de 5 estrellas primero. Si después de filtrar no queda
    // NINGUNA, resenasReales queda vacío y Testimonios cae al comportamiento
    // viejo (inventado por IA) más abajo — nunca se genera una imagen con 0
    // reseñas.
    const resenasReales = (input.resenas || [])
      .filter((r) => r && r.texto && r.texto.trim().length > 5)
      .filter((r) => r.calificacion === undefined || r.calificacion >= 4)
      .sort((a, b) => (b.calificacion ?? 4) - (a.calificacion ?? 4));

    const falClient = this.clienteFal(falApiKey);

    // 1) Foto principal: se descarga y resube UNA sola vez, se reutiliza para
    // todas las secciones (mismo patrón que el taller manual, que usa la
    // misma foto de "Imagen 1" para todas las secciones que genera).
    const fotoPrincipalUrl = await this.descargarYSubirAFal(falClient, fotosOrigen[0]);

    // 2) Ángulo de venta: se generan 3 y se elige el primero automáticamente
    // (en el taller manual esto lo elige el estudiante a mano).
    const { angulos } = await this.textGenerationService.generarAngulos({
      nombreProducto,
      detallesProducto,
      falApiKey,
    });
    const anguloElegido = angulos[0] || nombreProducto;

    // 3) Copy completo (problema/avatar/resultado/solución/mecanismo) en base a ese ángulo.
    const copy = await this.textGenerationService.generarCopy({
      nombreProducto,
      detallesProducto,
      anguloElegido,
      falApiKey,
    });

    // 4) Precio sugerido — ver nota grande arriba del archivo sobre el margen y por qué
    // nunca se inventa un precio "antes" tachado.
    const moneda = input.moneda || 'USD';
    const precioVenta = input.precioOriginal ? Math.round(input.precioOriginal * this.MARKUP * 100) / 100 : undefined;
    const precioSugerido = precioVenta !== undefined ? this.formatearPrecio(precioVenta, moneda) : undefined;

    const ficha: FichaTecnica = {
      nombreProducto,
      detallesProducto,
      anguloNombre: anguloElegido,
      angulo: anguloElegido,
      problema: copy.problema,
      avatar: copy.avatar,
      resultado: copy.resultado,
      solucion: copy.solucion,
      mecanismo: copy.mecanismo,
      idioma: 'Español',
      oferta: precioSugerido ? { precio1Venta: precioSugerido, divisa: moneda } : undefined,
    };

    // 5) Genera cada sección del combo automático, en orden, reutilizando la
    // misma foto principal ya resuelta — cada llamada ya guarda su propio
    // historial (ver ImageEditService.generarSeccion → historialService.guardar()).
    const items: ItemLanding[] = [];
    let costoEstimadoUsd = 0;
    const seccionesOk: string[] = [];

    for (const seccion of this.SECCIONES_AUTOMATICAS) {
      try {
        // Testimonios con reseñas reales: se compone con sharp (ver nota
        // grande "Actualización 16/09"), NO se le pide a la IA de imagen
        // que invente el contenido — así el texto y (si vino) la foto de
        // cada reseña son exactamente los reales del producto.
        if (seccion === 'testimonios' && resenasReales.length > 0) {
          const { buffer, costoEstimadoUsd: costoTestimonios } = await this.componerImagenTestimoniosReales(
            falApiKey,
            nombreProducto,
            resenasReales,
          );
          costoEstimadoUsd += costoTestimonios;
          const imagenUrl = await falClient.storage.upload(this.bufferABlob(buffer, 'image/jpeg'));
          seccionesOk.push(seccion);
          items.push({
            id: `${seccion}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            image: imagenUrl,
            sectionKey: seccion,
            sectionLabel: this.ETIQUETAS_SECCION[seccion] || seccion,
            templateId: null,
          });
          // OJO: ya no se intercala un botón acá — Testimonios ahora es
          // siempre la ÚLTIMA sección del combo automático (ver
          // SECCIONES_AUTOMATICAS arriba), así que el botón final que se
          // agrega más abajo (después de este for) ya queda justo debajo,
          // sin repetirlo dos veces seguidas.
          continue;
        }

        const resultado = await this.imageEditService.generarSeccion({
          usuarioId,
          falApiKey,
          seccion,
          imagenProductoUrl: fotoPrincipalUrl,
          ficha,
          numImagenes: 1,
          calidad: 'low',
        });
        costoEstimadoUsd += resultado.costoEstimadoUsd;
        seccionesOk.push(seccion);
        items.push({
          id: `${seccion}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          image: resultado.imagenesUrl[0],
          sectionKey: seccion,
          sectionLabel: this.ETIQUETAS_SECCION[seccion] || seccion,
          templateId: null,
        });
        // Después de la sección de Oferta se intercala un botón de comprar —
        // mismo criterio que ya usa el taller manual (ver realInsertarBotonComprar
        // en el frontend), para que la landing arme un flujo de venta natural.
        if (seccion === 'oferta') {
          items.push({ id: `boton-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, tipo: 'boton_comprar' });
        }
      } catch (error) {
        // Si UNA sección falla (ej. filtro de contenido de OpenAI), no se
        // tumba todo el piloto automático — se sigue con el resto y se avisa
        // al final cuáles quedaron sin generar, para que el estudiante las
        // arme a mano desde el taller como haría con cualquier otra pieza.
        this.logger.warn(`Piloto automático: la sección "${seccion}" de "${nombreProducto}" falló — ${(error as Error).message}`);
      }
    }

    if (items.length === 0) {
      throw new InternalServerErrorException(
        'No se pudo generar ninguna sección de la landing — probá de nuevo o armala a mano desde el taller con esta misma foto.',
      );
    }

    // Botón de comprar al final de la secuencia, además del intercalado tras
    // la Oferta (si se generó) — asegura que la landing siempre cierre con
    // una llamada a la acción, incluso si Oferta falló.
    items.push({ id: `boton-final-${Date.now()}`, tipo: 'boton_comprar' });

    // 6) Guarda la foto principal como "Imagen 1" del producto — así, al
    // abrir este producto en el taller, la foto ya aparece cargada en el
    // slot como si el estudiante la hubiera subido a mano.
    await this.productosService.guardarFotos(usuarioId, nombreProducto, [fotoPrincipalUrl, null, null]);

    // 7) Ensambla y guarda la landing (num=1 — primera landing de este
    // producto recién importado) con botón flotante activado por defecto
    // (barato y ya construido, ver v89 en la memoria del proyecto).
    const landingGuardada = await this.landingsService.guardar(usuarioId, {
      nombreProducto,
      num: 1,
      items,
      botonFlotante: true,
    });

    this.logger.log(
      `Piloto automático: "${nombreProducto}" importado desde ${input.plataforma} — ${seccionesOk.length}/${this.SECCIONES_AUTOMATICAS.length} secciones generadas (testimonios ${resenasReales.length > 0 ? 'con reseñas reales' : 'inventados por IA, no se encontraron reseñas'}), costo estimado $${costoEstimadoUsd.toFixed(3)}.`,
    );

    return {
      nombreProducto,
      anguloElegido,
      precioSugerido,
      secciones: seccionesOk,
      costoEstimadoUsd,
      landingGuardada: !!landingGuardada,
    };
  }
}
