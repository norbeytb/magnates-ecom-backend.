// shopify.service.ts
//
// Publica una landing ensamblada (una lista de imágenes ya generadas) como
// una Página (Page) en la tienda de Shopify del cliente, usando la Admin API.
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
// Reenviar la misma landing (mismo producto + mismo número de landing) actualiza
// la página ya creada en vez de duplicarla: se identifica por un "handle" fijo.

import { Injectable, Logger } from '@nestjs/common';

export interface PublicarLandingInput {
  nombreProducto: string;
  landingNum: number;
  imagenes: string[];
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

  private slugify(texto: string): string {
    return (texto || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'producto';
  }

  private construirHtml(imagenes: string[]): string {
    const imgsHtml = imagenes
      .map((url) => `<img src="${url}" alt="" style="width:100%; max-width:480px; display:block; margin:0 auto;">`)
      .join('\n');
    return `<div style="max-width:480px; margin:0 auto;">\n${imgsHtml}\n</div>`;
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
    const headers = await this.headers();

    // Busca si ya existe una página con este handle, para actualizarla en vez de duplicar.
    const buscar = await fetch(`${this.baseUrl()}/pages.json?handle=${encodeURIComponent(handle)}&limit=1`, {
      headers,
    });
    if (!buscar.ok) {
      throw new Error(`No se pudo consultar Shopify (HTTP ${buscar.status}): ${await buscar.text()}`);
    }
    const buscarJson: any = await buscar.json();
    const existente = buscarJson?.pages?.[0];

    if (existente) {
      const actualizar = await fetch(`${this.baseUrl()}/pages/${existente.id}.json`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ page: { id: existente.id, title: titulo, body_html: bodyHtml, published: true } }),
      });
      if (!actualizar.ok) {
        throw new Error(`No se pudo actualizar la página en Shopify (HTTP ${actualizar.status}): ${await actualizar.text()}`);
      }
      const json: any = await actualizar.json();
      this.logger.log(`Página de Shopify actualizada: ${json.page.handle}`);
      return { url: `https://${process.env.SHOPIFY_STORE_DOMAIN}/pages/${json.page.handle}`, handle: json.page.handle, creada: false };
    }

    const crear = await fetch(`${this.baseUrl()}/pages.json`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ page: { title: titulo, handle, body_html: bodyHtml, published: true } }),
    });
    if (!crear.ok) {
      throw new Error(`No se pudo crear la página en Shopify (HTTP ${crear.status}): ${await crear.text()}`);
    }
    const json: any = await crear.json();
    this.logger.log(`Página de Shopify creada: ${json.page.handle}`);
    return { url: `https://${process.env.SHOPIFY_STORE_DOMAIN}/pages/${json.page.handle}`, handle: json.page.handle, creada: true };
  }
}
