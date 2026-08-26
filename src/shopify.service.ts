// shopify.service.ts
//
// Publica una landing ensamblada (una lista de imágenes ya generadas) como un
// PRODUCTO en la tienda de Shopify del cliente, usando la Admin API: todas
// las imágenes de la landing quedan dentro de la descripción del producto
// (apiladas como banners) Y TAMBIÉN se suben a la Multimedia/galería del
// producto (para carrito, correos de pedido y catálogo). Se usa siempre la
// plantilla de producto NORMAL de cada tienda — sin plantillas alternas ni
// tocar el tema — para que esto funcione igual en la tienda de cualquier
// estudiante sin que tenga que configurar nada. El precio se toma de la
// Ficha Técnica (Oferta → Precio 1) que el usuario ya llenó en el taller.
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
// La app en el Dev Dashboard necesita los alcances (scopes): read_products,write_products
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
    return `<div style="width:100%; margin:0; padding:0; line-height:0; font-size:0;">${imgsHtml}</div>`;
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

    const handle = `landing-${this.slugify(input.nombreProducto)}-${input.landingNum || 1}`;
    const titulo = `${input.nombreProducto} — Landing ${input.landingNum || 1}`;
    const bodyHtml = this.construirHtml(input.imagenes);
    // Todas las imágenes van también a la Multimedia del producto (galería
    // nativa), además de estar apiladas dentro de la descripción.
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
            // Vuelve a la plantilla normal del tema por si el producto se
            // había quedado con una plantilla alterna de una prueba anterior.
            template_suffix: null,
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
