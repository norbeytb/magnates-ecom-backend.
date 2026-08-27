// shopify.service.ts
//
// Publica una landing ensamblada (una lista de imágenes ya generadas) como un
// PRODUCTO en la tienda de Shopify del cliente, usando la Admin API. Todas
// las imágenes suben a la Multimedia del producto, y ADEMÁS este backend le
// prepara automáticamente al tema del cliente una plantilla alterna
// "landing" con una sección propia que dibuja esas mismas imágenes una
// debajo de otra, a pantalla completa (sin título/precio/reseñas encima) —
// ver asegurarPlantillaLanding() más abajo. Esto es lo mismo que hacen otras
// herramientas de landings: le agregan al tema su propia sección al
// instalarse, en vez de depender del bloque de "Descripción" del tema (que
// en muchos temas nuevos —como el tema Horizon del cliente— usa un campo de
// tipo "richtext" que no acepta imágenes sueltas). Esa preparación del tema
// se hace UNA sola vez por tienda (revisa si ya existe antes de crear nada)
// y no requiere que el estudiante toque el editor del tema. El precio se
// toma de la Ficha Técnica (Oferta → Precio 1) que el usuario ya llenó en
// el taller.
//
// Shopify cambió su forma de dar acceso: ya no se puede crear una app
// personalizada directamente en el admin y copiar un token fijo (shpat_...).
// Ahora las apps se crean en el Dev Dashboard (dev.shopify.com/dashboard) y
// dan un Client ID + Client secret, que este backend intercambia por un
// access token de corta duración (24h) cada vez que lo necesita — ver
// obtenerAccessToken() más abajo. El token se guarda en memoria y se
// reutiliza hasta que esté por vencer, así no se pide uno nuevo en cada
// publicación.
//
// Necesita 3 variables de entorno en Railway (nunca se exponen al frontend):
//   SHOPIFY_STORE_DOMAIN    -> ej: mitienda.myshopify.com
//   SHOPIFY_CLIENT_ID       -> Client ID de la app, desde Dev Dashboard → tu app → Configuración
//   SHOPIFY_CLIENT_SECRET   -> Client secret de la misma pantalla
//
// La app en el Dev Dashboard necesita los alcances (scopes):
//   read_products,write_products,read_themes,write_themes
// (los dos últimos son para poder crearle al tema la plantilla/sección
// automática de la landing — ver asegurarPlantillaLanding()).
//
// Reenviar la misma landing (mismo producto + mismo número de landing) actualiza
// el producto ya creado en vez de duplicarlo: se identifica por un "handle" fijo.

import { Injectable, Logger } from '@nestjs/common';

export interface PublicarLandingInput {
  nombreProducto: string;
  landingNum: number;
  imagenes: string[];
  precio?: string | number;
  precioComparacion?: string | number;
}

export interface PublicarLandingResultado {
  url: string;
  handle: string;
  creada: boolean;
}

interface TokenEnCache {
  token: string;
  expiraEn: number; // timestamp epoch ms
}

@Injectable()
export class ShopifyService {
  private readonly logger = new Logger(ShopifyService.name);
  private readonly apiVersion = '2026-07';
  private tokenEnCache: TokenEnCache | null = null;

  private configurado(): boolean {
    return !!(process.env.SHOPIFY_STORE_DOMAIN && process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET);
  }

  private baseUrl(): string {
    return `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${this.apiVersion}`;
  }

  // Intercambia Client ID + Client secret por un access token (Client Credentials
  // Grant). Los tokens de Shopify duran 24h — se cachea y se renueva 1 minuto
  // antes de vencer para no pedir uno nuevo en cada llamada.
  private async obtenerAccessToken(): Promise<string> {
    const ahora = Date.now();
    if (this.tokenEnCache && this.tokenEnCache.expiraEn > ahora + 60_000) {
      return this.tokenEnCache.token;
    }

    const resp = await fetch(`https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.SHOPIFY_CLIENT_ID as string,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET as string,
      }).toString(),
    });
    if (!resp.ok) {
      throw new Error(
        `No se pudo autenticar con Shopify (HTTP ${resp.status}): ${await resp.text()}. Revisa que la app esté instalada en la tienda y que el Client ID/secret sean correctos.`,
      );
    }
    const json: any = await resp.json();
    const expiraSegundos = typeof json.expires_in === 'number' ? json.expires_in : 23 * 60 * 60;
    this.tokenEnCache = { token: json.access_token, expiraEn: ahora + expiraSegundos * 1000 };
    return this.tokenEnCache.token;
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.obtenerAccessToken();
    return {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    };
  }

  // Llama a la Admin API con el token cacheado. Si Shopify responde 401 (token
  // inválido — por ejemplo porque la app se reinstaló o el secreto se rotó
  // después de haber cacheado un token), descarta el token en memoria y
  // reintenta UNA vez con uno recién pedido, para que el usuario no tenga que
  // reiniciar el backend a mano cada vez que eso pase.
  private async llamarShopify(path: string, opciones: RequestInit = {}, reintentando = false): Promise<Response> {
    const headers = await this.headers();
    const resp = await fetch(`${this.baseUrl()}${path}`, { ...opciones, headers: { ...headers, ...(opciones.headers as Record<string, string> | undefined) } });
    if (resp.status === 401 && !reintentando) {
      this.tokenEnCache = null;
      return this.llamarShopify(path, opciones, true);
    }
    return resp;
  }

  // ---------- Preparación automática del tema (plantilla "landing") ----------

  // Busca el tema activo/publicado de la tienda (el que ven los clientes).
  private async obtenerTemaActivoId(): Promise<number> {
    const resp = await this.llamarShopify('/themes.json');
    if (!resp.ok) {
      throw new Error(`No se pudo listar los temas de la tienda (HTTP ${resp.status}): ${await resp.text()}`);
    }
    const json: any = await resp.json();
    const activo = (json.themes || []).find((t: any) => t.role === 'main');
    if (!activo) {
      throw new Error('No se encontró el tema activo (publicado) de la tienda.');
    }
    return activo.id;
  }

  // Lee un archivo del tema (por ejemplo "templates/product.json"). Devuelve
  // null si el archivo no existe todavía (para poder crearlo).
  private async obtenerAsset(temaId: number, key: string): Promise<string | null> {
    const resp = await this.llamarShopify(`/themes/${temaId}/assets.json?asset[key]=${encodeURIComponent(key)}`);
    if (resp.status === 404) return null;
    if (!resp.ok) {
      throw new Error(`No se pudo leer "${key}" del tema (HTTP ${resp.status}): ${await resp.text()}`);
    }
    const json: any = await resp.json();
    return typeof json?.asset?.value === 'string' ? json.asset.value : null;
  }

  // Crea o sobrescribe un archivo del tema.
  private async guardarAsset(temaId: number, key: string, value: string): Promise<void> {
    const resp = await this.llamarShopify(`/themes/${temaId}/assets.json`, {
      method: 'PUT',
      body: JSON.stringify({ asset: { key, value } }),
    });
    if (!resp.ok) {
      throw new Error(`No se pudo guardar "${key}" en el tema (HTTP ${resp.status}): ${await resp.text()}`);
    }
  }

  // Código de la sección nueva del tema: dibuja TODAS las imágenes del
  // producto (product.images, la misma Multimedia que sube este backend)
  // apiladas una debajo de otra, a pantalla completa. No depende del bloque
  // de Descripción ni de ningún campo tipo "richtext" del tema.
  private readonly seccionLandingLiquid = [
    '{%- comment -%}',
    '  Sección creada automáticamente por Ecom Magnates: dibuja las imágenes',
    '  del producto (Multimedia) apiladas a pantalla completa. No editar a mano,',
    '  se sobrescribe si el backend la vuelve a necesitar.',
    '{%- endcomment -%}',
    '<div style="width:100%; margin:0; padding:0; line-height:0; font-size:0;">',
    '  {%- for image in product.images -%}',
    '    <img',
    '      src="{{ image | image_url: width: 1500 }}"',
    '      alt="{{ image.alt | default: product.title | escape }}"',
    '      loading="lazy"',
    '      style="display:block; width:100%; margin:0; padding:0; border:0;"',
    '    >',
    '  {%- endfor -%}',
    '</div>',
    '',
    '{% schema %}',
    '{',
    '  "name": "Landing a pantalla completa",',
    '  "settings": [],',
    '  "presets": [{ "name": "Landing a pantalla completa" }]',
    '}',
    '{% endschema %}',
    '',
  ].join('\n');

  // Se asegura de que el tema activo tenga la sección y la plantilla alterna
  // "landing" necesarias — las crea solo si todavía no existen (no toca nada
  // si ya estaban, y nunca modifica la plantilla NORMAL de producto, así que
  // el resto del catálogo del cliente no se ve afectado). Si algo falla acá
  // (por ejemplo, el permiso de temas todavía no está activo), no debe
  // tumbar la publicación del producto — solo queda sin la plantilla especial
  // por esta vez.
  private async asegurarPlantillaLanding(): Promise<void> {
    try {
      const temaId = await this.obtenerTemaActivoId();

      const seccionExistente = await this.obtenerAsset(temaId, 'sections/landing-imagenes.liquid');
      if (seccionExistente === null) {
        await this.guardarAsset(temaId, 'sections/landing-imagenes.liquid', this.seccionLandingLiquid);
        this.logger.log('Sección "landing-imagenes" creada en el tema.');
      }

      const plantillaExistente = await this.obtenerAsset(temaId, 'templates/product.landing.json');
      if (plantillaExistente === null) {
        const baseTexto = await this.obtenerAsset(temaId, 'templates/product.json');
        const base = baseTexto ? JSON.parse(baseTexto) : { sections: {}, order: [] };
        base.sections = base.sections || {};
        base.order = Array.isArray(base.order) ? base.order : [];
        base.sections['landing_imagenes_auto'] = { type: 'landing-imagenes' };
        base.order = ['landing_imagenes_auto', ...base.order.filter((k: string) => k !== 'landing_imagenes_auto')];
        await this.guardarAsset(temaId, 'templates/product.landing.json', JSON.stringify(base, null, 2));
        this.logger.log('Plantilla "product.landing.json" creada en el tema.');
      }
    } catch (err) {
      this.logger.warn(`No se pudo preparar la plantilla "landing" del tema (se sigue publicando el producto igual): ${(err as Error).message}`);
    }
  }

  private slugify(texto: string): string {
    return (texto || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'producto';
  }

  // Las imágenes van una debajo de otra, llenando el 100% del ancho del
  // bloque donde el tema las dibuje ("Product description"), sin espacios ni
  // recortes entre ellas. Antes se usaba un truco de "width:100vw" con
  // márgenes negativos para forzar ancho de pantalla completa saliéndose del
  // contenedor del tema, pero en el tema del cliente ese contenedor recorta
  // (overflow) lo que se sale de su caja, así que el truco dejaba las
  // imágenes invisibles en vez de a pantalla completa. Con 100% (sin salirse
  // del contenedor) las imágenes se ven siempre, y quedan tan anchas como
  // permita esa sección del tema — que en temas pensados para landings
  // suele ser ya el ancho completo de la página.
  private construirHtml(imagenes: string[]): string {
    const imgsHtml = imagenes
      .map((url) => `<img src="${url}" alt="" style="display:block; width:100%; margin:0; padding:0; border:0;">`)
      .join('');
    // Ojo: si la Descripción no tiene NINGÚN texto (solo imágenes), varios
    // temas la consideran "vacía" (revisan el texto plano, sin las etiquetas
    // HTML) y esconden todo el bloque, aunque sí tenga imágenes — así se veía
    // en el tema del cliente. Por eso se agrega un textito real al principio:
    // como el div que lo envuelve ya tiene font-size:0, ese texto queda
    // invisible en pantalla, pero sigue contando como "hay texto" para que
    // el tema no oculte el bloque completo.
    return `<div style="width:100%; margin:0; padding:0; line-height:0; font-size:0;"><span>Landing</span>${imgsHtml}</div>`;
  }

  // Precio principal del producto: siempre devuelve un número válido en texto
  // (Shopify requiere un precio en la variante); si no hay dato usable, cae en "0.00".
  private normalizarPrecio(valor?: string | number): string {
    const n = typeof valor === 'number' ? valor : parseFloat(String(valor ?? '').replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n.toFixed(2) : '0.00';
  }

  // Precio de comparación (el tachado): opcional, se omite si no viene un número válido.
  private normalizarPrecioOpcional(valor?: string | number): string | undefined {
    const n = typeof valor === 'number' ? valor : parseFloat(String(valor ?? '').replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n.toFixed(2) : undefined;
  }

  async publicarLanding(input: PublicarLandingInput): Promise<PublicarLandingResultado> {
    if (!this.configurado()) {
      throw new Error(
        'Shopify no está configurado en este backend (faltan SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID y/o SHOPIFY_CLIENT_SECRET en las variables de entorno de Railway).',
      );
    }
    if (!input?.imagenes || input.imagenes.length === 0) {
      throw new Error('La landing no tiene imágenes para publicar.');
    }
    if (!input.nombreProducto) {
      throw new Error('Falta el nombre del producto.');
    }

    // Se asegura (una sola vez por tienda) de que el tema tenga la plantilla
    // alterna "landing" lista, antes de crear/actualizar el producto.
    await this.asegurarPlantillaLanding();

    const handle = `landing-${this.slugify(input.nombreProducto)}-${input.landingNum || 1}`;
    const titulo = `${input.nombreProducto} — Landing ${input.landingNum || 1}`;
    const bodyHtml = this.construirHtml(input.imagenes);
    // Todas las imágenes van a la Multimedia del producto (galería nativa) —
    // de ahí las toma también la sección automática "landing-imagenes" para
    // dibujarlas a pantalla completa. También quedan apiladas dentro de la
    // descripción como respaldo, por si el tema no soporta la plantilla
    // alterna.
    const images = input.imagenes.map((src) => ({ src }));
    const precio = this.normalizarPrecio(input.precio);
    const precioComparacion = this.normalizarPrecioOpcional(input.precioComparacion);

    // Busca si ya existe un producto con este handle, para actualizarlo en vez de duplicar.
    const buscar = await this.llamarShopify(`/products.json?handle=${encodeURIComponent(handle)}&limit=1`);
    if (!buscar.ok) {
      throw new Error(`No se pudo consultar Shopify (HTTP ${buscar.status}): ${await buscar.text()}`);
    }
    const buscarJson: any = await buscar.json();
    const existente = buscarJson?.products?.[0];

    if (existente) {
      const varianteId = existente.variants?.[0]?.id;
      const actualizar = await this.llamarShopify(`/products/${existente.id}.json`, {
        method: 'PUT',
        body: JSON.stringify({
          product: {
            id: existente.id,
            title: titulo,
            body_html: bodyHtml,
            images,
            status: 'active',
            // Usa la plantilla alterna "landing" (creada automáticamente
            // arriba) para que se vea a pantalla completa.
            template_suffix: 'landing',
            variants: varianteId ? [{ id: varianteId, price: precio, compare_at_price: precioComparacion ?? null }] : undefined,
          },
        }),
      });
      if (!actualizar.ok) {
        throw new Error(`No se pudo actualizar el producto en Shopify (HTTP ${actualizar.status}): ${await actualizar.text()}`);
      }
      const json: any = await actualizar.json();
      this.logger.log(`Producto de Shopify actualizado: ${json.product.handle}`);
      return { url: `https://${process.env.SHOPIFY_STORE_DOMAIN}/products/${json.product.handle}`, handle: json.product.handle, creada: false };
    }

    const crear = await this.llamarShopify('/products.json', {
      method: 'POST',
      body: JSON.stringify({
        product: {
          title: titulo,
          handle,
          body_html: bodyHtml,
          images,
          status: 'active',
          template_suffix: 'landing',
          variants: [{ price: precio, compare_at_price: precioComparacion ?? null }],
        },
      }),
    });
    if (!crear.ok) {
      throw new Error(`No se pudo crear el producto en Shopify (HTTP ${crear.status}): ${await crear.text()}`);
    }
    const json: any = await crear.json();
    this.logger.log(`Producto de Shopify creado: ${json.product.handle}`);
    return { url: `https://${process.env.SHOPIFY_STORE_DOMAIN}/products/${json.product.handle}`, handle: json.product.handle, creada: true };
  }
}
