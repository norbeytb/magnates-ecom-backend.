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
import { randomUUID } from 'crypto';
import { createFalClient, FalClient } from '@fal-ai/client';
// sharp se exporta con "export =" (estilo CommonJS clásico) — con
// "import sharp from 'sharp'" TypeScript trae el valor pero no el
// namespace de tipos (sharp.OverlayOptions, etc.), por eso se importa así.
import sharp = require('sharp');
// opentype.js: convierte texto en dibujos vectoriales (paths) usando una
// fuente que traemos NOSOTROS (ver fuentes-liberation.ts) en vez de pedirle
// al sistema operativo del servidor que dibuje el texto con SU fuente — ver
// la nota grande "Actualización 17/09 (fuentes)" más abajo para el porqué.
import opentype = require('opentype.js');
// cheerio: parser de HTML tipo jQuery, sin necesidad de navegador — lo usa
// scrapearResenasAmazonDeHtml() (18/09 (5)) para leer el árbol de reseñas
// del HTML de Amazon (mucho más confiable que regex a mano sobre HTML
// anidado). Instalar con: npm install cheerio.
import * as cheerio from 'cheerio';
// puppeteer: navegador headless de verdad — lo usa
// scrapearResenasTemuConNavegador() (18/09 (6)) porque Temu, a diferencia
// de AliExpress/Amazon, arma su lista de reseñas con JavaScript y no tiene
// (que se haya encontrado) un endpoint público equivalente. Instalar con:
// npm install puppeteer — ver nixpacks.toml para las librerías de sistema
// que Railway necesita para poder correr un Chromium de verdad.
import puppeteer, { Browser } from 'puppeteer';
import { ImageEditService, FichaTecnica } from './image-edit.service';
import { TextGenerationService } from './text-generation.service';
import { ProductosService } from './productos.service';
import { LandingsService, ItemLanding } from './landings.service';
import { LIBERATION_SANS_REGULAR_BASE64, LIBERATION_SANS_BOLD_BASE64 } from './fuentes-liberation';

// Declaraciones mínimas para poder tipar el código que corre DENTRO del
// navegador headless (page.evaluate en leerHtmlRenderizadoConNavegador, más
// abajo) sin necesitar agregar la librería "dom" al tsconfig de este
// backend (que es un proyecto de servidor, sin DOM real — agregarla ahí
// solo por esto sería un cambio de configuración de más). "any" a
// propósito: ese código nunca se type-chequea contra el DOM real, solo
// necesita poder compilar.
declare const document: any;
declare const window: any;
declare const navigator: any;

export type PlataformaOrigen = 'aliexpress' | 'amazon' | 'temu';

// Una reseña real tal como la trae el scraper de la extensión — ver la nota
// grande de arriba del archivo ("Actualización 16/09").
export interface ResenaOrigen {
  texto: string;
  calificacion?: number; // 1 a 5 — si no viene, se muestran 5 estrellas por defecto
  autor?: string; // nombre/alias visible en la reseña de origen ("Anónimo" si el comprador no puso nombre)
  // Fotos que el comprador adjuntó a SU reseña (no su avatar de perfil, casi
  // siempre son fotos del producto recibido) — URLs externas del sitio de
  // origen. fotoUrl queda por compatibilidad con la extensión (que solo
  // manda una) — si viene, se trata como la primera de "fotos". Pedido
  // 18/09: estas fotos se muestran DEBAJO del texto de la reseña, nunca como
  // avatar (ver componerImagenTestimoniosReales).
  fotoUrl?: string;
  fotos?: string[];
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
  // Reseñas reales scrapeadas de la página de origen — por la extensión
  // (content-aliexpress.js) o por scrapearResenasAliExpressPorLink() más
  // abajo (módulo Product Marker del taller) — opcional: si no vienen,
  // Testimonios se arma igual que antes (inventado por IA a partir del
  // resultado del producto). Se muestran hasta MAX_RESENAS_REALES.
  resenas?: ResenaOrigen[];
  // Pedido 18/09 (módulo "Product Marker" del taller): el estudiante puede
  // completar a mano el precio de venta y de comparación de cada combo (1/2/3
  // unidades) ANTES de generar, en vez de depender solo del margen automático
  // (ver MARKUP más abajo). Si no viene precio1Venta, se ignora todo esto y
  // sigue el comportamiento de siempre (precio sugerido automático, sin
  // comparación, sin combos de 2/3 unidades).
  ofertaManual?: {
    precio1Venta?: string; precio1Comparacion?: string;
    precio2Venta?: string; precio2Comparacion?: string;
    precio3Venta?: string; precio3Comparacion?: string;
  };
}

export interface ImportarProductoResultado {
  nombreProducto: string;
  anguloElegido: string;
  precioSugerido?: string;
  secciones: string[];
  costoEstimadoUsd: number;
  landingGuardada: boolean;
}

// ---------------------------------------------------------------------
// Módulo "Product Marker" DENTRO del taller (pedido 17/09): Norbey ya no
// quiere que dependa de una extensión de navegador — el estudiante pega el
// link directo en la web de la Creadora de Landing, sin instalar nada. Acá
// el que lee la página es el PROPIO SERVIDOR (scrapearUrlProducto más
// abajo), no un content script en el navegador del estudiante como antes.
//
// Dos diferencias importantes con el camino de la extensión, avisadas a
// Norbey de antemano:
//  1) Reseñas reales: NO se pueden sacar así. En AliExpress (y la mayoría
//     de tiendas) los comentarios se cargan con JavaScript después de que
//     el servidor ya respondió — acá solo tenemos el HTML crudo tal cual lo
//     manda el sitio de origen, antes de que un navegador ejecute nada de
//     JS. Por eso las landings armadas por este camino van a caer siempre
//     al comportamiento de Testimonios inventado por IA (ver pilotoAutomatico
//     más abajo, resenasReales sale vacío).
//  2) Puede que algunos sitios bloqueen o devuelvan una versión reducida de
//     la página a un pedido "simple" del servidor (sin ejecutar JS, sin las
//     cookies/comportamiento de un navegador real) — se empezó por la
//     versión más simple (pedido directo + JSON-LD/meta og:, el mismo
//     truco que ya usa content-aliexpress.js) a propósito, decisión de
//     Norbey de "empezar simple" y escalar a un navegador headless o un
//     servicio de scraping de pago más adelante SI hace falta, en vez de
//     construir esa complejidad de entrada sin haber confirmado que no
//     alcanza con lo simple.
//
// Es asíncrono a propósito (pedido explícito de Norbey: que la landing se
// siga armando en el servidor aunque el estudiante cierre la pestaña o
// navegue a otro lado, mientras el taller le muestra una barra de progreso
// si se queda mirando). El estado de cada importación se guarda en un Map
// EN MEMORIA (no en la base de datos) — sencillo a propósito para la
// primera versión; la única contra es que si Railway reinicia el servidor
// justo en medio de una importación en curso, ese trabajo puntual se
// pierde (el estudiante tendría que pegar el link de nuevo). Si esto
// resulta ser un problema real en la práctica, se puede mover a una tabla
// de Postgres más adelante, mismo patrón que "historial"/"generaciones".
// Pedido 18/09: antes de generar, si se encontraron reseñas reales, el
// trabajo se PAUSA en 'revisando_resenas' — el taller le muestra al
// estudiante exactamente las reseñas que se van a usar (algunas "Anónimo",
// otras con nombre real) para que pueda cambiarle el nombre a las anónimas
// antes de seguir. Si no hay ninguna reseña real, este paso se salta
// directo a 'generando_secciones' (nada que revisar).
export type EstadoImportacionPorLinkTipo =
  | 'leyendo_pagina'
  | 'revisando_resenas'
  | 'generando_secciones'
  | 'listo'
  | 'error';

// Una reseña real tal como se le muestra al estudiante para revisar/editar
// ANTES de generar — ver EstadoImportacionPorLink.resenasParaRevisar.
export interface ResenaParaRevisar {
  autor: string; // "Anónimo" si no vino nombre real de la página de origen
  esAnonimo: boolean;
  calificacion?: number;
  texto: string;
  fotos: string[];
}

export interface EstadoImportacionPorLink {
  id: string;
  estado: EstadoImportacionPorLinkTipo;
  error?: string;
  resultado?: ImportarProductoResultado;
  // Solo presente en estado 'revisando_resenas' — mismo orden en que hay
  // que mandar de vuelta los nombres editados a confirmarResenasYGenerar().
  resenasParaRevisar?: ResenaParaRevisar[];
}

// Overrides opcionales del formulario de Product Marker (pedido 18/09) —
// título propio y/o precios de los 3 combos, ver ImportarProductoInput.ofertaManual.
export interface ImportarPorLinkOpciones {
  tituloPersonalizado?: string;
  ofertaManual?: ImportarProductoInput['ofertaManual'];
}

// Plataformas soportadas para "pegá el link" (mismo criterio ya elegido
// para la extensión — Norbey prefirió tiendas conocidas en vez de
// cualquier página de internet: fuera de una tienda que ya conocemos a
// fondo ni el precio/fotos salen confiables).
//
// Actualización 18/09 (2): se suman Amazon y Temu — mismo mecanismo que
// AliExpress (scrapearUrlProducto ya es genérico: JSON-LD Product > meta
// og:*, no tiene nada específico de AliExpress adentro), solo hacía falta
// reconocer sus links acá.
//
// Actualización 18/09 (5) — "quiero que las reseñas sean igual que con
// amazon y temu": reseñas reales por link, estado por tienda:
//  - AliExpress: ya tenía su endpoint aparte (scrapearResenasAliExpressPorLink).
//  - Amazon: RESUELTO — Amazon trae sus reseñas ya escritas en el mismo
//    HTML que responde el servidor (por SEO, no hace falta JS para verlas),
//    así que scrapearResenasAmazonDeHtml() las lee del mismo html que ya
//    bajó scrapearUrlProducto(), sin pedir la página una segunda vez. Ver
//    esa función más abajo para el detalle de qué marcado usa y por qué es
//    "mejor esfuerzo" igual que AliExpress (Amazon puede cambiar su HTML).
//  - Temu: EXPERIMENTAL (18/09 (6)) — se investigó y, a diferencia de
//    Amazon, la página de Temu es una SPA que arma todo por JavaScript
//    (título/precio salen igual porque van en meta og:/JSON-LD para
//    compartir en redes, pero la lista de reseñas no) — no se encontró un
//    endpoint público equivalente al de AliExpress. Norbey eligió sumar un
//    navegador headless (Puppeteer) solo para esta plataforma en vez de
//    dejarlo con IA — ver scrapearResenasTemuConNavegador() más abajo para
//    el aviso completo: sus selectores son una heurística SIN verificar
//    contra el sitio real (temu.com está bloqueado desde este entorno), así
//    que es esperable necesitar un round de ajuste con un caso real.
//  - Amazon, aparte, es conocido por bloquear pedidos simples de servidor
//    más agresivo que AliExpress (puede devolver una página de
//    verificación "no sos un robot" en vez del producto) — el pedido ya
//    manda headers de navegador real (ver scrapearUrlProducto), pero si en
//    la práctica falla seguido, la solución sería lo mismo: escalar a un
//    navegador headless (Norbey ya sabe que esto se dejó pendiente a
//    propósito por "empezar simple", ver nota grande arriba del archivo).
const PATRONES_PLATAFORMA_SOPORTADA: { regex: RegExp; plataforma: PlataformaOrigen }[] = [
  { regex: /^https:\/\/([a-z]{2,3}\.)?aliexpress\.com\/item\//i, plataforma: 'aliexpress' },
  // Amazon: /dp/ASIN, con o sin el título de SEO adelante (.../nombre-producto/dp/ASIN),
  // y /gp/product/ASIN — cubre .com y los dominios de país (.com.mx, .es, .com.br, etc.)
  // con un grupo de TLD flexible en vez de listarlos todos a mano.
  // Fix 19/09: Amazon a veces mete un prefijo de idioma antes del nombre del
  // producto (ej. "/-/es/..." cuando ves la página en español) — eso son DOS
  // segmentos de texto antes de "dp/", no uno solo, y el patrón viejo lo
  // rechazaba. Ahora acepta cualquier cantidad de segmentos antes de "dp/".
  { regex: /^https:\/\/(?:www\.)?amazon\.[a-z.]{2,8}\/(?:[^/?#]+\/)*(?:dp|gp\/product)\/[A-Z0-9]{10}(?:[/?]|$)/i, plataforma: 'amazon' },
  // Link corto de compartir de Amazon (amzn.to/xxxxx) — fetch() sigue la
  // redirección solo, así que scrapearUrlProducto termina leyendo la misma
  // página real sin necesitar ningún cambio.
  { regex: /^https:\/\/(?:www\.)?amzn\.to\//i, plataforma: 'amazon' },
  // Temu: las dos formas de link de producto que se ven en la práctica —
  // el link "lindo" con el nombre del producto (...-g-1234567890.html) que
  // se copia desde la página, y goods.html?goods_id=... que usa la app al
  // compartir. Fix 19/09: Temu a veces mete el código de país en el medio
  // del link (ej. temu.com/co/-nombre-del-producto-g-123.html cuando lo
  // compartís desde Colombia) — el patrón viejo no contemplaba ese "/co/" y
  // rechazaba links reales. Ahora ese segmento de 2 letras es opcional.
  { regex: /^https:\/\/(?:www\.)?temu\.com\/(?:[a-z]{2}\/)?(?:[^/?#]+-g-\d+\.html|goods\.html)/i, plataforma: 'temu' },
];

@Injectable()
export class ImportarProductoService {
  private readonly logger = new Logger(ImportarProductoService.name);

  // Margen aplicado sobre el precio de origen para sugerir un precio de
  // venta (3.5x es un margen típico de dropshipping para cubrir anuncios +
  // ganancia — fácil de ajustar acá si Norbey/su jefe prefieren otro número).
  private readonly MARKUP = 3.5;

  // Combo estándar de secciones para el piloto automático — ver nota grande
  // arriba del archivo sobre por qué estas 5 y no las 10 disponibles.
  // Orden: Testimonios va AL FINAL, después de Preguntas Frecuentes (pedido
  // explícito de Norbey 17/09 — antes quedaba entre Oferta y FAQ). Oferta va
  // SIEMPRE PRIMERO, antes que Hero (pedido explícito 18/09, con captura de
  // una landing real donde Oferta había quedado en el medio) — el botón de
  // comprar que se intercala justo después de Oferta (ver más abajo en el
  // for) queda entonces como lo primero que ve el cliente, apenas entra.
  private readonly SECCIONES_AUTOMATICAS: string[] = ['oferta', 'hero', 'beneficios', 'faq', 'testimonios'];

  private readonly ETIQUETAS_SECCION: Record<string, string> = {
    hero: 'Hero (portada / titular principal)',
    beneficios: 'Beneficios',
    oferta: 'Oferta y Precios',
    testimonios: 'Testimonios',
    faq: 'Preguntas Frecuentes',
  };

  // Máximo de reseñas reales que se componen en la imagen de Testimonios.
  // Empezó en 3 (16/09, alcanzaba y mantenía la imagen legible); Norbey pidió
  // (18/09) subirlo a por lo menos 10 para el módulo Product Marker del
  // taller — componerImagenTestimoniosReales ya arma la imagen apilando
  // tarjetas una debajo de otra sin ningún límite fijo, así que esto solo
  // hace la imagen más alta, no rompe el diseño.
  private readonly MAX_RESENAS_REALES = 10;

  // Estado de cada importación por link en curso — ver nota grande arriba
  // del archivo ("Módulo Product Marker DENTRO del taller"). Esto es lo
  // único que GET /estado/:id devuelve — nunca debe guardarse acá nada
  // sensible (la clave de fal.ai, por ejemplo).
  private readonly trabajosImportacion = new Map<string, EstadoImportacionPorLink>();

  // Contexto INTERNO de un trabajo pausado en 'revisando_resenas' — todo lo
  // que hace falta para retomar y terminar de generar una vez el estudiante
  // confirme/edite los nombres (ver confirmarResenasYGenerar). A propósito
  // en un Map aparte del de arriba: este SÍ tiene la clave de fal.ai del
  // estudiante, y nunca tiene que poder leerse por la API — se borra apenas
  // se usa (o si el trabajo se descarta sin confirmar, simplemente queda
  // huérfano hasta el próximo reinicio del servidor, mismo límite ya
  // conocido de guardar todo esto en memoria y no en base de datos).
  private readonly contextoPendienteResenas = new Map<
    string,
    {
      usuarioId: number;
      falApiKey: string;
      url: string;
      plataforma: PlataformaOrigen;
      opciones?: ImportarPorLinkOpciones;
      datos: { titulo: string; descripcion: string; fotos: string[]; precioOriginal?: number; moneda: string };
      resenas: ResenaOrigen[];
    }
  >();

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
  //
  // Actualización 17/09 (fuentes): las primeras dos versiones de esto
  // dibujaban el texto con elementos <text> de SVG, pidiéndole a sharp (por
  // debajo, a la librería librsvg) que lo escriba con la fuente "Arial" del
  // SISTEMA OPERATIVO del servidor. En Railway ese servidor no tiene NINGUNA
  // fuente instalada — se probaron dos rondas de fix instalando fuentes vía
  // nixpacks.toml (aptPkgs con fontconfig+fuentes, después agregando
  // fc-cache y la variable FONTCONFIG_PATH) y el error de Fontconfig seguía
  // apareciendo en los logs de Railway (Nixpacks arma el contenedor con Nix
  // por debajo, que trae su propio fontconfig aparte del que se instala con
  // apt, y no se pudo hacer que apunten al mismo lugar).
  //
  // Se abandonó ese enfoque: en vez de depender de que el servidor tenga
  // fuentes, ahora el texto se convierte acá mismo en dibujos vectoriales
  // (paths SVG) usando "opentype.js" + la fuente Liberation Sans que
  // TRAEMOS NOSOTROS embebida en fuentes-liberation.ts (ver ese archivo).
  // sharp/librsvg ya no tiene que "escribir" nada — solo dibuja las figuras
  // que le mandamos ya calculadas, así que no le hace falta ninguna fuente
  // del sistema. Probado a propósito simulando un servidor con CERO fuentes
  // instaladas (variable FONTCONFIG_FILE apuntando a una config vacía): el
  // texto se sigue viendo perfecto. Los símbolos de estrella (★/☆) también
  // se dibujan como polígonos (puntoEstrella/estrellasSvg) en vez de como
  // texto, porque Liberation Sans ni siquiera trae esos símbolos.

  private fuentesCache: { regular: opentype.Font; bold: opentype.Font } | null = null;

  private cargarFuentes(): { regular: opentype.Font; bold: opentype.Font } {
    if (!this.fuentesCache) {
      const aBuffer = (base64: string) => {
        const buf = Buffer.from(base64, 'base64');
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      };
      this.fuentesCache = {
        regular: opentype.parse(aBuffer(LIBERATION_SANS_REGULAR_BASE64)),
        bold: opentype.parse(aBuffer(LIBERATION_SANS_BOLD_BASE64)),
      };
    }
    return this.fuentesCache;
  }

  // Dibuja un string como un <path> de SVG (contorno vectorial de cada
  // letra) en vez de como texto — ver nota grande de arriba.
  private textoAPath(texto: string, x: number, y: number, tamano: number, negrita: boolean, color: string): string {
    const { regular, bold } = this.cargarFuentes();
    const fuente = negrita ? bold : regular;
    const d = fuente.getPath(texto, x, y, tamano).toPathData(2);
    return `<path d="${d}" fill="${color}"/>`;
  }

  // Corta el texto de la reseña en líneas que realmente entren en el ancho
  // disponible — usa el ancho REAL de cada palabra según la fuente
  // (font.getAdvanceWidth), no un conteo aproximado de caracteres. Si el
  // texto es muy largo, se corta con "…" en vez de desbordar la tarjeta.
  private envolverTexto(texto: string, tamanoFuente: number, anchoMaximoPx: number, maxLineas: number): string[] {
    const { regular } = this.cargarFuentes();
    const palabras = texto.trim().split(/\s+/);
    const lineas: string[] = [];
    let actual = '';
    for (const palabra of palabras) {
      const propuesta = actual ? `${actual} ${palabra}` : palabra;
      if (regular.getAdvanceWidth(propuesta, tamanoFuente) > anchoMaximoPx && actual) {
        lineas.push(actual);
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

  // Un solo pico de estrella, como polígono (no como carácter de fuente —
  // Liberation Sans no trae el símbolo ★, y tampoco haría falta si lo
  // trajera: dibujarla nosotros la deja del mismo tamaño/forma siempre).
  private estrellaPath(cx: number, cy: number, radioExterior: number): string {
    const radioInterior = radioExterior * 0.5;
    const puntos: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? radioExterior : radioInterior;
      const angulo = (-90 + i * 36) * (Math.PI / 180);
      puntos.push(`${(cx + r * Math.cos(angulo)).toFixed(2)},${(cy + r * Math.sin(angulo)).toFixed(2)}`);
    }
    return `M${puntos.join('L')}Z`;
  }

  // Fila de 5 estrellas — las primeras `calificacion` rellenas de color, el
  // resto en gris claro (equivalente a la estrella "vacía" ☆ de antes).
  private estrellasSvg(calificacion: number | undefined, x: number, yCentro: number, tamano: number): string {
    const n = Math.max(0, Math.min(5, Math.round(calificacion ?? 5)));
    const radio = tamano / 2;
    const espacio = tamano * 1.3;
    let svg = '';
    for (let i = 0; i < 5; i++) {
      const cx = x + radio + i * espacio;
      const relleno = i < n ? '#f5a623' : '#e4e0d8';
      svg += `<path d="${this.estrellaPath(cx, yCentro, radio)}" fill="${relleno}"/>`;
    }
    return svg;
  }

  // Hash chico y determinístico solo para elegir un color de fondo — no
  // necesita ser criptográfico, solo repetible para la misma reseña.
  private hashTexto(texto: string): number {
    let h = 0;
    for (let i = 0; i < texto.length; i++) h = (h * 31 + texto.charCodeAt(i)) >>> 0;
    return h;
  }

  // Avatar GENÉRICO y GRATIS para reseñas reales (pedido 18/09, después de
  // que Norbey mostró cómo se ve una reseña real de AliExpress: el
  // comprador casi siempre queda como "Anónimo" con un ícono genérico, no
  // con una foto de perfil real). Antes esto usaba la foto adjunta a la
  // reseña como avatar circular, y si no había, generaba una por IA (con
  // costo) — pedido explícito: la foto real ahora se muestra APARTE, debajo
  // del texto de la reseña (ver armarFilaFotosResena más abajo), así que acá
  // ya no hace falta ni descargar nada ni pagar por generar una cara falsa:
  // un círculo de color suave con una silueta simple de persona alcanza, y
  // es justo lo que se ve de verdad en AliExpress para compradores anónimos.
  private avatarGenericoResena(tamano: number, semilla: string): Buffer {
    const colores = ['#e8ddce', '#dce6dd', '#e3dbe8', '#e8d9dc', '#d9e3e8', '#f0e2c8'];
    const color = colores[this.hashTexto(semilla) % colores.length];
    const r = tamano / 2;
    const svg = `<svg width="${tamano}" height="${tamano}">
      <defs><clipPath id="clipAvatar"><circle cx="${r}" cy="${r}" r="${r}"/></clipPath></defs>
      <g clip-path="url(#clipAvatar)">
        <rect width="${tamano}" height="${tamano}" fill="${color}"/>
        <circle cx="${r}" cy="${tamano * 0.38}" r="${tamano * 0.16}" fill="#ffffff" fill-opacity="0.85"/>
        <ellipse cx="${r}" cy="${tamano * 0.97}" rx="${tamano * 0.32}" ry="${tamano * 0.3}" fill="#ffffff" fill-opacity="0.85"/>
      </g>
    </svg>`;
    return Buffer.from(svg);
  }

  // Descarga hasta 3 de las fotos que el comprador adjuntó a la reseña
  // (pedido 18/09: se muestran debajo del texto, no como avatar) y las
  // recorta cuadradas en fila. Si alguna URL puntual falla (vencida,
  // hotlink bloqueado), se la salta en vez de romper toda la tarjeta — y si
  // hay más de 3, la última trae un "+N" superpuesto, mismo patrón que
  // muestra AliExpress cuando una reseña trae varias fotos.
  private async armarFilaFotosResena(
    fotos: string[],
    tamano: number,
  ): Promise<{ buffers: Buffer[]; totalReales: number }> {
    const MAX_MOSTRADAS = 3;
    const buffers: Buffer[] = [];
    const aIntentar = fotos.slice(0, MAX_MOSTRADAS);
    for (let i = 0; i < aIntentar.length; i++) {
      try {
        const bytes = await this.descargarBytes(aIntentar[i], 'una foto adjunta a una reseña');
        const esUltimaConMas = i === aIntentar.length - 1 && fotos.length > MAX_MOSTRADAS;
        const restantes = fotos.length - MAX_MOSTRADAS;
        let img = sharp(bytes).resize(tamano, tamano, { fit: 'cover' });
        if (esUltimaConMas) {
          const overlay = Buffer.from(`<svg width="${tamano}" height="${tamano}">
            <rect width="${tamano}" height="${tamano}" fill="#000000" fill-opacity="0.45"/>
            <text x="50%" y="54%" text-anchor="middle" font-family="sans-serif" font-size="${Math.round(tamano * 0.32)}" font-weight="bold" fill="#ffffff">+${restantes}</text>
          </svg>`);
          img = img.composite([{ input: overlay }]);
        }
        const cuadrada = await img
          .composite([
            {
              input: Buffer.from(`<svg width="${tamano}" height="${tamano}"><rect width="${tamano}" height="${tamano}" rx="12" fill="#fff"/></svg>`),
              blend: 'dest-in',
            },
          ])
          .png()
          .toBuffer();
        buffers.push(cuadrada);
      } catch (error) {
        this.logger.warn(`No se pudo usar una foto adjunta a una reseña, se la salta: ${(error as Error).message}`);
      }
    }
    return { buffers, totalReales: buffers.length };
  }

  // Pedido 18/09 (2): antes, cuando el link traía reseñas reales, se armaba
  // una sola IMAGEN fija con todas las tarjetas dibujadas adentro (ver
  // componerImagenTestimoniosReales más abajo) — el estudiante pidió poder
  // abrir cada foto de una reseña por separado, algo imposible con una
  // imagen ya compuesta (las fotos quedan pegadas al dibujo, son solo
  // píxeles). La solución real: en vez de esa imagen, estas reseñas ahora
  // se guardan como reseñas de VERDAD del producto — el mismo mecanismo que
  // usa el estudiante cuando las carga a mano en "Personalizada" (ver
  // ProductosService.guardarResenas y el campo st.resenas del taller) — y
  // se intercala un marcador {tipo:'resenas'} en vez de una imagen. La
  // sección real de Shopify (seccionResenasLiquid, en shopify.service.ts)
  // ya sabe dibujar cada reseña con sus fotos reales como <img> de verdad,
  // cada una abrible en grande con un clic (lightbox). El avatar sigue
  // siendo la silueta genérica gratis (avatarGenericoResena) — acá se
  // rasteriza a PNG y se sube, porque esta vez hace falta una URL real de
  // imagen (no un buffer para componer con sharp localmente).
  private async armarResenasLandingDesdeReales(falClient: FalClient, resenas: ResenaOrigen[]): Promise<any[]> {
    const usadas = resenas.filter((r) => r.texto && r.texto.trim().length > 0).slice(0, this.MAX_RESENAS_REALES);
    const resultado: any[] = [];
    for (const resena of usadas) {
      let avatarUrl = '';
      try {
        const avatarSvg = this.avatarGenericoResena(96, resena.autor || resena.texto);
        const avatarPng = await sharp(avatarSvg).png().toBuffer();
        avatarUrl = await falClient.storage.upload(this.bufferABlob(avatarPng, 'image/png'));
      } catch (error) {
        this.logger.warn(`No se pudo generar/subir el avatar genérico de una reseña real — se publica sin avatar: ${(error as Error).message}`);
      }
      const fotos = (resena.fotos && resena.fotos.length > 0 ? resena.fotos : resena.fotoUrl ? [resena.fotoUrl] : []).slice(0, 3);
      resultado.push({
        id: `resena-real-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        fotoUrl: fotos[0] || '',
        fotos,
        avatarUrl,
        // Casi siempre viene "Anónimo" tal cual como lo muestra AliExpress
        // (pedido 18/09, mismo criterio que componerImagenTestimoniosReales).
        nombre: resena.autor?.trim() || 'Anónimo',
        ciudad: '',
        estrellas: resena.calificacion ?? 5,
        texto: resena.texto,
        pendiente: false,
        fechaCarga: new Date().toISOString(),
      });
    }
    return resultado;
  }

  // Arma el JPEG final con hasta MAX_RESENAS_REALES tarjetas de reseña
  // apiladas verticalmente: avatar genérico + nombre + estrellas + el texto
  // REAL de la reseña + (pedido 18/09) las fotos reales que el comprador
  // adjuntó, en una fila DEBAJO del texto — así se ve igual que en
  // AliExpress (la foto de un producto recibido no queda rara puesta como
  // si fuera la cara de la persona).
  //
  // NOTA (18/09, 2): esta función YA NO se usa para el piloto automático
  // cuando hay reseñas reales (ver armarResenasLandingDesdeReales arriba,
  // que la reemplazó ahí) — queda tal cual porque el modo "Personalizada"
  // manual del taller no la usa (arma su propia vista previa en el
  // frontend), pero SÍ podría volver a hacer falta si en algún momento se
  // quisiera ofrecer "Testimonios como imagen" como alternativa a mano.
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
    const TAMANO_FOTO_ADJUNTA = 100;
    const ESPACIO_ENTRE_FOTOS = 14;
    // Alto extra que ocupa la fila de fotos adjuntas cuando la reseña trae —
    // foto + aire arriba para separarla del texto.
    const ALTO_FILA_FOTOS = TAMANO_FOTO_ADJUNTA + 28;
    let costoEstimadoUsd = 0;
    const capas: sharp.OverlayOptions[] = [];

    // Primera pasada: envuelve el texto de cada reseña (ancho real en
    // píxeles según la fuente, no un conteo de caracteres — ver
    // envolverTexto), resuelve sus fotos adjuntas, y calcula el alto que le
    // corresponde a su tarjeta según cuántas líneas de texto y si trae fotos.
    const ANCHO_TEXTO_PX = 780;
    const TAMANO_LETRA_TEXTO = 26;
    const tarjetas = [];
    for (const resena of usadas) {
      const lineasTexto = this.envolverTexto(resena.texto, TAMANO_LETRA_TEXTO, ANCHO_TEXTO_PX, 6);
      const fotosOrigen = resena.fotos && resena.fotos.length > 0 ? resena.fotos : resena.fotoUrl ? [resena.fotoUrl] : [];
      const { buffers: fotosBuffers } = await this.armarFilaFotosResena(fotosOrigen, TAMANO_FOTO_ADJUNTA);
      const altoTarjeta =
        ALTO_TARJETA_BASE +
        Math.max(0, lineasTexto.length - 1) * ALTO_POR_LINEA_EXTRA +
        PADDING_INFERIOR_TARJETA +
        (fotosBuffers.length > 0 ? ALTO_FILA_FOTOS : 0);
      tarjetas.push({ resena, lineasTexto, fotosBuffers, altoTarjeta });
    }

    const ALTO =
      ALTO_HEADER +
      tarjetas.reduce((acc, t) => acc + t.altoTarjeta, 0) +
      Math.max(0, tarjetas.length - 1) * ESPACIO +
      MARGEN_INFERIOR;

    let yTarjeta = ALTO_HEADER;
    for (const { resena, lineasTexto, fotosBuffers, altoTarjeta } of tarjetas) {
      // Casi siempre va a venir "Anónimo" tal cual como lo muestra AliExpress
      // (pedido 18/09) — "Comprador verificado" queda solo como respaldo
      // para el caso raro de una reseña sin ningún nombre detectado.
      const nombreMostrado = resena.autor?.trim() || `Comprador verificado`;
      const yUltimaLinea = 168 + (lineasTexto.length - 1) * 36;
      const cuerpoTexto = lineasTexto
        .map((linea, idx) => this.textoAPath(linea, 64, 168 + idx * 36, TAMANO_LETRA_TEXTO, false, '#3d3d3d'))
        .join('');

      const tarjetaSvg = Buffer.from(`<svg width="${ANCHO}" height="${altoTarjeta}">
        <rect x="20" y="0" width="${ANCHO - 40}" height="${altoTarjeta - 20}" rx="28" fill="#ffffff" stroke="#ece6dc" stroke-width="2"/>
        ${this.textoAPath(nombreMostrado, 184, 70, 30, true, '#232323')}
        ${this.estrellasSvg(resena.calificacion, 184, 108, 26)}
        ${cuerpoTexto}
      </svg>`);

      const avatarBuffer = this.avatarGenericoResena(TAMANO_AVATAR, resena.autor || resena.texto);

      capas.push({ input: tarjetaSvg, left: 0, top: yTarjeta });
      capas.push({ input: avatarBuffer, left: 44, top: yTarjeta + 34 });

      // Fotos reales adjuntas a la reseña, DEBAJO del texto (pedido 18/09).
      if (fotosBuffers.length > 0) {
        const yFotos = yTarjeta + yUltimaLinea + 30;
        fotosBuffers.forEach((buf, idx) => {
          capas.push({ input: buf, left: 64 + idx * (TAMANO_FOTO_ADJUNTA + ESPACIO_ENTRE_FOTOS), top: yFotos });
        });
      }

      yTarjeta += altoTarjeta + ESPACIO;
    }

    // text-anchor="middle" no existe con paths — se calcula el ancho real
    // del texto (con la misma fuente embebida) y se centra a mano.
    const { regular: fuenteRegular, bold: fuenteBold } = this.cargarFuentes();
    const tituloHeader = 'Lo que dicen nuestros clientes';
    const subtituloHeader = `Reseñas reales de ${nombreProducto}`.slice(0, 70);
    const xTitulo = (ANCHO - fuenteBold.getAdvanceWidth(tituloHeader, 46)) / 2;
    const xSubtitulo = (ANCHO - fuenteRegular.getAdvanceWidth(subtituloHeader, 26)) / 2;
    const encabezadoSvg = Buffer.from(`<svg width="${ANCHO}" height="${ALTO_HEADER}">
      ${this.textoAPath(tituloHeader, xTitulo, 90, 46, true, '#232323')}
      ${this.textoAPath(subtituloHeader, xSubtitulo, 140, 26, false, '#6b6b6b')}
    </svg>`);

    const fondo = sharp({ create: { width: ANCHO, height: ALTO, channels: 3, background: { r: 250, g: 247, b: 242 } } });
    const resultado = await fondo
      .composite([{ input: encabezadoSvg, left: 0, top: 0 }, ...capas])
      .jpeg({ quality: 90 })
      .toBuffer();

    return { buffer: resultado, costoEstimadoUsd };
  }

  // ---------------------------------------------------------------------
  // Module "Product Marker" dentro del taller — pegar un link, sin
  // extensión. Ver la nota grande arriba del archivo para el detalle
  // completo y las limitaciones (reseñas reales, sitios que bloquean).
  // ---------------------------------------------------------------------

  // Paso 1: arranca el trabajo en segundo plano y devuelve un id al toque
  // — el controller responde con ese id sin esperar a que termine.
  iniciarImportacionPorLink(usuarioId: number, falApiKey: string, url: string, opciones?: ImportarPorLinkOpciones): string {
    const soportada = PATRONES_PLATAFORMA_SOPORTADA.find((p) => p.regex.test(url));
    if (!soportada) {
      throw new InternalServerErrorException(
        'Ese link no es de una tienda soportada todavía (por ahora: AliExpress, Amazon o Temu). Pegá el link de la página del producto.',
      );
    }

    const id = randomUUID();
    this.trabajosImportacion.set(id, { id, estado: 'leyendo_pagina' });

    // A propósito NO se espera (sin "await") — el trabajo sigue solo en
    // segundo plano mientras el controller ya le contestó al taller con el
    // id. Cualquier error acá se guarda en el estado del trabajo, no
    // rompe nada más.
    this.procesarImportacionPorLink(id, usuarioId, falApiKey, url, soportada.plataforma, opciones).catch((error) => {
      this.trabajosImportacion.set(id, { id, estado: 'error', error: error?.message || String(error) });
    });

    return id;
  }

  // Paso 2: lo consulta el taller cada pocos segundos (polling) para
  // actualizar la barra de progreso — devuelve undefined si el id no existe
  // (nunca existió, o el servidor se reinició mientras tanto).
  obtenerEstadoImportacion(id: string): EstadoImportacionPorLink | undefined {
    return this.trabajosImportacion.get(id);
  }

  private async procesarImportacionPorLink(
    id: string,
    usuarioId: number,
    falApiKey: string,
    url: string,
    plataforma: PlataformaOrigen,
    opciones?: ImportarPorLinkOpciones,
  ): Promise<void> {
    const datos = await this.scrapearUrlProducto(url);
    // Reseñas reales (pedido 18/09, ampliado 18/09 (5) y (6)) — best-effort,
    // ver scrapearResenasAliExpressPorLink/scrapearResenasAmazonDeHtml/
    // scrapearResenasTemuConNavegador más arriba sobre por qué esto puede
    // volver vacío en cualquier momento sin que sea un error real:
    //  - AliExpress: endpoint aparte (JS-cargado, sin él no hay reseñas).
    //  - Amazon: se leen del MISMO html ya descargado arriba (Amazon las
    //    trae server-side, no hace falta un segundo pedido).
    //  - Temu: navegador headless (Puppeteer) — es la única de las tres que
    //    abre un Chromium de verdad, con selectores heurísticos SIN
    //    verificar contra el sitio real (ver el aviso grande en esa
    //    función) — más lenta que las otras dos y con más chance de volver
    //    vacía hasta que se calibre con un caso real.
    const resenasCrudas =
      plataforma === 'aliexpress'
        ? await this.scrapearResenasAliExpressPorLink(url)
        : plataforma === 'amazon'
          ? this.scrapearResenasAmazonDeHtml(datos.html, datos.htmlRenderizadoConNavegador)
          : plataforma === 'temu'
            ? // Fix 19/09: si scrapearUrlProducto() ya tuvo que abrir un
              // navegador de verdad para conseguir título/fotos (el caso más
              // común en Temu), ESE MISMO html renderizado ya sirve para
              // buscar reseñas — evita abrir un segundo Chromium. Solo si
              // el pedido simple alcanzó para el título/fotos (raro en
              // Temu, pero no imposible) se abre un navegador aparte acá.
              datos.htmlRenderizadoConNavegador
              ? this.extraerResenasHeuristicasDelHtmlRenderizado(datos.html)
              : await this.scrapearResenasTemuConNavegador(url)
            : [];
    // Mismo filtro/orden que se le va a aplicar en pilotoAutomatico — se
    // hace ACÁ también para que lo que el estudiante vea para revisar sea
    // EXACTO a lo que se va a usar (ni una reseña de más ni de menos), y
    // recortado al máximo a mostrar.
    const resenasPositivas = this.filtrarYOrdenarResenasPositivas(resenasCrudas).slice(0, this.MAX_RESENAS_REALES);

    // El html crudo ya cumplió su función (leer título/fotos/precio y,
    // en Amazon, las reseñas) — no hace falta cargarlo en memoria más
    // tiempo del necesario, así que no se guarda en ningún lado de acá en
    // adelante (ni en el Map de contexto pendiente ni en el resultado).
    const { html: _html, htmlRenderizadoConNavegador: _htmlRenderizadoConNavegador, ...datosSinHtml } = datos;

    if (resenasPositivas.length === 0) {
      // Sin reseñas reales que revisar — sigue de largo como siempre (IA
      // inventa el contenido de Testimonios).
      await this.continuarConGeneracion(id, usuarioId, falApiKey, url, plataforma, datosSinHtml, [], opciones);
      return;
    }

    // Pausa acá (pedido 18/09): el estudiante tiene que ver y, si quiere,
    // editarle el nombre a las que vinieron "Anónimo" antes de seguir. El
    // contexto completo para retomar queda guardado aparte (nunca se expone
    // por /estado/:id) — ver confirmarResenasYGenerar().
    this.contextoPendienteResenas.set(id, { usuarioId, falApiKey, url, plataforma, opciones, datos: datosSinHtml, resenas: resenasPositivas });
    this.trabajosImportacion.set(id, {
      id,
      estado: 'revisando_resenas',
      resenasParaRevisar: resenasPositivas.map((r) => {
        const autorOriginal = r.autor?.trim() || '';
        const esAnonimo = !autorOriginal || /^an[oó]nimo$/i.test(autorOriginal);
        return {
          autor: esAnonimo ? 'Anónimo' : autorOriginal,
          esAnonimo,
          calificacion: r.calificacion,
          texto: r.texto,
          fotos: r.fotos && r.fotos.length > 0 ? r.fotos : r.fotoUrl ? [r.fotoUrl] : [],
        };
      }),
    });
  }

  // Paso intermedio del módulo Product Marker (pedido 18/09): el taller
  // llama esto cuando el estudiante confirma la lista de reseñas — con los
  // nombres que haya editado para las que vinieron "Anónimo" — y recién ahí
  // se genera la landing de verdad. `autoresEditados` viene en el MISMO
  // orden que resenasParaRevisar del estado 'revisando_resenas'.
  async confirmarResenasYGenerar(id: string, autoresEditados: (string | undefined)[]): Promise<void> {
    const contexto = this.contextoPendienteResenas.get(id);
    if (!contexto) {
      throw new InternalServerErrorException(
        'No se encontró esa importación para confirmar (puede que el servidor se haya reiniciado, o que ya se haya confirmado antes).',
      );
    }
    this.contextoPendienteResenas.delete(id);

    const resenasFinales = contexto.resenas.map((r, i) => {
      const editado = (autoresEditados?.[i] || '').trim();
      // Si el estudiante dejó el campo vacío o sin tocar, se respeta el
      // autor tal como vino de la página de origen (incluido "Anónimo").
      return editado ? { ...r, autor: editado } : r;
    });

    // A propósito NO se espera (sin "await") — mismo patrón que
    // iniciarImportacionPorLink: el controller ya le contestó al taller que
    // se confirmó, y el trabajo pesado sigue solo en segundo plano.
    this.continuarConGeneracion(
      id,
      contexto.usuarioId,
      contexto.falApiKey,
      contexto.url,
      contexto.plataforma,
      contexto.datos,
      resenasFinales,
      contexto.opciones,
    ).catch((error) => {
      this.trabajosImportacion.set(id, { id, estado: 'error', error: error?.message || String(error) });
    });
  }

  private async continuarConGeneracion(
    id: string,
    usuarioId: number,
    falApiKey: string,
    url: string,
    plataforma: PlataformaOrigen,
    datos: { titulo: string; descripcion: string; fotos: string[]; precioOriginal?: number; moneda: string },
    resenas: ResenaOrigen[],
    opciones?: ImportarPorLinkOpciones,
  ): Promise<void> {
    this.trabajosImportacion.set(id, { id, estado: 'generando_secciones' });
    // Título personalizado (pedido 18/09): si el estudiante escribió uno en
    // el formulario, reemplaza al título scrapeado de la página de origen
    // (que suele venir largo, lleno de palabras de SEO).
    const tituloFinal = opciones?.tituloPersonalizado?.trim() || datos.titulo;
    const resultado = await this.pilotoAutomatico(usuarioId, falApiKey, {
      usuarioId,
      falApiKey,
      url,
      plataforma,
      titulo: tituloFinal,
      descripcion: datos.descripcion,
      fotos: datos.fotos,
      precioOriginal: datos.precioOriginal,
      moneda: datos.moneda,
      resenas,
      ofertaManual: opciones?.ofertaManual,
    });
    this.trabajosImportacion.set(id, { id, estado: 'listo', resultado });
  }

  // Le pide la página al sitio de origen DIRECTO desde el servidor (con
  // headers de navegador real, para no identificarse como un bot obvio) y
  // busca los mismos datos "estructurados" que ya usa content-aliexpress.js
  // en la extensión — JSON-LD del producto primero (más confiable, no
  // depende de clases CSS que cambian), etiquetas og: como respaldo. A
  // propósito NO intenta heurísticas de DOM más agresivas (galería de
  // imágenes, regex de precio en el texto) salvo para el precio — sin un
  // navegador de verdad ejecutando el JavaScript de la página, esas
  // heurísticas son mucho menos confiables sobre HTML crudo.
  private async scrapearUrlProducto(url: string): Promise<{
    titulo: string;
    descripcion: string;
    fotos: string[];
    precioOriginal?: number;
    moneda: string;
    // HTML crudo ya descargado — se devuelve acá para que
    // scrapearResenasAmazonDeHtml() (18/09 (5)) lo reutilice sin pedirle la
    // página al sitio de origen una segunda vez (Amazon en particular
    // bloquea más fácil con pedidos repetidos seguidos).
    html: string;
    // true si `html` de arriba vino de renderizarPaginaConNavegador() (el
    // pedido simple no encontró título/fotos) en vez del fetch simple —
    // 19/09, ver el fix más abajo. procesarImportacionPorLink lo usa para
    // no abrir un SEGUNDO Chromium buscando reseñas de Temu cuando ya tiene
    // el HTML renderizado a mano.
    htmlRenderizadoConNavegador: boolean;
  }> {
    let html: string;
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        },
      });
      if (!resp.ok) {
        throw new Error(`la página respondió con un error (código ${resp.status})`);
      }
      html = await resp.text();
    } catch (error) {
      throw new InternalServerErrorException(
        `No se pudo abrir esa página desde el servidor (${(error as Error).message || error}) — probá copiando el link de nuevo, o si el problema sigue puede que ese sitio esté bloqueando pedidos automáticos.`,
      );
    }

    let datos = this.extraerDatosEstructuradosDeHtml(html);
    let htmlRenderizadoConNavegador = false;

    // Fix 19/09 ("pasa lo mismo con amazon"/"...para amazon y temu"): el
    // pedido simple de arriba (fetch, sin ejecutar JavaScript) puede volver
    // sin título ni fotos por dos motivos bien distintos —
    //  (a) el sitio arma el contenido recién con JavaScript en el navegador
    //      (le pasa siempre a Temu, que es una SPA), o
    //  (b) el sitio detectó el pedido como un bot y devolvió una página de
    //      verificación en vez del producto (le pasa más a Amazon).
    // En los dos casos, un navegador de verdad (el mismo Puppeteer que ya
    // se usaba solo para las reseñas de Temu, ver más abajo) tiene mejores
    // chances de traer el contenido real — así que si el pedido simple no
    // encontró nada, se intenta UNA vez más así antes de darse por vencido.
    // De paso, este mismo HTML ya renderizado le sirve a las reseñas reales
    // de Temu sin tener que abrir un segundo Chromium — ver el flag
    // htmlRenderizadoConNavegador, que usa procesarImportacionPorLink.
    if (!datos.titulo || datos.fotos.length === 0) {
      try {
        const htmlRenderizado = await this.renderizarPaginaConNavegador(url);
        const datosRenderizados = this.extraerDatosEstructuradosDeHtml(htmlRenderizado);
        if (datosRenderizados.titulo && datosRenderizados.fotos.length > 0) {
          html = htmlRenderizado;
          datos = datosRenderizados;
          htmlRenderizadoConNavegador = true;
        } else {
          // Fix 20/09 (Norbey probó Temu real y esto falló SIN dejar
          // ningún rastro en los logs de Railway — imposible de
          // diagnosticar a distancia): el navegador SÍ pudo abrir la
          // página sin tirar ningún error, pero igual no encontró título ni
          // fotos con JSON-LD/etiquetas og:* — hay SPA que nunca ponen esas
          // etiquetas (solo sirven para compartir en redes, y no todo sitio
          // se molesta). Antes de rendirse del todo, último intento con
          // datos MENOS confiables pero que casi cualquier página tiene
          // aunque no tenga og:*: el <title> de la pestaña del navegador
          // (extraerTituloDeEtiquetaTitle) y una heurística amplia sobre
          // las <img> de la página, descartando iconos/logos obvios
          // (extraerFotosHeuristicasDeHtml — mismo espíritu que el filtro
          // de fotos de reseñas de Temu más abajo).
          const tituloDeRespaldo = datosRenderizados.titulo || this.extraerTituloDeEtiquetaTitle(htmlRenderizado);
          const fotosDeRespaldo =
            datosRenderizados.fotos.length > 0 ? datosRenderizados.fotos : this.extraerFotosHeuristicasDeHtml(htmlRenderizado);
          if (tituloDeRespaldo && fotosDeRespaldo.length > 0) {
            html = htmlRenderizado;
            datos = { ...datosRenderizados, titulo: tituloDeRespaldo, fotos: fotosDeRespaldo };
            htmlRenderizadoConNavegador = true;
            this.logger.warn(
              `Product Marker: ${url} no tenía JSON-LD ni etiquetas og:* ni con navegador — se usó un respaldo heurístico (título de la pestaña + primeras fotos "reales" de la página). Puede traer un título con menos formato o fotos que no sean las mejores — avisar a Norbey si pasa seguido para revisar mejor.`,
            );
          } else {
            // Ni el respaldo heurístico encontró nada — se deja constancia
            // con pistas concretas para la próxima calibración manual.
            const cantidadDeImagenes = (htmlRenderizado.match(/<img[^>]*>/gi) || []).length;
            this.logger.warn(
              `Product Marker: se abrió un navegador real para ${url} y renderizó la página sin errores, pero no encontró título/fotos ni con JSON-LD/og:* ni con el respaldo heurístico — <title> de la pestaña: "${tituloDeRespaldo || '(vacío)'}", cantidad de <img> en la página: ${cantidadDeImagenes}. Hace falta calibrar la extracción para este sitio con un caso real (avisar a Norbey).`,
            );
          }
        }
      } catch (error) {
        this.logger.warn(
          `Product Marker: el pedido simple no encontró título/fotos y tampoco se pudo abrir esa página con un navegador real (${(error as Error).message || error}).`,
        );
      }
    }

    if (!datos.titulo || datos.fotos.length === 0) {
      throw new InternalServerErrorException(
        'No se pudo encontrar el título o las fotos del producto en esa página, ni pidiéndola directo ni abriéndola con un navegador real. Puede que ese sitio haya cambiado de formato o que haya detectado el pedido como automático — probá con otro link del mismo producto, o avisame para revisarlo.',
      );
    }

    return {
      titulo: datos.titulo.trim().slice(0, 200),
      descripcion: datos.descripcion.trim().slice(0, 2000),
      fotos: datos.fotos.slice(0, 5),
      precioOriginal: Number.isFinite(datos.precioOriginal) ? datos.precioOriginal : undefined,
      moneda: datos.moneda,
      html,
      htmlRenderizadoConNavegador,
    };
  }

  // Extrae JSON-LD Product / etiquetas og:* / precio en texto de un HTML ya
  // descargado — separado en su propia función (19/09) para poder correrla
  // DOS veces si hace falta: una vez sobre el HTML del pedido simple, y otra
  // (solo si la primera no encontró título ni fotos) sobre el HTML ya
  // renderizado por un navegador de verdad.
  private extraerDatosEstructuradosDeHtml(html: string): {
    titulo: string;
    descripcion: string;
    fotos: string[];
    precioOriginal?: number;
    moneda: string;
  } {
    const jsonLd = this.extraerJsonLdDeHtml(html);
    const titulo = (jsonLd && jsonLd.name) || this.extraerMetaDeHtml(html, 'og:title') || '';
    const descripcion = (jsonLd && jsonLd.description) || this.extraerMetaDeHtml(html, 'og:description') || '';

    let fotos: string[] = [];
    if (jsonLd && jsonLd.image) {
      fotos = Array.isArray(jsonLd.image) ? jsonLd.image : [jsonLd.image];
    }
    if (fotos.length === 0) {
      const ogImage = this.extraerMetaDeHtml(html, 'og:image');
      if (ogImage) fotos.push(ogImage);
    }

    let precioOriginal: number | undefined;
    let moneda = 'USD';
    if (jsonLd && jsonLd.offers) {
      const oferta = Array.isArray(jsonLd.offers) ? jsonLd.offers[0] : jsonLd.offers;
      if (oferta) {
        precioOriginal = parseFloat(oferta.price);
        moneda = oferta.priceCurrency || 'USD';
      }
    }
    if (precioOriginal === undefined || Number.isNaN(precioOriginal)) {
      const precioDeTexto = this.extraerPrecioDeHtml(html);
      if (precioDeTexto) {
        precioOriginal = precioDeTexto.valor;
        moneda = precioDeTexto.moneda;
      }
    }

    return { titulo, descripcion, fotos, precioOriginal, moneda };
  }

  private extraerJsonLdDeHtml(html: string): any {
    const regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html))) {
      try {
        const data = JSON.parse(match[1]);
        const candidatos = Array.isArray(data) ? data : [data];
        for (const item of candidatos) {
          const tipo = item && item['@type'];
          if (tipo === 'Product' || tipo === 'schema:Product') return item;
        }
      } catch {
        // JSON-LD roto o de otro tipo — se ignora y se sigue con el siguiente <script>.
      }
    }
    return null;
  }

  private extraerMetaDeHtml(html: string, propiedad: string): string | null {
    // Las etiquetas <meta> pueden traer los atributos en cualquier orden
    // (property antes o después de content) — se prueban las dos formas.
    const propiedadEscapada = propiedad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regexNormal = new RegExp(`<meta[^>]+property=["']${propiedadEscapada}["'][^>]*content=["']([^"']*)["']`, 'i');
    const regexInvertida = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*property=["']${propiedadEscapada}["']`, 'i');
    const match = html.match(regexNormal) || html.match(regexInvertida);
    return match ? match[1] : null;
  }

  private extraerPrecioDeHtml(html: string): { valor: number; moneda: string } | null {
    const match = html.match(/(US\s?\$|\$|€)\s?(\d+[.,]\d{2})/);
    if (!match) return null;
    const valor = parseFloat(match[2].replace(',', '.'));
    const moneda = match[1].includes('€') ? 'EUR' : 'USD';
    return { valor, moneda };
  }

  // Último respaldo de título (20/09, ver el fix grande en scrapearUrlProducto
  // sobre por qué hace falta): el <title> de la pestaña del navegador es de
  // las pocas cosas que prácticamente cualquier página pone, tenga o no
  // etiquetas og:*. Muchos sitios le agregan el nombre de la tienda separado
  // por un guion medio o una barra ("Producto X - Temu", "Temu | Producto
  // X") — se asume que la parte más larga es el nombre del producto (el
  // nombre de la tienda sola siempre va a ser más corto) y se descarta el
  // resto.
  private extraerTituloDeEtiquetaTitle(html: string): string {
    const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (!match) return '';
    const partes = match[1]
      .split(/\s[-|]\s/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (partes.length === 0) return '';
    return partes.reduce((masLargo, actual) => (actual.length > masLargo.length ? actual : masLargo), partes[0]);
  }

  // Último respaldo de fotos (20/09, mismo caso que el título de arriba):
  // heurística amplia sobre TODAS las <img> de la página ya renderizada,
  // descartando lo que se vea claramente como ícono/logo/interfaz en vez de
  // foto de producto — a propósito NO intenta adivinar cuál es "la mejor"
  // (ordenar por tamaño, etc.) porque sin un caso real de Temu para calibrar
  // contra, cualquier criterio más fino es puro adivine; se queda con las
  // primeras 5 que pasan el filtro, en el orden en que aparecen en la
  // página (la foto principal casi siempre está entre las primeras).
  private extraerFotosHeuristicasDeHtml(html: string): string[] {
    const $ = cheerio.load(html);
    const fotos: string[] = [];
    const vistas = new Set<string>();
    $('img').each((_, el) => {
      if (fotos.length >= 5) return;
      const $img = $(el);
      const src = $img.attr('src') || $img.attr('data-src') || $img.attr('data-lazy-src') || '';
      if (!/^https?:\/\//i.test(src) || vistas.has(src)) return;
      const claseOId = `${$img.attr('class') || ''} ${$img.attr('id') || ''} ${src}`.toLowerCase();
      if (/icon|sprite|logo|avatar|placeholder|loading|blank\.gif|1x1/.test(claseOId)) return;
      const ancho = parseInt($img.attr('width') || '0', 10);
      const alto = parseInt($img.attr('height') || '0', 10);
      if ((ancho && ancho < 80) || (alto && alto < 80)) return;
      vistas.add(src);
      fotos.push(src);
    });
    return fotos;
  }

  // Reseñas reales para el módulo "Product Marker" del taller (pedido 18/09,
  // tras confirmar con Norbey que el HTML plano de scrapearUrlProducto() de
  // arriba NUNCA trae reseñas — AliExpress las carga por JavaScript después
  // de que la página termina de cargar). En vez de sumar un navegador
  // headless (mucho más pesado de correr en Railway), se usa un endpoint
  // JSON de AliExpress que devuelve las reseñas directo, sin necesitar
  // ejecutar nada de JS ni haber iniciado sesión — feedback.aliexpress.com,
  // el mismo que usan varios scrapers de código abierto. OJO: no es una API
  // oficial ni documentada por AliExpress — puede cambiar de forma o
  // bloquear pedidos desde IPs de datacenter (como las de Railway) sin
  // aviso. Por eso esto es "mejor esfuerzo": cualquier error acá se traga y
  // devuelve un arreglo vacío — Testimonios simplemente cae al
  // comportamiento de siempre (IA inventa el contenido), nunca rompe la
  // importación completa por esto.
  private async scrapearResenasAliExpressPorLink(url: string): Promise<ResenaOrigen[]> {
    const idMatch = url.match(/\/item\/(\d+)\.html/i);
    if (!idMatch) return [];
    const productId = idMatch[1];
    try {
      const params = new URLSearchParams({
        productId,
        lang: 'es_ES',
        country: 'US',
        page: '1',
        // De más a propósito: pilotoAutomatico() filtra después a solo
        // positivas (>= 4 estrellas) y recorta a MAX_RESENAS_REALES — pedir
        // de más acá compensa las que se descarten en ese filtro.
        pageSize: '30',
        filter: 'all',
        sort: 'complex_default',
      });
      const resp = await fetch(`https://feedback.aliexpress.com/pc/searchEvaluation.do?${params.toString()}`, {
        headers: {
          accept: 'application/json, text/plain, */*',
          origin: 'https://www.aliexpress.com',
          referer: 'https://www.aliexpress.com/',
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        },
      });
      if (!resp.ok) {
        this.logger.warn(
          `Product Marker: el endpoint de reseñas de AliExpress respondió ${resp.status} para el producto ${productId} — Testimonios va a usar reseñas inventadas por IA.`,
        );
        return [];
      }
      const data = await resp.json().catch(() => null);
      const lista = data?.data?.evaViewList;
      if (!Array.isArray(lista)) return [];
      return lista
        .map((item: any): ResenaOrigen | null => {
          const texto = String(item?.buyerTranslationFeedback || item?.buyerFeedback || '').trim();
          if (!texto) return null;
          const fotos = this.todasLasFotosDeResenaAliExpress(item);
          return {
            texto,
            calificacion: this.normalizarCalificacionResena(item?.buyerEval),
            autor: item?.buyerName ? String(item.buyerName).trim().slice(0, 60) : undefined,
            fotoUrl: fotos[0],
            fotos,
          };
        })
        .filter((r: ResenaOrigen | null): r is ResenaOrigen => !!r);
    } catch (error) {
      this.logger.warn(
        `Product Marker: no se pudieron leer las reseñas reales de AliExpress (${(error as Error).message || error}) — Testimonios va a usar reseñas inventadas por IA.`,
      );
      return [];
    }
  }

  // El campo de calificación de este endpoint no está documentado — a veces
  // viene 1-5 directo, a veces en otras escalas según la versión del sitio.
  // Se normaliza a 1-5 con una heurística simple; si no se puede interpretar
  // con confianza, se deja sin calificación (estrellasSvg ya sabe mostrar 5
  // estrellas por defecto cuando calificacion viene undefined).
  private normalizarCalificacionResena(raw: unknown): number | undefined {
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
    if (!Number.isFinite(n)) return undefined;
    if (n >= 1 && n <= 5) return Math.round(n);
    // Escala de 100 (20/40/60/80/100 ≈ 1-5 estrellas) — un número chico como
    // 6 o 7 no encaja con confianza en ninguna escala conocida, así que se
    // deja sin calificación en vez de arriesgar un redondeo sin sentido
    // (7/20 redondearía a 0 estrellas, que ni siquiera es un valor válido).
    if (n >= 20 && n <= 100) return Math.round(n / 20);
    return undefined;
  }

  // El nombre exacto del campo con las fotos que el comprador adjuntó a su
  // reseña varió entre versiones del sitio en lo que se pudo confirmar por
  // fuera — se prueban varios nombres conocidos, tanto arreglos de URLs
  // sueltas como de objetos con la URL adentro. Pedido 18/09: se traen TODAS
  // (hasta un tope razonable), no solo la primera, porque ahora se muestran
  // como una fila de fotos debajo del texto (ver componerImagenTestimoniosReales).
  private todasLasFotosDeResenaAliExpress(item: any): string[] {
    const candidatos = [item?.images, item?.imageList, item?.additionalReviewImages, item?.reviewImages];
    for (const arr of candidatos) {
      if (Array.isArray(arr) && arr.length > 0) {
        const urls = arr
          .map((el: any) => (typeof el === 'string' ? el : el?.url || el?.imageUrl || el?.src))
          .filter((u: unknown): u is string => typeof u === 'string' && !!u);
        if (urls.length > 0) return urls.slice(0, 5);
      }
    }
    return [];
  }

  // ---------------------------------------------------------------------
  // Reseñas reales de AMAZON (pedido 18/09 (5): "quiero que las reseñas
  // sean igual que con amazon y temu" — es decir, reales, no inventadas por
  // IA, mismo trato que ya tiene AliExpress).
  //
  // A diferencia de AliExpress (que carga sus reseñas con JavaScript
  // DESPUÉS de que el servidor responde, por eso hizo falta ese endpoint
  // aparte de feedback.aliexpress.com), Amazon SÍ trae una tanda de reseñas
  // ("Top reviews from...") ya escritas en el HTML crudo que devuelve el
  // servidor — están ahí por SEO, para que Google las indexe sin ejecutar
  // JS. Por eso NO hace falta un segundo pedido de red: se reutiliza el
  // MISMO html que ya bajó scrapearUrlProducto() para leer título/fotos/
  // precio (ver el campo `html` que ahora devuelve esa función) — menos
  // pedidos a Amazon, menos chance de que la marque como bot.
  //
  // Estructura usada (confirmada por investigación, no adivinada a ciegas —
  // son los atributos "data-hook" que Amazon viene usando desde hace años
  // para sus propios tests automatizados, bastante más estables que sus
  // clases CSS): cada reseña vive en un `div[data-hook="review"]`, con
  // `[data-hook="review-body"]` (texto), `.a-profile-name` (nombre),
  // `[data-hook="review-star-rating"]` (calificación, como texto "5.0 out
  // of 5 stars" o "5,0 de 5 estrellas" según el idioma de la página) y
  // `img[data-hook="review-image-tile"]` (fotos que el comprador adjuntó).
  // Como cualquier heurística sobre el HTML de un sitio ajeno (mismo
  // disclaimer que ya aplica al endpoint de AliExpress): Amazon puede
  // cambiar este marcado sin aviso — si en algún momento deja de traer
  // reseñas reales, revisar acá primero. Usa la librería "cheerio"
  // (instalar con: npm install cheerio) en vez de regex a mano — a
  // diferencia de una etiqueta <meta> suelta, el árbol de reseñas tiene
  // demasiados niveles anidados para recortarlo de forma confiable con
  // regex simple.
  //
  // Al ser un parseo del HTML ya descargado (no un pedido de red), esto es
  // síncrono y nunca falla por timeout — si Amazon cambió el marcado o esa
  // página puntual no traía ninguna reseña visible, simplemente devuelve un
  // arreglo vacío y Testimonios cae al comportamiento de siempre (IA
  // inventa), igual que ya pasa con AliExpress.
  // Fix 26/09 ("amazon si trajo la info pero no me trajo las reseñas
  // reales"): esta función podía volver vacía en silencio, sin dejar
  // NINGÚN rastro en los Deploy Logs — mismo hueco que ya habíamos pisado
  // con Temu el 20/09 (ver el aviso grande de esa ronda). Ahora sí queda
  // registrado, distinguiendo los dos casos que antes se veían idénticos
  // desde afuera ("no trajo reseñas") pero significan cosas MUY distintas:
  //  (a) ni un solo `div[data-hook="review"]` en el HTML — o el producto de
  //      verdad no tiene reseñas todavía, o Amazon le mostró una variante de
  //      la página (ej. otra región, otro layout) donde ese data-hook no
  //      existe con ese nombre.
  //  (b) sí hay bloques de reseña, pero ninguno tenía texto legible adentro
  //      — el data-hook del CONTENEDOR sigue existiendo pero el de adentro
  //      (`review-body`) cambió, o el bloque viene vacío por algún motivo.
  // htmlRenderizadoConNavegador (nuevo parámetro, ver el llamado en
  // procesarImportacionPorLink) queda en el mismo log para saber si el HTML
  // que se intentó leer vino del pedido simple o del navegador con scroll —
  // dato clave para saber dónde mirar primero si hay que calibrar de nuevo.
  private scrapearResenasAmazonDeHtml(html: string, htmlRenderizadoConNavegador: boolean): ResenaOrigen[] {
    try {
      const $ = cheerio.load(html);
      const resenas: ResenaOrigen[] = [];
      const bloques = $('div[data-hook="review"]');
      bloques.each((_, el) => {
        const $resena = $(el);
        const texto = $resena.find('[data-hook="review-body"]').first().text().replace(/\s+/g, ' ').trim();
        if (!texto) return;
        const autor = $resena.find('.a-profile-name').first().text().trim() || undefined;
        const textoCalificacion = $resena
          .find('[data-hook="review-star-rating"], [data-hook="review-star-rating-view-point"]')
          .first()
          .text()
          .trim();
        const calificacion = this.extraerCalificacionDeTextoAmazon(textoCalificacion);
        const fotos = $resena
          .find('img[data-hook="review-image-tile"], .review-image-tile img')
          .map((__, img) => $(img).attr('src'))
          .get()
          .filter((src): src is string => !!src)
          // Amazon sirve estas miniaturas achicadas con uno o más códigos de
          // tamaño pegados antes de la extensión (ej. "..._SY88.jpg" o
          // "..._AC_UL320_SR320,320_.jpg") — se reemplaza ese bloque entero
          // por un solo código de una imagen bien grande, truco conocido de
          // las URLs de imágenes de Amazon. Si el patrón no matchea (formato
          // distinto al esperado), se deja la URL tal cual en vez de romperla.
          .map((src) => src.replace(/\._[A-Za-z0-9,_]+(?=\.[a-z]{3,4}$)/i, '._SL1200_'))
          .slice(0, 5);
        resenas.push({ texto, calificacion, autor, fotoUrl: fotos[0], fotos });
      });
      if (resenas.length === 0) {
        // Fix 26/09 (segunda vuelta): la ronda anterior de este mismo log ya
        // nos dijo que SÍ había bloques "div[data-hook=review]" (13, en el
        // caso real que probó Norbey) pero ninguno tenía texto legible
        // adentro — es decir, Amazon cambió el marcado DE ADENTRO de la
        // reseña (el data-hook de "review-body" ya no es el que esperamos),
        // no el contenedor. En vez de pedirle a Norbey que abra las
        // herramientas de desarrollador del navegador (nada trivial si no es
        // su terreno), este log manda directo a Railway un pedazo del HTML
        // de ADENTRO de la primera reseña encontrada — con eso alcanza para
        // ver el marcado real y ajustar el selector, sin ida y vuelta.
        const huboBloquesSinTexto = bloques.length > 0;
        const muestraDeAdentro = huboBloquesSinTexto
          ? bloques.first().html()?.replace(/\s+/g, ' ').trim().slice(0, 1000)
          : undefined;
        this.logger.warn(
          `Product Marker: Amazon no trajo ninguna reseña real (HTML ${htmlRenderizadoConNavegador ? 'renderizado con navegador' : 'del pedido simple'}, ${bloques.length} bloque(s) "div[data-hook=review]" encontrados, ${html.length} caracteres de HTML en total) — Testimonios va a usar reseñas inventadas por IA. Si el producto SÍ tiene reseñas visibles en Amazon, avisar a Norbey con el link para calibrar los selectores.` +
            (muestraDeAdentro
              ? ` Adentro del primer bloque (recortado a 1000 caracteres, para ajustar el selector de "review-body"): ${muestraDeAdentro}`
              : ''),
        );
      }
      return resenas;
    } catch (error) {
      this.logger.warn(
        `Product Marker: no se pudieron leer las reseñas reales de Amazon del HTML (${(error as Error).message || error}) — Testimonios va a usar reseñas inventadas por IA.`,
      );
      return [];
    }
  }

  // Convierte el texto de calificación de Amazon ("5.0 out of 5 stars" en
  // inglés, "5,0 de 5 estrellas" en español) a un número 1-5. Si no
  // reconoce el formato, devuelve undefined en vez de arriesgar un número
  // inventado (mismo criterio que normalizarCalificacionResena de AliExpress).
  private extraerCalificacionDeTextoAmazon(texto: string): number | undefined {
    const match = texto.match(/(\d+(?:[.,]\d+)?)\s*(?:out of|de)\s*5/i);
    if (!match) return undefined;
    const n = parseFloat(match[1].replace(',', '.'));
    if (!Number.isFinite(n)) return undefined;
    return Math.max(1, Math.min(5, Math.round(n)));
  }

  // ---------------------------------------------------------------------
  // Reseñas reales de TEMU con navegador headless (pedido 18/09 (6):
  // "quiero que las reseñas sean igual que con amazon y temu" — Norbey
  // eligió investigar este camino después de confirmar, vía búsqueda, que
  // Temu arma su lista de reseñas con JavaScript en el navegador y que no
  // se encontró ningún endpoint público equivalente al de AliExpress (ni
  // siquiera las herramientas de scraping de Temu que existen hoy en el
  // mercado extraen reseñas puntuales, solo el conteo total) — la única
  // forma real de leerlas es dejar que un navegador de verdad ejecute el
  // JavaScript de la página, algo que scrapearUrlProducto() (fetch simple)
  // no hace a propósito.
  //
  // AVISO IMPORTANTE, más fuerte que el resto de los "mejor esfuerzo" de
  // este archivo: a diferencia de Amazon (selectores confirmados por
  // investigación) y AliExpress (endpoint ya probado en producción por
  // Norbey), ACÁ los selectores de abajo son una heurística amplia
  // (cualquier bloque cuyo class/data-testid contenga "review"/"comment" y
  // tenga adentro un texto de largo razonable) — no se pudieron verificar
  // contra una página real de Temu porque ese dominio está bloqueado desde
  // este entorno. Es esperable que haga falta AL MENOS una vuelta de ajuste
  // real: si Norbey prueba con un producto que sí tiene reseñas visibles y
  // esto vuelve vacío, lo que hace falta es que me mande una captura de
  // pantalla de esa sección (o, mejor, el HTML de esa parte de la página,
  // clic derecho → Inspeccionar → Copiar → Copiar elemento) para afinar los
  // selectores acá — mismo patrón ya usado antes para confirmar el nombre
  // exacto del campo de fotos de AliExpress. A propósito esta primera
  // versión NO intenta adivinar selectores de autor/calificación (arriesgar
  // un nombre o una estrella de un elemento equivocado es peor que dejarlo
  // en blanco) — quedan en "Anónimo"/sin calificación, que ya son valores
  // seguros en todo el resto del archivo.
  //
  // Cuidados de infraestructura (Railway tiene memoria limitada — un
  // Chromium de verdad pesa bastante más que cualquier otra cosa que hace
  // este backend):
  //  - Actualizado 19/09: esto ya NO se usa solo para Temu — desde el fix
  //    de "pasa lo mismo con amazon"/"...para amazon y temu", scrapearUrlProducto()
  //    también abre este mismo navegador como último recurso para CUALQUIER
  //    plataforma cuando el pedido simple no encuentra título ni fotos
  //    (típicamente Amazon bloqueando el pedido, o Temu que siempre lo
  //    necesita). Sigue siendo el caso poco común — AliExpress y la mayoría
  //    de los productos de Amazon resuelven con el pedido simple y nunca
  //    llegan a abrir un Chromium.
  //  - navegadoresEnCurso/MAX_NAVEGADORES_CONCURRENTES: como mucho UN
  //    Chromium abierto a la vez en todo el servidor — si dos estudiantes
  //    importan al mismo tiempo y ambos necesitan el navegador, el segundo
  //    se queda sin este recurso (ver renderizarPaginaConNavegador) en vez
  //    de arriesgarse a abrir un segundo navegador y quedarse sin memoria
  //    en el contenedor.
  //  - NAVEGADOR_HEADLESS_TIMEOUT_MS: límite duro de tiempo — si la página
  //    tarda demasiado o el navegador se cuelga, se corta solo, nunca deja
  //    la importación completa esperando para siempre.
  //  - El navegador SIEMPRE se cierra (bloque finally), pase lo que pase.
  private navegadoresEnCurso = 0;
  private readonly MAX_NAVEGADORES_CONCURRENTES = 1;
  private readonly NAVEGADOR_HEADLESS_TIMEOUT_MS = 25000;

  // Abre un Chromium real, deja que renderice `url` con su JavaScript (ver
  // leerHtmlRenderizadoConNavegador) y devuelve el HTML resultante — usado
  // tanto por scrapearUrlProducto() (fallback de título/fotos, 19/09) como
  // por scrapearResenasTemuConNavegador() (reseñas de Temu, 18/09 (6)).
  // Tira una excepción si no se pudo (sin cupo de concurrencia, timeout, o
  // cualquier error de Puppeteer) — cada llamador decide qué hacer con eso.
  private async renderizarPaginaConNavegador(url: string): Promise<string> {
    if (this.navegadoresEnCurso >= this.MAX_NAVEGADORES_CONCURRENTES) {
      throw new Error('ya hay un navegador headless en curso en el servidor — se salta para no abrir un segundo Chromium');
    }
    this.navegadoresEnCurso++;
    let browser: Browser | null = null;
    let timeoutId: NodeJS.Timeout | undefined;
    try {
      browser = await puppeteer.launch({
        headless: true,
        // Flags necesarios para correr Chromium dentro de un contenedor de
        // Railway sin sandbox de kernel propio — ver nixpacks.toml.
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        ignoreDefaultArgs: ['--disable-extensions'],
      });
      const b = browser;
      return await new Promise<string>((resolve, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('tiempo de espera agotado leyendo la página con el navegador')),
          this.NAVEGADOR_HEADLESS_TIMEOUT_MS,
        );
        this.leerHtmlRenderizadoConNavegador(b, url).then(resolve, reject);
      });
    } finally {
      clearTimeout(timeoutId);
      if (browser) await browser.close().catch(() => {});
      this.navegadoresEnCurso--;
    }
  }

  private async scrapearResenasTemuConNavegador(url: string): Promise<ResenaOrigen[]> {
    try {
      const html = await this.renderizarPaginaConNavegador(url);
      return this.extraerResenasHeuristicasDelHtmlRenderizado(html);
    } catch (error) {
      this.logger.warn(
        `Product Marker: no se pudieron leer las reseñas reales de Temu con el navegador headless (${(error as Error).message || error}) — Testimonios va a usar reseñas inventadas por IA.`,
      );
      return [];
    }
  }

  // Abre la página de verdad, deja correr su JavaScript, intenta (sin
  // garantías) hacer clic en una pestaña/sección de reseñas si existe como
  // elemento aparte, y hace scroll varias veces para disparar la carga
  // perezosa de la lista — devuelve el HTML ya renderizado. Nació pensada
  // solo para Temu (de ahí el intento de abrir reseñas), pero desde 19/09
  // también la usa scrapearUrlProducto() como fallback de título/fotos para
  // cualquier plataforma — el intento de clic en "reseñas" no molesta ahí,
  // simplemente no encuentra nada para clickear y sigue de largo.
  // Fix 20/09: confirmado con un caso real (log de Railway) que Amazon le
  // muestra al navegador headless una página genérica "Amazon.com" sin
  // ninguna foto — la firma típica de una pantalla de verificación anti-bot
  // ("¿sos un robot?"), no del producto de verdad. Un Chromium manejado por
  // Puppeteer "de fábrica" deja pistas fáciles de detectar para cualquier
  // sitio con un anti-bot medianamente serio (navigator.webdriver en true,
  // falta de navigator.plugins/window.chrome que sí tiene un Chrome de
  // verdad, etc.) — estos son los parches más conocidos y livianos para
  // disimular eso, SIN agregar ninguna librería nueva a package.json.
  // Aviso importante: esto es un intento razonable, no una garantía —
  // Amazon en particular es agresivo detectando esto por varios lados a la
  // vez (huella del navegador, comportamiento, posiblemente hasta la IP del
  // servidor de Railway) y puede seguir bloqueando igual. Si después de
  // este cambio Amazon sigue devolviendo la misma pantalla genérica, hace
  // falta algo más caro (ej. un servicio de proxies de verdad) — no alcanza
  // con más parches de este estilo.
  private async aplicarSigilosBasicos(page: any): Promise<void> {
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      if (!window.chrome) window.chrome = { runtime: {} };
      Object.defineProperty(navigator, 'languages', { get: () => ['es-ES', 'es', 'en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    });
  }

  private async leerHtmlRenderizadoConNavegador(browser: Browser, url: string): Promise<string> {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    );
    await page.setViewport({ width: 1280, height: 1600 });
    await this.aplicarSigilosBasicos(page);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: this.NAVEGADOR_HEADLESS_TIMEOUT_MS });

    try {
      await page.evaluate(() => {
        const patron = /reseñas|resenas|reviews|opiniones|valoraciones/i;
        const esCandidato = (el: any) => patron.test(el.textContent || '') && (el.textContent || '').length < 40;
        // Tipado explícito "any[]" a propósito: Array.from() sobre un valor
        // "any" (document acá es "any", ver la declaración arriba del
        // archivo) infiere "unknown[]" en vez de "any[]" — sin esto,
        // ".click()" más abajo no compila.
        //
        // Primero se busca SOLO entre elementos realmente clicables
        // (a/button/role=tab/role=button) — si se buscara directo entre
        // div/span, un <div> contenedor que ENVUELVE al botón real también
        // matchea el mismo texto y aparece antes en el orden del documento
        // (padre antes que hijo), así que .find() agarraría ese div en vez
        // del botón de verdad y el clic no haría nada. Recién si no hay
        // ningún elemento interactivo que matchee, se prueba con
        // div/span como último recurso.
        const interactivos: any[] = Array.from(document.querySelectorAll('a, button, [role="tab"], [role="button"]'));
        let posible = interactivos.find(esCandidato);
        if (!posible) {
          const genericos: any[] = Array.from(document.querySelectorAll('div, span'));
          posible = genericos.find(esCandidato);
        }
        if (posible) posible.click();
      });
    } catch {
      // No pasa nada si no encontró ninguna pestaña/sección para hacer clic
      // — muchos productos ya muestran las reseñas sin necesitar esto.
    }

    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await new Promise((r) => setTimeout(r, 500));
    }

    return page.content();
  }

  // Heurística amplia (ver el aviso grande arriba sobre por qué no son
  // selectores confirmados): cualquier bloque cuyo class o data-testid
  // contenga "review"/"comment", con un texto adentro de largo razonable
  // (ni tan corto como para ser solo un botón de la interfaz, ni tan largo
  // como para ser el contenedor de TODA la lista junta) y con suficiente
  // proporción de letras (para descartar líneas de resumen tipo "4.6 de 5 -
  // 128 reseñas", que matchean por clase pero no son una reseña de
  // verdad). Se queda con el elemento MÁS EXTERNO de cada grupo anidado —
  // ej. un `<div class="review-card">` que por dentro tiene un
  // `<span class="review-text">` — ambos matchean el selector, pero son la
  // MISMA reseña; probado con un caso sintético parecido a esto que sin
  // este cuidado duplicaba cada reseña.
  private extraerResenasHeuristicasDelHtmlRenderizado(html: string): ResenaOrigen[] {
    const $ = cheerio.load(html);
    const candidatos = $('[class*="review" i], [data-testid*="review" i], [class*="comment" i]');
    const aceptados: any[] = [];
    const resenas: ResenaOrigen[] = [];
    candidatos.each((_, el) => {
      const $el = $(el);
      // Si un ancestro de este elemento ya fue aceptado como reseña, este
      // es solo una sub-parte de esa misma reseña (ver comentario arriba).
      const yaCubiertoPorUnAncestro = $el
        .parents()
        .toArray()
        .some((ancestro) => aceptados.includes(ancestro));
      if (yaCubiertoPorUnAncestro) return;

      const texto = $el
        .clone()
        .find('img, button, svg, script, style')
        .remove()
        .end()
        .text()
        .replace(/\s+/g, ' ')
        .trim();
      if (texto.length < 15 || texto.length > 1500) return;
      // Proporción de letras sobre el total SIN contar espacios (incluye
      // tildes/ñ) — descarta líneas que son más número/símbolo que palabra
      // (resúmenes de calificación tipo "4.6 de 5 - 128 reseñas", precios,
      // contadores), que suelen quedar atrapadas por el mismo selector.
      // Contar los espacios como "letra" de más (como en una primera
      // versión de este filtro) dejaba pasar ese mismo ejemplo por poco —
      // probado con un caso sintético parecido antes de este ajuste.
      const sinEspacios = texto.replace(/\s+/g, '');
      const soloLetras = sinEspacios.replace(/[^a-zA-ZÀ-ÿ]/g, '');
      if (sinEspacios.length === 0 || soloLetras.length < sinEspacios.length * 0.7) return;

      aceptados.push(el);
      const fotos = $el
        .find('img')
        .map((__, img) => $(img).attr('src'))
        .get()
        .filter((src): src is string => !!src && !/icon|sprite|logo/i.test(src))
        .slice(0, 5);
      // Autor y calificación quedan sin completar a propósito acá (ver
      // aviso grande arriba) — filtrarYOrdenarResenasPositivas ya sabe
      // tratar una calificación undefined como "la dejo pasar".
      resenas.push({ texto, fotos, fotoUrl: fotos[0] });
    });
    // Margen extra sobre MAX_RESENAS_REALES: como esta heurística puede
    // traer algún falso positivo, se recorta más adelante en el mismo lugar
    // donde ya se recorta AliExpress/Amazon (filtrarYOrdenarResenasPositivas).
    return resenas.slice(0, this.MAX_RESENAS_REALES * 2);
  }

  // Filtro/orden compartido: lo usa tanto pilotoAutomatico() al armar la
  // landing como el módulo Product Marker del taller al mostrarle al
  // estudiante, ANTES de generar, exactamente las reseñas que se van a usar
  // (pedido 18/09) — mismo criterio de siempre (16/09): solo positivas (se
  // descartan las que sí trajeron una calificación detectada y es menor a 4
  // estrellas; si no se pudo detectar la calificación, se deja pasar),
  // ordenadas de mejor a peor.
  private filtrarYOrdenarResenasPositivas(resenas: ResenaOrigen[]): ResenaOrigen[] {
    return (resenas || [])
      .filter((r) => r && r.texto && r.texto.trim().length > 5)
      .filter((r) => r.calificacion === undefined || r.calificacion >= 4)
      .sort((a, b) => (b.calificacion ?? 4) - (a.calificacion ?? 4));
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
    const resenasReales = this.filtrarYOrdenarResenasPositivas(input.resenas || []);

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

    // Pedido 18/09: si el estudiante completó a mano el precio de 1 unidad en
    // el módulo Product Marker, esos precios (y sus comparaciones, y los
    // combos de 2/3 unidades si los llenó) reemplazan al precio sugerido
    // automático de arriba. Si no tocó nada, sigue igual que siempre.
    const ofertaManual = input.ofertaManual;
    const oferta = ofertaManual?.precio1Venta
      ? {
          precio1Venta: ofertaManual.precio1Venta,
          precio1Comparacion: ofertaManual.precio1Comparacion || undefined,
          precio2Venta: ofertaManual.precio2Venta || undefined,
          precio2Comparacion: ofertaManual.precio2Comparacion || undefined,
          precio3Venta: ofertaManual.precio3Venta || undefined,
          precio3Comparacion: ofertaManual.precio3Comparacion || undefined,
          divisa: moneda,
        }
      : precioSugerido
        ? { precio1Venta: precioSugerido, divisa: moneda }
        : undefined;
    const precioSugeridoFinal = oferta?.precio1Venta;

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
      oferta,
    };

    // 5) Genera cada sección del combo automático, en orden, reutilizando la
    // misma foto principal ya resuelta — cada llamada ya guarda su propio
    // historial (ver ImageEditService.generarSeccion → historialService.guardar()).
    const items: ItemLanding[] = [];
    let costoEstimadoUsd = 0;
    const seccionesOk: string[] = [];

    for (const seccion of this.SECCIONES_AUTOMATICAS) {
      try {
        // Testimonios con reseñas reales (pedido 18/09, 2): en vez de una
        // imagen fija, se guardan como reseñas de VERDAD del producto y se
        // intercala el marcador {tipo:'resenas'} — ver la nota grande de
        // armarResenasLandingDesdeReales arriba sobre por qué (cada foto
        // ahora se puede abrir en grande con un clic, algo imposible con
        // una imagen ya compuesta). NO se le pide a la IA de imagen que
        // invente nada acá — texto, calificación y fotos son las reales.
        if (seccion === 'testimonios' && resenasReales.length > 0) {
          const resenasLanding = await this.armarResenasLandingDesdeReales(falClient, resenasReales);
          if (resenasLanding.length > 0) {
            await this.productosService.guardarResenas(usuarioId, nombreProducto, 'personalizada', resenasLanding);
            seccionesOk.push(seccion);
            items.push({ id: `resenas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, tipo: 'resenas' });
          }
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
      precioSugerido: precioSugeridoFinal,
      secciones: seccionesOk,
      costoEstimadoUsd,
      landingGuardada: !!landingGuardada,
    };
  }
}
