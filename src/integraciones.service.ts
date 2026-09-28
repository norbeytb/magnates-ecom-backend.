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
//  - Shopify: crea una app en el Dev Dashboard de Shopify (dev.shopify.com)
//    para SU PROPIA tienda, le activa los alcances de Admin API read_products,
//    write_products, read_themes, write_themes y write_publications, la
//    instala en su tienda, y copia el "ID de Cliente" y el "Secreto" de esa
//    app — eso es lo que pega en el taller (Shopify ya no entrega, para apps
//    nuevas, un token de acceso fijo tipo "shpat_..." — solo da estas dos
//    credenciales, y hay que cambiarlas por un token real llamando a
//    Shopify; eso lo hace shopify.service.ts en cada publicación, nunca acá).
//    Antes de guardar, este backend prueba esas credenciales contra la
//    tienda (intercambiándolas por un token real, Client Credentials Grant)
//    para avisar de una vez si algo está mal escrito, en vez de que recién
//    falle el día que intente publicar una landing.
//  - fal.ai: crea su cuenta en fal.ai, carga créditos, y copia su clave
//    desde fal.ai/dashboard/keys — esa misma clave sirve tanto para generar
//    imágenes como texto (ver image-edit.service.ts y
//    text-generation.service.ts, que ahora la usan en vez de una clave
//    compartida del taller — el texto pasa a generarse también a través de
//    fal.ai, con un modelo de Claude, para que sea UNA sola clave y no dos).
//
// Los valores guardados (shopify_client_secret, fal_api_key) NUNCA se
// devuelven completos al frontend después de guardados — solo si están
// configurados y los últimos 4 caracteres (ver enmascarar más abajo), así
// la persona reconoce cuál puso sin que quede expuesto en la pantalla ni en
// las herramientas del navegador. El "ID de Cliente" de Shopify no es
// secreto (Shopify mismo lo muestra en texto plano en su propio dashboard),
// así que ese sí se devuelve completo.

import { ConflictException, Injectable, InternalServerErrorException, Logger, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';

// Fix 28/09 (pedido: "sería bueno implementar en nuestra tienda esa opción
// de conectar varias tiendas y cuando se vaya a enviar a Shopify le diga
// elige la tienda"): un usuario puede tener MÁS DE UNA tienda de Shopify
// conectada (antes solo una, guardada en las columnas shopify_* de la fila
// de "integraciones" de más abajo). Cada una vive en su propia fila de
// "shopify_tiendas", identificada por "shopKey" (un slug corto — para las
// que el usuario conecta acá se arma solo a partir del dominio; para las
// que llegan sincronizadas desde MEC Control, ver "sso/shopify-tienda" en
// auth.controller.ts, se usa el mismo shopKey que ya tienen allá, así
// reconectar/editar la misma tienda actualiza la fila en vez de duplicarla).
export interface TiendaShopifyResumen {
  shopKey: string;
  nombre: string;
  storeDomain: string;
  clientId: string;
  clientSecretParcial: string;
}

export interface IntegracionesUsuario {
  shopifyTiendas: TiendaShopifyResumen[];
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
      // shopify_access_token queda en la tabla sin usarse (columnas viejas
      // nunca se borran, ver nota de productos.service.ts) — Shopify dejó de
      // entregar ese tipo de token fijo para apps nuevas; ahora se guardan
      // estas dos en su lugar y shopify.service.ts las cambia por un token
      // real en cada publicación (Client Credentials Grant).
      await this.pool.query(`ALTER TABLE integraciones ADD COLUMN IF NOT EXISTS shopify_client_id TEXT;`);
      await this.pool.query(`ALTER TABLE integraciones ADD COLUMN IF NOT EXISTS shopify_client_secret TEXT;`);

      // Fix 28/09: tabla nueva para varias tiendas de Shopify por usuario
      // (ver el aviso grande junto a TiendaShopifyResumen más arriba).
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS shopify_tiendas (
          id SERIAL PRIMARY KEY,
          usuario_id INTEGER NOT NULL,
          shop_key TEXT NOT NULL,
          nombre TEXT,
          store_domain TEXT NOT NULL,
          client_id TEXT NOT NULL,
          client_secret TEXT NOT NULL,
          creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (usuario_id, shop_key)
        );
      `);
      await this.migrarTiendaUnicaAMultiple();
      this.logger.log('Conectado a PostgreSQL — tablas "integraciones" y "shopify_tiendas" listas.');
    } catch (error) {
      this.logger.error('No se pudo conectar/crear la tabla de integraciones: ' + (error as Error).message);
      this.pool = null;
    }
  }

  // Migración única, sin herramienta de migraciones (mismo criterio que el
  // resto del archivo, ver ALTER TABLE de arriba): copia la tienda que ya
  // tuviera guardada cada usuario en las columnas viejas de "integraciones"
  // a su propia fila en "shopify_tiendas", con shopKey fijo "principal".
  // ON CONFLICT DO NOTHING la vuelve segura de correr en cada arranque del
  // servidor sin duplicar filas — la segunda vez en adelante no hace nada
  // porque ese (usuario_id, 'principal') ya existe. Las columnas viejas se
  // dejan tal cual (nunca se borran, mismo criterio que shopify_access_token
  // más arriba) por si algo más las llegara a leer.
  private async migrarTiendaUnicaAMultiple(): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(`
      INSERT INTO shopify_tiendas (usuario_id, shop_key, nombre, store_domain, client_id, client_secret)
      SELECT usuario_id, 'principal', 'Mi tienda', shopify_store_domain, shopify_client_id, shopify_client_secret
      FROM integraciones
      WHERE shopify_store_domain IS NOT NULL AND shopify_client_id IS NOT NULL AND shopify_client_secret IS NOT NULL
      ON CONFLICT (usuario_id, shop_key) DO NOTHING
    `);
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

  // Vista "segura" para el frontend — nunca incluye el secreto/clave completos.
  async obtener(usuarioId: number): Promise<IntegracionesUsuario> {
    const shopifyTiendas = await this.listarTiendasShopify(usuarioId);
    if (!this.pool) {
      return { shopifyTiendas, falConectado: false };
    }
    const resultado = await this.pool.query(`SELECT fal_api_key FROM integraciones WHERE usuario_id = $1`, [usuarioId]);
    const fila = resultado.rows[0];
    return {
      shopifyTiendas,
      falConectado: !!fila?.fal_api_key,
      falKeyParcial: this.ultimos4(fila?.fal_api_key),
    };
  }

  // ---------------- Uso interno (otros servicios) ----------------
  // A diferencia de obtener()/listarTiendasShopify() de arriba, estos SÍ
  // devuelven los valores completos — los usan ShopifyService/
  // ImageEditService/TextGenerationService para llamar a Shopify/fal.ai en
  // nombre del usuario. Nunca deben propagarse tal cual en una respuesta HTTP.

  // Credenciales de UNA tienda puntual del usuario, identificada por su
  // shopKey — nunca se aceptan credenciales sueltas del body de un pedido
  // (ver shopify.controller.ts), siempre se buscan acá a partir de
  // (usuarioId, shopKey) para que un usuario jamás pueda publicar en la
  // tienda de otro.
  async obtenerCredencialesTienda(usuarioId: number, shopKey: string): Promise<{ storeDomain: string; clientId: string; clientSecret: string } | null> {
    if (!this.pool || !shopKey) return null;
    const resultado = await this.pool.query(
      `SELECT store_domain, client_id, client_secret FROM shopify_tiendas WHERE usuario_id = $1 AND shop_key = $2`,
      [usuarioId, shopKey],
    );
    const fila = resultado.rows[0];
    if (!fila) return null;
    return { storeDomain: fila.store_domain, clientId: fila.client_id, clientSecret: fila.client_secret };
  }

  // ---------------- Shopify: varias tiendas por usuario ----------------

  async listarTiendasShopify(usuarioId: number): Promise<TiendaShopifyResumen[]> {
    if (!this.pool) return [];
    const resultado = await this.pool.query(
      `SELECT shop_key, nombre, store_domain, client_id, client_secret FROM shopify_tiendas WHERE usuario_id = $1 ORDER BY creado_en`,
      [usuarioId],
    );
    return resultado.rows.map((f) => ({
      shopKey: f.shop_key,
      nombre: f.nombre || f.store_domain,
      storeDomain: f.store_domain,
      clientId: f.client_id,
      clientSecretParcial: this.ultimos4(f.client_secret) || '••••',
    }));
  }

  // A partir de un dominio arma un shopKey legible y estable (para las
  // tiendas que el usuario conecta acá mismo, en Integraciones — las que
  // llegan sincronizadas desde MEC Control ya traen su propio shopKey, ver
  // guardarTiendaShopifyDesdeSso más abajo). Ej: "mitienda.myshopify.com" →
  // "mitienda-myshopify-com".
  private shopKeyDesdeDominio(dominio: string): string {
    return dominio.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'tienda';
  }

  // Valida (formato + prueba real contra Shopify, igual que antes) y guarda
  // una tienda conectada DIRECTAMENTE por el usuario en el taller. Sin
  // shopKey explícito, se arma uno a partir del dominio — reconectar la
  // MISMA tienda (mismo dominio) actualiza esa fila en vez de duplicarla.
  async guardarShopify(
    usuarioId: number,
    storeDomainCrudo: string,
    clientIdCrudo: string,
    clientSecretCrudo: string,
    nombreCrudo?: string,
  ): Promise<TiendaShopifyResumen[]> {
    if (!this.pool) {
      throw new InternalServerErrorException('No se pudo guardar: falta configurar la base de datos en el backend.');
    }
    const storeDomain = this.normalizarDominio(storeDomainCrudo);
    if (!storeDomain || !storeDomain.includes('.')) {
      throw new ConflictException('Ese dominio de tienda no parece válido. Ejemplo: mitienda.myshopify.com');
    }
    const clientId = String(clientIdCrudo || '').trim();
    const clientSecret = String(clientSecretCrudo || '').trim();
    if (!clientId || clientId.length < 10) {
      throw new ConflictException('Ese ID de Cliente no parece válido.');
    }
    if (!clientSecret || clientSecret.length < 10) {
      throw new ConflictException('Ese Secreto (Client Secret) no parece válido.');
    }
    await this.probarCredencialesShopify(storeDomain, clientId, clientSecret);

    const shopKey = this.shopKeyDesdeDominio(storeDomain);
    const nombre = String(nombreCrudo || '').trim() || storeDomain;
    await this.pool.query(
      `INSERT INTO shopify_tiendas (usuario_id, shop_key, nombre, store_domain, client_id, client_secret)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (usuario_id, shop_key)
       DO UPDATE SET nombre = $3, store_domain = $4, client_id = $5, client_secret = $6`,
      [usuarioId, shopKey, nombre, storeDomain, clientId, clientSecret],
    );
    this.logger.log(`Shopify conectado para usuario id=${usuarioId} (${storeDomain}, shopKey=${shopKey}).`);
    return this.listarTiendasShopify(usuarioId);
  }

  async desconectarShopify(usuarioId: number, shopKey: string): Promise<TiendaShopifyResumen[]> {
    if (!this.pool) {
      throw new InternalServerErrorException('No se pudo desconectar: falta configurar la base de datos en el backend.');
    }
    await this.pool.query(`DELETE FROM shopify_tiendas WHERE usuario_id = $1 AND shop_key = $2`, [usuarioId, shopKey]);
    return this.listarTiendasShopify(usuarioId);
  }

  // Prueba real contra la tienda ANTES de guardar — se cambian las
  // credenciales por un token real (Client Credentials Grant, lo mismo que
  // hace shopify.service.ts en cada publicación) así se avisa de una vez si
  // el dominio, el ID de Cliente o el Secreto están mal, en vez de que recién
  // falle el día que la persona intente publicar una landing. Separado en su
  // propio método porque ahora lo usan dos caminos: guardarShopify() (acá
  // mismo, tienda conectada directo en el taller) y
  // guardarTiendaShopifyDesdeSso() (sincronizada desde MEC Control).
  private async probarCredencialesShopify(storeDomain: string, clientId: string, clientSecret: string): Promise<void> {
    let resp: Response;
    try {
      resp = await fetch(`https://${storeDomain}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
      });
    } catch {
      throw new ConflictException('No se pudo conectar con esa tienda de Shopify — revisá el dominio (debe terminar en .myshopify.com) y probá de nuevo.');
    }
    if (!resp.ok) {
      throw new ConflictException('Shopify rechazó el ID de Cliente / Secreto — revisá que los hayas copiado completos y que la app esté instalada en esa tienda.');
    }
    const datos: any = await resp.json().catch(() => null);
    if (!datos?.access_token) {
      throw new ConflictException('Shopify no devolvió un token de acceso — revisá el dominio y las credenciales, y probá de nuevo.');
    }
  }

  // ---------------- Shopify: sincronizado desde MEC Control ----------------
  // Lo llama auth.controller.ts ("sso/shopify-tienda", ver el aviso grande
  // ahí) después de que AuthService ya validó el secreto compartido y
  // resolvió el usuario_id a partir del correo — acá ya no hace falta
  // desconfiar de quién llama, pero la tienda en sí se prueba igual contra
  // Shopify antes de guardarla (mismos motivos que guardarShopify() de
  // arriba). A diferencia de esa, el shopKey lo elige MEC Control (el mismo
  // que usa allá para esa tienda), no se arma acá — así una misma tienda
  // reconectada o renombrada del lado de MEC Control actualiza siempre la
  // MISMA fila en vez de crear una nueva.
  async guardarTiendaShopifyDesdeSso(
    usuarioId: number,
    shopKeyCrudo: string,
    nombreCrudo: string,
    storeDomainCrudo: string,
    clientIdCrudo: string,
    clientSecretCrudo: string,
  ): Promise<TiendaShopifyResumen[]> {
    if (!this.pool) {
      throw new InternalServerErrorException('No se pudo guardar: falta configurar la base de datos en el backend.');
    }
    const shopKey = String(shopKeyCrudo || '').trim();
    if (!shopKey) {
      throw new ConflictException('Falta el identificador de la tienda (shopKey).');
    }
    const storeDomain = this.normalizarDominio(storeDomainCrudo);
    if (!storeDomain || !storeDomain.includes('.')) {
      throw new ConflictException('Ese dominio de tienda no parece válido.');
    }
    const clientId = String(clientIdCrudo || '').trim();
    const clientSecret = String(clientSecretCrudo || '').trim();
    if (!clientId || !clientSecret) {
      throw new ConflictException('Faltan el ID de Cliente o el Secreto de esa tienda.');
    }
    await this.probarCredencialesShopify(storeDomain, clientId, clientSecret);

    const nombre = String(nombreCrudo || '').trim() || storeDomain;
    await this.pool.query(
      `INSERT INTO shopify_tiendas (usuario_id, shop_key, nombre, store_domain, client_id, client_secret)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (usuario_id, shop_key)
       DO UPDATE SET nombre = $3, store_domain = $4, client_id = $5, client_secret = $6`,
      [usuarioId, shopKey, nombre, storeDomain, clientId, clientSecret],
    );
    this.logger.log(`Shopify sincronizado desde MEC Control para usuario id=${usuarioId} (${storeDomain}, shopKey=${shopKey}).`);
    return this.listarTiendasShopify(usuarioId);
  }

  async borrarTiendaShopifyDesdeSso(usuarioId: number, shopKeyCrudo: string): Promise<TiendaShopifyResumen[]> {
    if (!this.pool) {
      throw new InternalServerErrorException('No se pudo desconectar: falta configurar la base de datos en el backend.');
    }
    const shopKey = String(shopKeyCrudo || '').trim();
    if (shopKey) {
      await this.pool.query(`DELETE FROM shopify_tiendas WHERE usuario_id = $1 AND shop_key = $2`, [usuarioId, shopKey]);
    }
    return this.listarTiendasShopify(usuarioId);
  }

  async obtenerClaveFal(usuarioId: number): Promise<string | null> {
    if (!this.pool) return null;
    const resultado = await this.pool.query(`SELECT fal_api_key FROM integraciones WHERE usuario_id = $1`, [usuarioId]);
    return resultado.rows[0]?.fal_api_key || null;
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
