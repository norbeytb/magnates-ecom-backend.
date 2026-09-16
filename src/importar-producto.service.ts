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
//  - Testimonios: se genera como UNA sección más (modo "Plantilla" — 2-3
//    reseñas dentro de una sola imagen, ver ETIQUETAS_SECCION en
//    image-edit.service.ts), no el modo "Personalizada" (que necesita una
//    foto real subida por el estudiante para cada reseña, algo que acá no
//    existe todavía).
//  - Fotos de origen: las fotos que trae el scraping son URLs externas del
//    sitio de origen (CDN de AliExpress/Amazon/Temu), que pueden tener
//    protección contra hotlinking o vencer con el tiempo. Antes de usarlas
//    para generar cualquier sección, se descargan UNA vez y se resuben al
//    storage de fal.ai (mismo mecanismo que ya usa resolverImagenUrl() en
//    ImageEditService para fotos base64) — así queda una copia propia y
//    estable, independiente del sitio de origen.

import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { createFalClient, FalClient } from '@fal-ai/client';
import { ImageEditService, FichaTecnica } from './image-edit.service';
import { TextGenerationService } from './text-generation.service';
import { ProductosService } from './productos.service';
import { LandingsService, ItemLanding } from './landings.service';

export type PlataformaOrigen = 'aliexpress' | 'amazon' | 'temu';

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
  private readonly SECCIONES_AUTOMATICAS: string[] = ['hero', 'beneficios', 'oferta', 'testimonios', 'faq'];

  private readonly ETIQUETAS_SECCION: Record<string, string> = {
    hero: 'Hero (portada / titular principal)',
    beneficios: 'Beneficios',
    oferta: 'Oferta y Precios',
    testimonios: 'Testimonios',
    faq: 'Preguntas Frecuentes',
  };

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
    let resp: Response;
    try {
      resp = await fetch(urlExterna);
    } catch {
      throw new InternalServerErrorException(
        'No se pudo descargar la foto del producto desde la página de origen — probá con otra foto o volvé a intentar.',
      );
    }
    if (!resp.ok) {
      throw new InternalServerErrorException(
        `La página de origen no dejó descargar la foto del producto (código ${resp.status}).`,
      );
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    const contentType = resp.headers.get('content-type') || 'image/jpeg';
    const blob = new Blob([buffer], { type: contentType });
    return falClient.storage.upload(blob);
  }

  private formatearPrecio(valor: number, moneda: string): string {
    const simbolo = moneda === 'USD' ? '$' : '';
    return `${simbolo}${valor.toFixed(2)}${simbolo ? '' : ` ${moneda}`}`;
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
      `Piloto automático: "${nombreProducto}" importado desde ${input.plataforma} — ${seccionesOk.length}/${this.SECCIONES_AUTOMATICAS.length} secciones generadas, costo estimado $${costoEstimadoUsd.toFixed(3)}.`,
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
