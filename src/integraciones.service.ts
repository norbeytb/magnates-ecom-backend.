// integraciones.service.ts
//
// Cada usuario conecta acá SUS PROPIAS cuentas externas: su tienda de
// Shopify (para que "Enviar a Shopify" publique en SU tienda, no en una
// compartida) y su propia clave de fal.ai (para pagar sus propias imágenes
// y textos generados, en vez de compartir la cuenta del taller entre todos).
// Una fila por usuario. Mismo patrón de PostgreSQL que el resto de
// servicios — ver la nota grande de productos.service.ts sobre por qué no
// hay FK a "usuarios" (cada *.service.ts abre su propio Pool y crea su
// tabla en onModuleInit, sin garantía de orden entre ellos).
//
// Cómo consigue esto cada usuario:
//  - Shopify: crea una "app personalizada" en SU PROPIA tienda (Configuración
//    → Apps y canales de venta → Desarrollar apps → Crear una app), le da
//    permisos de lectura/escritura de productos (read_products,
//    write_products) y de publicaciones (read_publications,
//    write_publications), instala la app en su tienda, y copia el "Token de
//    acceso de API Admin" que empieza con shpat_ — eso es lo que pega en el
//    taller. Antes de guardarlo, este backend prueba ese token contra la
//    tienda (GET /shop.json) para avisar de una vez si algo está mal
//    escrito, en vez de que recién falle el día que intente publicar una
//    landing.
//  - fal.ai: crea su cuenta en fal.ai, carga créditos, y copia su clave
//    desde fal.ai/dashboard/keys — esa misma clave sirve tanto para generar
//    imágenes como texto (ver image-edit.service.ts y
//    text-generation.service.ts, que ahora la usan en vez de una clave
//    compartida del taller — el texto pasa a generarse también a través de
//    fal.ai, con un modelo de Claude, para que sea UNA sola clave y no dos).
//
// Los valores guardados (shopify_access_token, fal_api_key) NUNCA se
// devuelven completos al frontend después de guardados — solo si están
// configurados y los últimos 4 caracteres (ver enmascarar más abajo), así
// la persona reconoce cuál puso sin que quede expuesto en la pantalla ni en
// las herramientas del navegador.

import { ConflictException, Injectable, InternalServerErrorException, Logger, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';

export interface IntegracionesUsuario {
  shopifyStoreDomain?: string;
  shopifyConectado: boolean;
  shopifyTokenParcial?: string;
  falConectado: boolean;
  falKeyParcial?: string;
}

@Injectable()
export class IntegracionesService implements OnModuleInit {
  private readonly logger = new Logger(IntegracionesService.name);
  private pool: Pool | null = null;

  async onModuleInit() {
    if (!process.env.DATABASE_URL) {
      this.logger.warn('DATABASE_URL no está configurada — las integraciones no se van a guardar.');
      return;
    }
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS integraciones (
          usuario_id INTEGER PRIMARY KEY,
          shopify_store_domain TEXT,
          shopify_access_token TEXT,
          fal_api_key TEXT,
          actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      this.logger.log('Conectado a PostgreSQL — tabla "integraciones" lista.');
    } catch (error) {
      this.logger.error('No se pudo conectar/crear la tabla de integraciones: ' + (error as Error).message);
      this.pool = null;
    }
  }

  private ultimos4(valor?: string | null): string | undefined {
    if (!valor) return undefined;
    return valor.length > 4 ? '••••' + valor.slice(-4) : '••••';
  }

  private normalizarDominio(dominio: string): string {
    return String(dominio || '')
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .toLowerCase();
  }

  // Vista "segura" para el frontend — nunca incluye el token/clave completos.
  async obtener(usuarioId: number): Promise<IntegracionesUsuario> {
    if (!this.pool) {
      return { shopifyConectado: false, falConectado: false };
    }
    const resultado = await this.pool.query(
      `SELECT shopify_store_domain, shopify_access_token, fal_api_key FROM integraciones WHERE usuario_id = $1`,
      [usuarioId],
    );
    const fila = resultado.rows[0];
    if (!fila) {
      return { shopifyConectado: false, falConectado: false };
    }
    return {
      shopifyStoreDomain: fila.shopify_store_domain || undefined,
      shopifyConectado: !!(fila.shopify_store_domain && fila.shopify_access_token),
      shopifyTokenParcial: this.ultimos4(fila.shopify_access_token),
      falConectado: !!fila.fal_api_key,
      falKeyParcial: this.ultimos4(fila.fal_api_key),
    };
  }

  // ---------------- Uso interno (otros servicios) ----------------
  // A diferencia de obtener() de arriba, estos SÍ devuelven los valores
  // completos — los usan ShopifyService/ImageEditService/
  // TextGenerationService para llamar a Shopify/fal.ai en nombre del
  // usuario. Nunca deben propagarse tal cual en una respuesta HTTP.

  async obtenerCredencialesShopify(usuarioId: number): Promise<{ storeDomain: string; accessToken: string } | null> {
    if (!this.pool) return null;
    const resultado = await this.pool.query(
      `SELECT shopify_store_domain, shopify_access_token FROM integraciones WHERE usuario_id = $1`,
      [usuarioId],
    );
    const fila = resultado.rows[0];
    if (!fila || !fila.shopify_store_domain || !fila.shopify_access_token) return null;
    return { storeDomain: fila.shopify_store_domain, accessToken: fila.shopify_access_token };
  }

  async obtenerClaveFal(usuarioId: number): Promise<string | null> {
    if (!this.pool) return null;
    const resultado = await this.pool.query(`SELECT fal_api_key FROM integraciones WHERE usuario_id = $1`, [usuarioId]);
    return resultado.rows[0]?.fal_api_key || null;
  }

  // ---------------- Shopify ----------------

  async guardarShopify(usuarioId: number, storeDomainCrudo: string, accessTokenCrudo: string): Promise<IntegracionesUsuario> {
    if (!this.pool) {
      throw new InternalServerErrorException('No se pudo guardar: falta configurar la base de datos en el backend.');
    }
    const storeDomain = this.normalizarDominio(storeDomainCrudo);
    if (!storeDomain || !storeDomain.includes('.')) {
      throw new ConflictException('Ese dominio de tienda no parece válido. Ejemplo: mitienda.myshopify.com');
    }
    const accessToken = String(accessTokenCrudo || '').trim();
    if (!accessToken || accessToken.length < 10) {
      throw new ConflictException('Ese token de Shopify no parece válido.');
    }

    // Prueba real contra la tienda ANTES de guardar — así se avisa de una
    // vez si el dominio o el token están mal, en vez de que recién falle el
    // día que la persona intente publicar una landing.
    let resp: Response;
    try {
      resp = await fetch(`https://${storeDomain}/admin/api/2026-07/shop.json`, {
        headers: { 'X-Shopify-Access-Token': accessToken },
      });
    } catch {
      throw new ConflictException('No se pudo conectar con esa tienda de Shopify — revisá el dominio (debe terminar en .myshopify.com) y probá de nuevo.');
    }
    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) {
        throw new ConflictException('Shopify rechazó ese token — revisá que lo hayas copiado completo y que la app tenga permisos de productos.');
      }
      throw new ConflictException('No se pudo confirmar la tienda con Shopify — revisá el dominio (debe terminar en .myshopify.com).');
    }

    await this.pool.query(
      `INSERT INTO integraciones (usuario_id, shopify_store_domain, shopify_access_token, actualizado_en)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (usuario_id)
       DO UPDATE SET shopify_store_domain = $2, shopify_access_token = $3, actualizado_en = now()`,
      [usuarioId, storeDomain, accessToken],
    );
    this.logger.log(`Shopify conectado para usuario id=${usuarioId} (${storeDomain}).`);
    return this.obtener(usuarioId);
  }

  async desconectarShopify(usuarioId: number): Promise<IntegracionesUsuario> {
    if (!this.pool) {
      throw new InternalServerErrorException('No se pudo desconectar: falta configurar la base de datos en el backend.');
    }
    await this.pool.query(
      `UPDATE integraciones SET shopify_store_domain = NULL, shopify_access_token = NULL, actualizado_en = now() WHERE usuario_id = $1`,
      [usuarioId],
    );
    return this.obtener(usuarioId);
  }

  // ---------------- fal.ai ----------------
  // A diferencia de Shopify, acá NO se hace una llamada de prueba antes de
  // guardar — cualquier llamada real a fal.ai (aunque sea "de prueba")
  // consume créditos de la cuenta del usuario, y no hay un endpoint gratis
  // confirmado para solo validar la clave. Si la clave está mal, el primer
  // intento real de generar una imagen o un texto lo va a avisar con un
  // error claro (ver image-edit.service.ts / text-generation.service.ts).

  async guardarFal(usuarioId: number, apiKeyCrudo: string): Promise<IntegracionesUsuario> {
    if (!this.pool) {
      throw new InternalServerErrorException('No se pudo guardar: falta configurar la base de datos en el backend.');
    }
    const apiKey = String(apiKeyCrudo || '').trim();
    if (!apiKey || apiKey.length < 10) {
      throw new ConflictException('Esa clave de fal.ai no parece válida.');
    }
    await this.pool.query(
      `INSERT INTO integraciones (usuario_id, fal_api_key, actualizado_en)
       VALUES ($1, $2, now())
       ON CONFLICT (usuario_id)
       DO UPDATE SET fal_api_key = $2, actualizado_en = now()`,
      [usuarioId, apiKey],
    );
    this.logger.log(`Clave de fal.ai conectada para usuario id=${usuarioId}.`);
    return this.obtener(usuarioId);
  }

  async desconectarFal(usuarioId: number): Promise<IntegracionesUsuario> {
    if (!this.pool) {
      throw new InternalServerErrorException('No se pudo desconectar: falta configurar la base de datos en el backend.');
    }
    await this.pool.query(`UPDATE integraciones SET fal_api_key = NULL, actualizado_en = now() WHERE usuario_id = $1`, [usuarioId]);
    return this.obtener(usuarioId);
  }
}
