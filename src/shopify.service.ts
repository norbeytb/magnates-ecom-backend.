// shopify.service.ts
//
// Publica una landing ensamblada (una lista de imágenes ya generadas) como un
// PRODUCTO en la tienda de Shopify DEL ESTUDIANTE, usando la Admin API. Todas
// las imágenes suben a la Multimedia del producto, y ADEMÁS este backend le
// prepara automáticamente al tema de esa tienda una plantilla alterna
// "landing" con una sección propia que dibuja esas mismas imágenes una
// debajo de otra, a pantalla completa (sin título/reseñas encima) — ver
// asegurarPlantillaLanding() más abajo. Esto es lo mismo que hacen otras
// herramientas de landings: le agregan al tema su propia sección al
// instalarse, en vez de depender del bloque de "Descripción" del tema (que
// en muchos temas nuevos —como Horizon— usa un campo de tipo "richtext" que
// no acepta imágenes sueltas). Además, la sección normal de producto de esa
// plantilla se recorta (simplificarSeccionProducto) para que solo queden el
// precio y el botón nativo de comprar debajo de las imágenes — nada de
// galería/título/descripción duplicados. Esa preparación del tema se hace
// UNA sola vez por tienda (revisa si ya existe antes de crear nada, y repara
// sola la plantilla si ya existía de antes de este recorte) y no requiere
// que el estudiante toque el editor del tema. El precio se toma de la Ficha
// Técnica (Oferta → Precio 1) que el usuario ya llenó en el taller.
//
// CADA USUARIO CONECTA SU PROPIA TIENDA (módulo de Integraciones, ver
// integraciones.service.ts): en vez de una sola tienda compartida configurada
// con variables de entorno de Railway, cada estudiante crea su propia app en
// el Dev Dashboard de Shopify (dev.shopify.com) para SU tienda y pega acá el
// dominio + el ID de Cliente + el Secreto que le da esa app.
//
// IMPORTANTE (cambió respecto a versiones viejas de este archivo): Shopify
// dejó de dar, para apps nuevas, un token de acceso fijo tipo "shpat_..." que
// no vence — ahora el Dev Dashboard solo entrega ID de Cliente + Secreto, y
// hay que cambiarlos por un token real llamando a Shopify (Client
// Credentials Grant, POST a /admin/oauth/access_token), token que dura 24
// horas y hay que renovar solo. Por eso este servicio SÍ vuelve a cachear un
// token (ver obtenerAccessToken() más abajo) — pero, a diferencia de la
// versión de un solo usuario de antes, el cache es un mapa POR TIENDA (nunca
// un solo campo compartido), y las credenciales (clientId/clientSecret)
// nunca se guardan en el servicio: viajan como parámetro en cada método,
// desde IntegracionesService.obtenerCredencialesShopify(usuarioId).
//
// La app de cada estudiante necesita estos permisos de Admin API
// (Configuración de la app en el Dev Dashboard → Alcances de API de
// administración):
//   read_products, write_products, read_themes, write_themes, write_publications
// (read_themes/write_themes son para poder crearle al tema la plantilla/
// sección automática de la landing — ver asegurarPlantillaLanding().
// write_publications es imprescindible: sin él el producto queda creado pero
// NUNCA se ve en la tienda pública, solo en la vista previa del admin — ver
// publicarEnTiendaOnline() más abajo).
//
// "Volver a publicar" SIEMPRE crea un producto nuevo en Shopify, incluso si
// ya se había publicado antes esa misma landing — a propósito, para que la
// página nueva nunca pueda estar cacheada de antes en Shopify (ver
// publicarLanding() más abajo). Puede quedar un producto viejo duplicado en
// la tienda; el estudiante lo borra a mano si no lo necesita más.

import { Injectable, Logger } from '@nestjs/common';

// Credenciales de la tienda de Shopify de UN usuario puntual — las devuelve
// IntegracionesService.obtenerCredencialesShopify(usuarioId) y las pasa el
// controlador en cada llamada. Nunca se guardan en este servicio (que es un
// singleton compartido por todos los usuarios): viajan como parámetro en
// cada método, de punta a punta.
export interface ShopifyCredenciales {
  storeDomain: string;
  clientId: string;
  clientSecret: string;
}

// Un paso de la secuencia editable de la landing: o una imagen (el orden en
// que se suben a la Multimedia) o un marcador de "botón de comprar" que el
// estudiante insertó a mano con el "+" en la vista previa del taller — ver
// enviarLandingAShopify() en el frontend. La sección del tema dibuja cada
// paso en el mismo orden en que viene, así el botón queda exactamente donde
// el estudiante lo puso dentro de las imágenes (no solo al final).
// texto: lo que el estudiante haya escrito para ese botón puntual (editable
// en el taller, ver realBotonComprarHtml) — si no mandó nada, la sección cae
// de vuelta a "COMPRAR AHORA" (ver el Liquid: {{ paso.texto | default: ... }}).
// color: el fondo elegido con el selector de color del taller (hex); si no
// mandó nada, cae al amarillo de Releasit por defecto. colorTexto lo calcula
// el propio taller según el contraste del color elegido (para que el texto
// nunca quede ilegible) — el backend solo lo usa tal cual viene.
export type LandingSecuenciaPaso =
  | { tipo: 'imagen'; url: string }
  | { tipo: 'boton_comprar'; texto?: string; color?: string; colorTexto?: string };

export interface PublicarLandingInput {
  nombreProducto: string;
  landingNum: number;
  imagenes: string[];
  // Opcional por compatibilidad con versiones viejas del frontend que
  // todavía no mandan la secuencia (en ese caso la sección cae de vuelta a
  // dibujar solo las imágenes, sin botones intercalados).
  secuencia?: LandingSecuenciaPaso[];
  // Checkbox "📌 Botón flotante" del taller: además de los botones
  // intercalados, deja una barra fija abajo de la pantalla que sigue al
  // visitante mientras hace scroll.
  botonFlotante?: boolean;
  // Mismo texto/color personalizable que los botones intercalados
  // (LandingSecuenciaPaso), pero acá es uno solo por landing — no vienen
  // dentro de "secuencia" porque el botón flotante no es un paso de la
  // secuencia de imágenes/botones, es aparte. Si no mandan nada, cae de
  // vuelta a "COMPRAR AHORA" en amarillo, igual que antes.
  botonFlotanteTexto?: string;
  botonFlotanteColor?: string;
  botonFlotanteColorTexto?: string;
  // Tarjeta "Agregar Movimiento" del Editor de Elementos: anima (pulso de
  // escala) TODOS los botones "COMPRAR AHORA" de la landing (intercalados +
  // flotante) a la vez cuando viene en true — antes esta animación estaba siempre encendida
  // a la fuerza en seccionLandingLiquid, ahora es opcional por landing.
  movimiento?: boolean;
  // Tarjeta "Agregar Barra de Movimiento" del Editor de Elementos: barra de
  // texto que se desliza sola, arriba de todo el resto de la landing.
  barra?: boolean;
  barraTexto?: string;
  barraColor?: string;
  barraColorTexto?: string;
  // Segundos que tarda la barra en dar una vuelta completa (menos = más
  // rápido) — botones Lenta/Normal/Rápida del taller. Si no viene, la
  // sección usa 14 por defecto (ver seccionLandingLiquid).
  barraVelocidad?: number;
  precio?: string | number;
  precioComparacion?: string | number;
}

export interface PublicarLandingResultado {
  url: string;
  handle: string;
  creada: boolean;
  // Avisos de cosas que fallaron SIN tumbar la publicación (ej: no se pudo
  // guardar el metafield de la secuencia de botones, o no se pudo actualizar
  // la sección del tema) — antes esto solo quedaba en los logs del backend y
  // el estudiante nunca se enteraba de por qué "faltaba" un botón en la
  // página real. Si viene vacío/ausente, todo se guardó bien.
  avisos?: string[];
}

@Injectable()
export class ShopifyService {
  private readonly logger = new Logger(ShopifyService.name);
  private readonly apiVersion = '2026-07';
  // Id (GraphQL) del canal "Tienda online" de cada tienda — se busca una sola
  // vez POR TIENDA y se reutiliza (ver obtenerPublicationIdTiendaOnline() más
  // abajo). Antes esto era un solo campo porque solo existía una tienda; ahora
  // cada estudiante tiene la suya, así que se cachea en un mapa por dominio.
  private readonly publicationIdPorTienda = new Map<string, string>();

  // Token real (de corta duración, 24hs) que Shopify devuelve a cambio del
  // ID de Cliente + Secreto de la app de cada tienda — se cachea POR TIENDA
  // (nunca en un solo campo: este servicio es un singleton compartido por
  // todos los usuarios a la vez) con cuándo vence, para no pedir uno nuevo
  // en cada llamada.
  private readonly tokenCachePorTienda = new Map<string, { token: string; expiraEn: number }>();

  // Confirma que llegaron credenciales antes de llamar a Shopify — si esto
  // dispara es porque algo llamó a este servicio sin pasar por
  // IntegracionesService.obtenerCredencialesShopify() primero (el controlador
  // ya hace esa validación con un mensaje más amigable antes de llegar acá;
  // esto es solo un respaldo).
  private validarCredenciales(credenciales?: ShopifyCredenciales | null): ShopifyCredenciales {
    if (!credenciales || !credenciales.storeDomain || !credenciales.clientId || !credenciales.clientSecret) {
      throw new Error('No hay una tienda de Shopify conectada. Conectala primero en "Integraciones".');
    }
    return credenciales;
  }

  private baseUrl(storeDomain: string): string {
    return `https://${storeDomain}/admin/api/${this.apiVersion}`;
  }

  private headers(accessToken: string): Record<string, string> {
    return {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    };
  }

  // Cambia ID de Cliente + Secreto por un token real de Admin API (Client
  // Credentials Grant) — con margen de 1 minuto antes de que venza para
  // renovarlo antes de que Shopify lo rechace a mitad de una publicación.
  // Si Shopify rechaza las credenciales (app desinstalada, secreto rotado,
  // etc.) tira un error con mensaje claro para el estudiante.
  // forzarNuevo=true salta el caché y pide un token recién hecho — lo usa
  // llamarShopify() cuando el token cacheado fue rechazado por Shopify (ver
  // más abajo), por si mientras tanto se reinstaló la app o se le agregaron
  // permisos nuevos en el Dev Dashboard: así no hay que esperar a que el
  // token viejo venza solo (hasta 24hs) para que el estudiante pueda publicar.
  private async obtenerAccessToken(credenciales: ShopifyCredenciales, forzarNuevo = false): Promise<string> {
    const ahora = Date.now();
    if (!forzarNuevo) {
      const cacheado = this.tokenCachePorTienda.get(credenciales.storeDomain);
      if (cacheado && cacheado.expiraEn > ahora + 60_000) {
        return cacheado.token;
      }
    }

    let resp: Response;
    try {
      resp = await fetch(`https://${credenciales.storeDomain}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: credenciales.clientId,
          client_secret: credenciales.clientSecret,
          grant_type: 'client_credentials',
        }),
      });
    } catch {
      throw new Error('No se pudo conectar con esa tienda de Shopify — revisá el dominio (debe terminar en .myshopify.com).');
    }
    if (!resp.ok) {
      throw new Error(
        'Shopify rechazó el ID de Cliente / Secreto de tu app — revisá que estén bien copiados y que la app siga instalada en tu tienda. Conectala de nuevo en "Integraciones" si hace falta.',
      );
    }
    const datos: any = await resp.json();
    const token = datos?.access_token;
    if (!token) {
      throw new Error('Shopify no devolvió un token de acceso — probá reconectar la tienda en "Integraciones".');
    }
    const expiresInMs = (Number(datos.expires_in) || 86399) * 1000;
    this.tokenCachePorTienda.set(credenciales.storeDomain, { token, expiraEn: ahora + expiresInMs });
    return token;
  }

  // Llama a la Admin API de la tienda del usuario, resolviendo primero un
  // token real a partir de sus credenciales (ver obtenerAccessToken arriba).
  // Si Shopify responde 401/403, el token usado puede ser uno cacheado de
  // ANTES de que el estudiante terminara de instalar la app / activar los
  // permisos en Shopify (caso típico: probó conectar, falló, arregló algo en
  // el Dev Dashboard, y sin este reintento se hubiera quedado pegado con el
  // token viejo insuficiente hasta que venciera solo, hasta 24hs) — por eso
  // se pide un token NUEVO (forzarNuevo, sin usar el caché) y se reintenta
  // UNA sola vez antes de darse por vencido. Si después de eso sigue
  // fallando, sí es un problema real de credenciales/permisos y el error sube tal cual
  // para que el taller le avise al estudiante que revise su conexión.
  private async llamarShopify(credenciales: ShopifyCredenciales, path: string, opciones: RequestInit = {}, _reintento = false): Promise<Response> {
    const accessToken = await this.obtenerAccessToken(credenciales, _reintento);
    const headers = this.headers(accessToken);
    const resp = await fetch(`${this.baseUrl(credenciales.storeDomain)}${path}`, {
      ...opciones,
      headers: { ...headers, ...(opciones.headers as Record<string, string> | undefined) },
    });
    if ((resp.status === 401 || resp.status === 403) && !_reintento) {
      return this.llamarShopify(credenciales, path, opciones, true);
    }
    return resp;
  }

  // Llama al endpoint de GraphQL de la Admin API (mismo dominio/token que
  // llamarShopify). Usado solo para publicar el producto en el canal
  // "Tienda online" — ver publicarEnTiendaOnline() más abajo — porque eso ya
  // no se puede hacer de forma confiable por REST (Shopify lo dejó solo en
  // GraphQL, con la mutación publishablePublish).
  private async graphql(credenciales: ShopifyCredenciales, query: string, variables?: Record<string, unknown>): Promise<any> {
    const resp = await this.llamarShopify(credenciales, '/graphql.json', {
      method: 'POST',
      body: JSON.stringify({ query, variables }),
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    }
    const json: any = await resp.json();
    if (json.errors) {
      throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
    }
    return json.data;
  }

  // Busca (una sola vez por tienda, se cachea) el id del canal "Tienda
  // online" — el que hay que usar para que el producto se pueda ver en la
  // URL pública de la tienda, no solo en la vista previa del admin. Cada
  // estudiante tiene su propia tienda y su admin puede estar en cualquier
  // idioma — así que no alcanza con buscar el canal por el texto "Online
  // Store" (ese nombre puede venir traducido, ej. "Tienda online" en
  // español, y además Shopify lo tiene marcado como campo obsoleto). Por eso
  // se intenta primero por el id de la app del canal (fijo, no cambia con el
  // idioma) y solo si eso no aparece, se cae de vuelta a buscar por nombre
  // probando las traducciones más comunes.
  private async obtenerPublicationIdTiendaOnline(credenciales: ShopifyCredenciales): Promise<string> {
    const cacheado = this.publicationIdPorTienda.get(credenciales.storeDomain);
    if (cacheado) return cacheado;

    const data = await this.graphql(
      credenciales,
      `{
      publications(first: 20) {
        edges {
          node {
            id
            name
            channels(first: 5) { edges { node { app { id } } } }
          }
        }
      }
    }`,
    );
    const nodos = ((data?.publications?.edges || []) as any[]).map((e) => e.node);

    const APP_ID_TIENDA_ONLINE = 'gid://shopify/App/580111';
    let nodo = nodos.find((n) => ((n.channels?.edges || []) as any[]).some((c) => c.node?.app?.id === APP_ID_TIENDA_ONLINE));

    if (!nodo) {
      const NOMBRES_TIENDA_ONLINE = ['online store', 'tienda online', 'tienda en línea', 'loja virtual', 'boutique en ligne'];
      nodo = nodos.find((n) => NOMBRES_TIENDA_ONLINE.includes(String(n.name || '').toLowerCase()));
    }
    if (!nodo) {
      throw new Error('No se encontró el canal "Tienda online" entre los canales de venta de la tienda.');
    }
    this.publicationIdPorTienda.set(credenciales.storeDomain, nodo.id);
    return nodo.id;
  }

  // Publica el producto en el canal "Tienda online" — IMPRESCINDIBLE para
  // que la landing se vea en la URL pública para cualquier visitante. Mandar
  // status:"active" al crear/actualizar el producto por REST lo deja activo
  // EN EL ADMIN pero, en las versiones actuales de la API de Shopify, ya NO
  // lo publica solo en ningún canal de venta — por eso la landing se vería
  // bien en la vista previa del editor de temas (el admin sí puede ver
  // productos sin publicar) pero daría 404 para un visitante cualquiera. Se
  // llama después de crear/actualizar el producto, tanto en la primera
  // publicación como en cada reenvío (si ya estaba publicado, volver a
  // publicarlo no hace daño). Si esto falla (por ejemplo porque el scope
  // write_publications todavía no está en la app del estudiante — hay que
  // agregarlo en la configuración de la app y reinstalarla en su tienda), no
  // debe tumbar la publicación: el producto igual queda creado/actualizado,
  // solo sin publicar en el canal por esta vez.
  private async publicarEnTiendaOnline(credenciales: ShopifyCredenciales, productId: number): Promise<void> {
    try {
      const publicationId = await this.obtenerPublicationIdTiendaOnline(credenciales);
      const data = await this.graphql(
        credenciales,
        `mutation PublicarProducto($id: ID!, $input: [PublicationInput!]!) {
          publishablePublish(id: $id, input: $input) {
            userErrors { field message }
          }
        }`,
        { id: `gid://shopify/Product/${productId}`, input: [{ publicationId }] },
      );
      const errores = data?.publishablePublish?.userErrors;
      if (errores && errores.length > 0) {
        throw new Error(errores.map((e: any) => e.message).join('; '));
      }
      this.logger.log(`Producto ${productId} publicado en el canal "Tienda online" (${credenciales.storeDomain}).`);
    } catch (err) {
      this.logger.warn(`No se pudo publicar el producto ${productId} en el canal "Tienda online" de ${credenciales.storeDomain} (revisa el scope write_publications en la app): ${(err as Error).message}`);
    }
  }

  // ---------- Preparación automática del tema (plantilla "landing") ----------

  // Busca el tema activo/publicado de la tienda (el que ven los clientes).
  private async obtenerTemaActivoId(credenciales: ShopifyCredenciales): Promise<number> {
    const resp = await this.llamarShopify(credenciales, '/themes.json');
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
  private async obtenerAsset(credenciales: ShopifyCredenciales, temaId: number, key: string): Promise<string | null> {
    const resp = await this.llamarShopify(credenciales, `/themes/${temaId}/assets.json?asset[key]=${encodeURIComponent(key)}`);
    if (resp.status === 404) return null;
    if (!resp.ok) {
      throw new Error(`No se pudo leer "${key}" del tema (HTTP ${resp.status}): ${await resp.text()}`);
    }
    const json: any = await resp.json();
    return typeof json?.asset?.value === 'string' ? json.asset.value : null;
  }

  // Crea o sobrescribe un archivo del tema.
  private async guardarAsset(credenciales: ShopifyCredenciales, temaId: number, key: string, value: string): Promise<void> {
    const resp = await this.llamarShopify(credenciales, `/themes/${temaId}/assets.json`, {
      method: 'PUT',
      body: JSON.stringify({ asset: { key, value } }),
    });
    if (!resp.ok) {
      throw new Error(`No se pudo guardar "${key}" en el tema (HTTP ${resp.status}): ${await resp.text()}`);
    }
  }

  // Guarda (crea o sobrescribe) un metafield del producto, en el namespace
  // fijo "ecom_magnates" que usa este backend para todo lo de la landing.
  // Genérico — lo usan guardarMetafieldSecuencia() y
  // guardarMetafieldBotonFlotante() más abajo. Si esto falla (por ejemplo el
  // scope de metafields todavía no está activo, o Shopify lo rechaza), no
  // debe tumbar la publicación del producto: la landing igual queda creada/
  // actualizada, solo sin ese dato guardado por esta vez.
  // avisos: si se pasa, además de loguear el fallo se le agrega un mensaje
  // legible — así publicarLanding() puede devolverle al taller la lista de
  // cosas que no se guardaron, en vez de que el estudiante solo vea
  // "Publicado" y se quede sin saber por qué falta algo en la página real.
  private async guardarMetafield(credenciales: ShopifyCredenciales, productId: number, key: string, type: string, value: string, avisos?: string[]): Promise<void> {
    try {
      // Shopify no deja "POST" dos veces el mismo namespace+key en un
      // producto (da error de duplicado) — hay que revisar primero si ya
      // existe (de una publicación anterior de esta misma landing) para
      // actualizarlo (PUT) en vez de crearlo de nuevo, o el dato se quedaría
      // pegado en la primera versión para siempre en los reenvíos.
      const buscar = await this.llamarShopify(credenciales, `/products/${productId}/metafields.json?namespace=ecom_magnates&key=${encodeURIComponent(key)}`);
      if (!buscar.ok) throw new Error(`HTTP ${buscar.status} al buscar el metafield "${key}": ${await buscar.text()}`);
      const buscarJson: any = await buscar.json();
      const existente = buscarJson?.metafields?.[0];

      const resp = existente
        ? await this.llamarShopify(credenciales, `/products/${productId}/metafields/${existente.id}.json`, {
            method: 'PUT',
            body: JSON.stringify({ metafield: { id: existente.id, type, value } }),
          })
        : await this.llamarShopify(credenciales, `/products/${productId}/metafields.json`, {
            method: 'POST',
            body: JSON.stringify({ metafield: { namespace: 'ecom_magnates', key, type, value } }),
          });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
      }
    } catch (err) {
      const mensaje = `No se pudo guardar el metafield "${key}" en el producto ${productId}: ${(err as Error).message}`;
      this.logger.warn(mensaje);
      if (avisos) {
        avisos.push(
          key === 'landing_secuencia'
            ? 'No se pudo guardar la posición de los botones "COMPRAR AHORA" — puede que falten en la página real. Volvé a publicar en un momento.'
            : mensaje,
        );
      }
    }
  }

  // El metafield con la secuencia completa de la landing (imágenes + botones
  // de comprar intercalados, en el orden exacto en que el estudiante los
  // dejó en el taller). La sección "landing-imagenes" del tema lee este
  // metafield para saber dónde dibujar cada botón — ver seccionLandingLiquid
  // más arriba.
  private async guardarMetafieldSecuencia(credenciales: ShopifyCredenciales, productId: number, secuencia: LandingSecuenciaPaso[], avisos?: string[]): Promise<void> {
    await this.guardarMetafield(credenciales, productId, 'landing_secuencia', 'json', JSON.stringify(secuencia), avisos);
  }

  // El metafield del "Botón Flotante" (checkbox del taller): si está
  // activado, la sección dibuja una barra fija abajo de la pantalla con el
  // botón de comprar, que sigue al visitante mientras hace scroll — además
  // de (no en vez de) los botones intercalados entre imágenes. Se guarda
  // SIEMPRE (true o false), a diferencia de la secuencia, para que también
  // se pueda APAGAR en un reenvío si el estudiante desmarca el checkbox.
  private async guardarMetafieldBotonFlotante(credenciales: ShopifyCredenciales, productId: number, activo: boolean, avisos?: string[]): Promise<void> {
    await this.guardarMetafield(credenciales, productId, 'boton_flotante', 'boolean', activo ? 'true' : 'false', avisos);
  }

  // Tarjeta "Agregar Movimiento" del Editor de Elementos (ver
  // taller-generador-landing.html) — se guarda SIEMPRE (true o false), igual
  // que boton_flotante, para que también se pueda APAGAR en un reenvío si el
  // estudiante desactiva la tarjeta. La sección "landing-imagenes" del tema
  // (seccionLandingLiquid más abajo) lee este metafield para decidir si le
  // agrega la animación de "pulso" a los botones o los deja quietos.
  private async guardarMetafieldMovimiento(credenciales: ShopifyCredenciales, productId: number, activo: boolean, avisos?: string[]): Promise<void> {
    await this.guardarMetafield(credenciales, productId, 'landing_movimiento', 'boolean', activo ? 'true' : 'false', avisos);
  }

  // Texto/color personalizados del botón flotante (mismo mecanismo que
  // "texto"/"color"/"colorTexto" de cada paso 'boton_comprar' dentro de la
  // secuencia, pero acá es un solo botón por landing, así que van en
  // metafields aparte en vez de ir dentro del JSON de landing_secuencia). Se
  // guardan solo cuando el taller efectivamente mandó un valor (ver el
  // "typeof === 'string'" en publicarLanding) — así una landing vieja, que
  // nunca tocó estos campos, no pisa nada con string vacío.
  private async guardarMetafieldBotonFlotanteTexto(credenciales: ShopifyCredenciales, productId: number, texto: string, avisos?: string[]): Promise<void> {
    await this.guardarMetafield(credenciales, productId, 'boton_flotante_texto', 'single_line_text_field', texto, avisos);
  }

  private async guardarMetafieldBotonFlotanteColor(credenciales: ShopifyCredenciales, productId: number, color: string, colorTexto: string, avisos?: string[]): Promise<void> {
    await this.guardarMetafield(credenciales, productId, 'boton_flotante_color', 'single_line_text_field', color, avisos);
    await this.guardarMetafield(credenciales, productId, 'boton_flotante_color_texto', 'single_line_text_field', colorTexto, avisos);
  }

  // Tarjeta "Agregar Barra de Movimiento" del Editor de Elementos — mismo
  // patrón que boton_flotante: un metafield booleano que prende/apaga la
  // barra (se guarda SIEMPRE, para poder apagarla en un reenvío), más
  // texto/color opcionales que solo se pisan cuando el taller efectivamente
  // mandó algo (para no borrar lo ya guardado con un reenvío viejo).
  private async guardarMetafieldBarra(credenciales: ShopifyCredenciales, productId: number, activo: boolean, avisos?: string[]): Promise<void> {
    await this.guardarMetafield(credenciales, productId, 'barra_movimiento', 'boolean', activo ? 'true' : 'false', avisos);
  }

  private async guardarPersonalizacionBarra(credenciales: ShopifyCredenciales, productId: number, input: PublicarLandingInput, avisos: string[]): Promise<void> {
    if (typeof input.barraTexto === 'string' && input.barraTexto.trim() !== '') {
      await this.guardarMetafield(credenciales, productId, 'barra_movimiento_texto', 'single_line_text_field', input.barraTexto, avisos);
    }
    if (typeof input.barraColor === 'string' && input.barraColor.trim() !== '') {
      await this.guardarMetafield(credenciales, productId, 'barra_movimiento_color', 'single_line_text_field', input.barraColor, avisos);
      await this.guardarMetafield(
        credenciales,
        productId,
        'barra_movimiento_color_texto',
        'single_line_text_field',
        typeof input.barraColorTexto === 'string' && input.barraColorTexto.trim() !== '' ? input.barraColorTexto : '#111',
        avisos,
      );
    }
    if (typeof input.barraVelocidad === 'number' && Number.isFinite(input.barraVelocidad) && input.barraVelocidad > 0) {
      await this.guardarMetafield(
        credenciales,
        productId,
        'barra_movimiento_velocidad',
        'number_integer',
        String(Math.round(input.barraVelocidad)),
        avisos,
      );
    }
  }

  // Código de la sección nueva del tema: dibuja la secuencia de la landing
  // (guardada en el metafield ecom_magnates.landing_secuencia — ver
  // guardarMetafieldSecuencia() más abajo) apilada a pantalla completa: cada
  // paso es una imagen o, donde el estudiante lo haya insertado con el "+"
  // en el taller, un botón "COMPRAR AHORA" real (formulario a /cart/add con
  // name="checkout", que agrega el producto y manda directo al pago de
  // Shopify — así el pedido queda como un pedido normal de Shopify, y si la
  // tienda tiene instalada la app de Dropi ("Dropify"), ese pedido se
  // sincroniza solo a Dropi, sin nada más que hacer acá). Si el producto NO
  // tiene esa secuencia guardada (landing publicada con una versión vieja
  // del taller, antes de que existiera el "+"), cae de vuelta a dibujar
  // simplemente todas las imágenes de la Multimedia, como antes. Además, si
  // el checkbox "📌 Botón flotante" del taller quedó activado (metafield
  // ecom_magnates.boton_flotante), dibuja ADEMÁS una barra fija abajo de la
  // pantalla, siempre visible mientras se hace scroll, con el mismo botón —
  // se deja un espacio en blanco al final de la secuencia del mismo alto de
  // esa barra para que no tape la última imagen/botón. No depende del bloque
  // de Descripción ni de ningún campo tipo "richtext" del tema.
  private readonly seccionLandingLiquid = [
    '{%- comment -%}',
    '  Sección creada automáticamente por Ecom Magnates: dibuja la landing',
    '  (imágenes + botones de comprar intercalados + botón flotante opcional)',
    '  a pantalla completa. No editar a mano, se sobrescribe si el backend la',
    '  vuelve a necesitar.',
    '{%- endcomment -%}',
    '{%- assign secuencia = product.metafields.ecom_magnates.landing_secuencia.value -%}',
    '{%- assign boton_flotante = product.metafields.ecom_magnates.boton_flotante.value -%}',
    '{%- assign boton_flotante_texto = product.metafields.ecom_magnates.boton_flotante_texto.value -%}',
    '{%- assign boton_flotante_color = product.metafields.ecom_magnates.boton_flotante_color.value -%}',
    '{%- assign boton_flotante_color_texto = product.metafields.ecom_magnates.boton_flotante_color_texto.value -%}',
    // Tarjeta "Agregar Movimiento" del Editor de Elementos — antes esta
    // animación estaba siempre encendida a la fuerza en los dos botones de
    // abajo; ahora depende de este metafield (apagada por defecto si nunca
    // se guardó, ver guardarMetafieldMovimiento más arriba).
    '{%- assign movimiento = product.metafields.ecom_magnates.landing_movimiento.value -%}',
    // Tarjeta "Agregar Barra de Movimiento" del Editor de Elementos: una
    // barra de texto que se desliza sola de un lado a otro, arriba de todo
    // el resto de la landing (imágenes/botones). Independiente de
    // "movimiento" (esa es la animación de los botones) — esta tiene su
    // propio interruptor, texto y color, igual patrón que boton_flotante.
    '{%- assign barra_movimiento = product.metafields.ecom_magnates.barra_movimiento.value -%}',
    '{%- assign barra_movimiento_texto = product.metafields.ecom_magnates.barra_movimiento_texto.value -%}',
    '{%- assign barra_movimiento_color = product.metafields.ecom_magnates.barra_movimiento_color.value -%}',
    '{%- assign barra_movimiento_color_texto = product.metafields.ecom_magnates.barra_movimiento_color_texto.value -%}',
    // Segundos que tarda la barra en dar una vuelta completa (slider de
    // velocidad del taller) — 14 por defecto si nunca se guardó.
    '{%- assign barra_movimiento_velocidad = product.metafields.ecom_magnates.barra_movimiento_velocidad.value -%}',
    // Animación de "pulso" del botón (crece y vuelve a su tamaño normal cada
    // tanto, para llamar la atención) — la animación se define UNA vez acá
    // (no se puede definir @keyframes dentro de un style="" en línea) y cada
    // botón de abajo solo la referencia por nombre con animation:. Antes era
    // un "shake" (temblor + rotación); se cambió a este pulso de escala a
    // pedido de Norbey el 03/09, calibrado con un video de referencia que
    // mandó: queda quieto la mayor parte del ciclo de 3s y crece ~6% en un
    // pulso breve antes de volver a su tamaño normal. Lo mismo para el scroll
    // infinito de la barra de movimiento (translateX de 0% a -50%): el
    // contenido de la barra se repite varias veces seguidas e idénticas, así
    // al llegar a -50% (el ancho de una sola copia) el loop vuelve a 0% sin
    // que se note ningún salto.
    '<style>@keyframes ecomMagnatesBtnPulse{0%,70%{transform:scale(1);}80%{transform:scale(1.06);}90%,100%{transform:scale(1);}}@keyframes ecomMagnatesBarraScroll{0%{transform:translateX(0);}100%{transform:translateX(-50%);}}</style>',
    '{%- if barra_movimiento -%}',
    '  {%- assign barra_texto_final = barra_movimiento_texto | default: "CALIDAD GARANTIZADA  •  ENVÍO RÁPIDO  •  PAGO SEGURO" -%}',
    '  <div style="width:100%; overflow:hidden; white-space:nowrap; background:{{ barra_movimiento_color | default: "#f0b90b" }};">',
    // "barra_movimiento_velocidad" guarda el valor BASE (8/14/22, botones
    // Lenta/Normal/Rápida) — como cada copia repite el texto 12 veces (ver
    // más abajo), hay que multiplicar la duración x12 para que la velocidad
    // en píxeles por segundo sea la misma sin importar cuántas repeticiones
    // haya (si no, se ve mucho más rápido de lo esperado — bug del 03/09).
    '    <div style="display:inline-block; animation:ecomMagnatesBarraScroll {{ barra_movimiento_velocidad | default: 14 | times: 12 }}s linear infinite; padding:9px 0;">',
    // El truco de loop sin salto (translateX de 0% a -50%) solo se ve bien si
    // el contenido de UNA sola copia ya es más ancho que la pantalla — con un
    // texto corto, esa copia queda angosta y se ve un tramo de color liso
    // (sin letras) hasta la copia siguiente (bug reportado por un estudiante
    // el 03/09). Por eso cada copia repite el texto 12 veces seguidas (no una
    // sola vez): siempre hay letras de punta a punta, sea cual sea el largo
    // del texto o el ancho de pantalla. Todo en una sola línea de este
    // arreglo (sin saltos entre los <span>) para que no se cuele ningún
    // espacio de más entre repeticiones.
    '      {%- for i in (1..12) -%}<span{% unless forloop.first %} aria-hidden="true"{% endunless %} style="display:inline-block; padding-right:36px; color:{{ barra_movimiento_color_texto | default: "#111" }}; font-weight:800; font-size:13px; letter-spacing:0.04em;">{{ barra_texto_final | escape }}</span>{%- endfor -%}',
    '      {%- for i in (1..12) -%}<span aria-hidden="true" style="display:inline-block; padding-right:36px; color:{{ barra_movimiento_color_texto | default: "#111" }}; font-weight:800; font-size:13px; letter-spacing:0.04em;">{{ barra_texto_final | escape }}</span>{%- endfor -%}',
    '    </div>',
    '  </div>',
    '{%- endif -%}',
    '<div style="width:100%; margin:0; padding:0; line-height:0; font-size:0;">',
    '  {%- if secuencia -%}',
    '    {%- for paso in secuencia -%}',
    '      {%- if paso.tipo == "boton_comprar" -%}',
    '        {%- if product.selected_or_first_available_variant -%}',
    // La tienda tiene instalada Releasit (Contra Entrega): su botón real
    // ("Pídela y Paga en Casa") vive en el bloque nativo de compra, con
    // id="rsi_buy_now_button" — visto con el inspector el 29/08. Ese botón
    // abre el formulario propio de Releasit (COD) en vez de mandar a /cart
    // como hacía nuestro <form action="/cart/add"> de antes. En vez de
    // reinventar ese formulario (arriesgado, no sabemos su lógica interna),
    // el botón de acá simplemente le hace clic A ESE MISMO botón real —
    // mismo resultado exacto que si el cliente lo tocara él mismo más abajo.
    // Si por lo que sea Releasit no está instalado o cambia ese id en el
    // futuro, cae de respaldo al viejo comportamiento (agregar al carrito
    // normal) para que el botón nunca quede sin hacer nada.
    '          <div style="margin:0 !important; padding:0 !important; font-size:0 !important; line-height:0 !important; display:block !important;">',
    '            <form id="rsi-fallback-form-{{ forloop.index }}" method="post" action="/cart/add" style="display:none !important;">',
    '              <input type="hidden" name="id" value="{{ product.selected_or_first_available_variant.id }}">',
    '              <input type="hidden" name="quantity" value="1">',
    '            </form>',
    '            <button',
    '              type="button"',
    '              onclick="var rsiBtn=document.getElementById(\'rsi_buy_now_button\'); if(rsiBtn){ rsiBtn.click(); } else { var f=document.getElementById(\'rsi-fallback-form-{{ forloop.index }}\'); if(f){ f.submit(); } }"',
    // border-radius grande (píldora) + el emoji de camión + animation:
    // referenciando el @keyframes de arriba, para que se vea y se mueva igual
    // que el botón amarillo real de Releasit. El texto sale de paso.texto —
    // lo que el estudiante haya escrito en el taller para ESE botón puntual
    // (ver realBotonComprarHtml) — y si no escribió nada cae en "COMPRAR AHORA".
    // El color (fondo y texto) también sale del taller, elegido con un
    // selector de color por botón — colorTexto ya viene calculado por el
    // taller según el contraste del fondo elegido, para que nunca quede
    // texto negro sobre un fondo oscuro (o blanco sobre uno claro).
    '              style="all:revert !important; box-sizing:border-box !important; display:block !important; width:100% !important; margin:0 !important; padding:16px !important; background:{{ paso.color | default: "#f0b90b" }} !important; color:{{ paso.colorTexto | default: "#111" }} !important; border:0 !important; font-family:inherit !important; font-size:15px !important; font-weight:800 !important; letter-spacing:0.03em !important; line-height:normal !important; text-align:center !important; text-transform:none !important; border-radius:999px !important; cursor:pointer !important; appearance:none !important; -webkit-appearance:none !important; box-shadow:0 2px 8px rgba(0,0,0,0.18) !important;{% if movimiento %} animation:ecomMagnatesBtnPulse 3s ease-in-out infinite !important;{% endif %}"',
    '            >🚚 {{ paso.texto | default: "COMPRAR AHORA" | escape }}</button>',
    '          </div>',
    '        {%- endif -%}',
    '      {%- else -%}',
    '        <img',
    '          src="{{ paso.url }}"',
    '          alt="{{ product.title | escape }}"',
    '          loading="lazy"',
    '          style="display:block; width:100%; margin:0; padding:0; border:0;"',
    '        >',
    '      {%- endif -%}',
    '    {%- endfor -%}',
    '  {%- else -%}',
    '    {%- for image in product.images -%}',
    '      <img',
    '        src="{{ image | image_url: width: 1500 }}"',
    '        alt="{{ image.alt | default: product.title | escape }}"',
    '        loading="lazy"',
    '        style="display:block; width:100%; margin:0; padding:0; border:0;"',
    '      >',
    '    {%- endfor -%}',
    '  {%- endif -%}',
    '  {%- if boton_flotante and product.selected_or_first_available_variant -%}',
    '    <div style="height:66px;"></div>',
    '  {%- endif -%}',
    '</div>',
    '{%- if boton_flotante and product.selected_or_first_available_variant -%}',
    '  <div style="position:fixed !important; left:0; right:0; bottom:0; z-index:999; padding:10px 14px; background:#fff; box-shadow:0 -2px 12px rgba(0,0,0,0.18);">',
    // Mismo enganche a Releasit que el botón intercalado de arriba (ver
    // comentario ahí): le hace clic al botón real de Releasit en vez de
    // mandar a /cart, con el viejo comportamiento de respaldo si no lo
    // encuentra. Mismo texto/color personalizable también (ver
    // guardarMetafieldBotonFlotanteTexto/Color más arriba) — si el estudiante
    // nunca los tocó en el taller, cae de vuelta a amarillo con "COMPRAR AHORA".
    '    <form id="rsi-fallback-form-flotante" method="post" action="/cart/add" style="display:none !important;">',
    '      <input type="hidden" name="id" value="{{ product.selected_or_first_available_variant.id }}">',
    '      <input type="hidden" name="quantity" value="1">',
    '    </form>',
    '    <button',
    '      type="button"',
    '      onclick="var rsiBtn=document.getElementById(\'rsi_buy_now_button\'); if(rsiBtn){ rsiBtn.click(); } else { var f=document.getElementById(\'rsi-fallback-form-flotante\'); if(f){ f.submit(); } }"',
    '      style="all:revert !important; box-sizing:border-box !important; display:block !important; width:100% !important; margin:0 !important; padding:14px !important; background:{{ boton_flotante_color | default: "#f0b90b" }} !important; color:{{ boton_flotante_color_texto | default: "#111" }} !important; border:0 !important; font-family:inherit !important; font-size:15px !important; font-weight:800 !important; letter-spacing:0.03em !important; line-height:normal !important; text-align:center !important; text-transform:none !important; border-radius:999px !important; cursor:pointer !important; appearance:none !important; -webkit-appearance:none !important; box-shadow:0 2px 8px rgba(0,0,0,0.18) !important;{% if movimiento %} animation:ecomMagnatesBtnPulse 3s ease-in-out infinite !important;{% endif %}"',
    '    >🚚 {{ boton_flotante_texto | default: "COMPRAR AHORA" | escape }}</button>',
    '  </div>',
    '{%- endif -%}',
    '',
    '{% schema %}',
    '{',
    '  "name": "Imágenes landing",',
    '  "settings": [],',
    '  "presets": [{ "name": "Imágenes landing" }]',
    '}',
    '{% endschema %}',
    '',
  ].join('\n');

  // Tipos de SECCIÓN (no de bloque) que en distintos temas corresponden a la
  // ficha de producto de siempre (título/precio/galería/comprar/descripción).
  // En Dawn y temas viejos se llama "main-product"; en Horizon se llama
  // "product-information" — se dejan los dos para no romper si algún
  // estudiante tiene un tema distinto.
  private readonly TIPOS_SECCION_PRODUCTO = ['product-information', 'main-product'];

  // Recorre TODOS los bloques de una sección, incluidos los anidados dentro
  // de otros bloques (en Horizon los bloques pueden venir varios niveles
  // adentro, ej. "product-details" > grupo > "price") — llama a "cb" con
  // cada uno para que decida si lo apaga.
  private recorrerBloques(blocks: any, cb: (block: any) => void): void {
    if (!blocks || typeof blocks !== 'object') return;
    for (const id of Object.keys(blocks)) {
      const block = blocks[id];
      if (!block || typeof block !== 'object') continue;
      cb(block);
      if (block.blocks) this.recorrerBloques(block.blocks, cb);
    }
  }

  // El bloque de la galería nativa (Multimedia) — en Horizon viene con el
  // tipo "_product-media-gallery". Se detecta por substring ("gallery" o
  // "media-gallery") para no depender del nombre exacto de cada tema.
  private esBloqueGaleriaNativa(block: any): boolean {
    const t = String(block?.type || '').toLowerCase();
    return t.includes('media-gallery') || t.includes('product-media');
  }

  // El bloque de texto que muestra la Descripción del producto (name
  // "Product description", o cualquier bloque cuyo texto incluya
  // "product.description"). Nuestra Descripción también lleva las mismas
  // fotos de la landing apiladas como respaldo (ver construirHtml), así que
  // si este bloque queda encendido, las fotos se repiten otra vez debajo de
  // la galería.
  private esBloqueDescripcionProducto(block: any): boolean {
    if (block?.name === 'Product description') return true;
    return /product\.description/.test(String(block?.settings?.text || ''));
  }

  // Dentro de la sección de producto (product-information / main-product) de
  // la plantilla, APAGA (con "disabled": true — el mismo mecanismo que ya
  // usa el propio tema para sus otros bloques) el bloque de galería nativa y
  // el de Descripción, en cualquier nivel de anidamiento. No se BORRAN los
  // bloques (en Horizon el de galería es "estático" y no se puede quitar del
  // JSON) y no se toca nada más de esa sección (precio, variantes, botón de
  // comprar, etc. quedan exactamente como el estudiante los tenga
  // configurados en su tema — no es cosa nuestra decidir eso). Así la
  // plantilla "landing" queda mostrando solo la sección propia
  // (landing-imagenes) a pantalla completa, sin la Multimedia ni la
  // Descripción duplicando las mismas fotos debajo. No toca ninguna otra
  // sección de la plantilla ni la plantilla NORMAL de producto. Muta
  // "plantilla" in place.
  private simplificarSeccionProducto(plantilla: any): void {
    const secciones = plantilla?.sections;
    if (!secciones || typeof secciones !== 'object') return;
    for (const key of Object.keys(secciones)) {
      const seccion = secciones[key];
      if (!seccion || !this.TIPOS_SECCION_PRODUCTO.includes(seccion.type) || !seccion.blocks) continue;
      const apagados: string[] = [];
      this.recorrerBloques(seccion.blocks, (block) => {
        if (block.disabled === true) return;
        if (this.esBloqueGaleriaNativa(block) || this.esBloqueDescripcionProducto(block)) {
          block.disabled = true;
          apagados.push(block.type || block.name || '?');
        }
      });
      if (apagados.length > 0) {
        this.logger.log(`Sección "${key}" de la plantilla "landing": bloques apagados (${apagados.join(', ')}).`);
      }
    }
  }

  // Se asegura de que el tema activo tenga la sección y la plantilla alterna
  // "landing" necesarias — las crea solo si todavía no existen (no toca nada
  // más si ya estaban, y nunca modifica la plantilla NORMAL de producto, así
  // que el resto del catálogo del estudiante no se ve afectado). Si la
  // plantilla "landing" ya existía (por ejemplo de antes de que existiera
  // simplificarSeccionProducto), se revisa y se repara en el momento si su
  // sección de producto todavía trae de más (galería, título, descripción,
  // etc.) — así las tiendas que ya tenían la plantilla creada también quedan
  // corregidas, sin necesidad de borrarla a mano. Si algo falla acá (por
  // ejemplo, el permiso de temas todavía no está activo), no debe tumbar la
  // publicación del producto — solo queda sin la plantilla especial (o sin
  // la reparación) por esta vez.
  private async asegurarPlantillaLanding(credenciales: ShopifyCredenciales, avisos?: string[]): Promise<void> {
    try {
      const temaId = await this.obtenerTemaActivoId(credenciales);

      // Se sobrescribe cada vez que el código de la sección cambió (comparación
      // de texto), no solo la primera vez — así, si este backend le agrega
      // capacidades nuevas a la sección (como los botones de comprar
      // intercalados), las tiendas que ya la tenían instalada también quedan
      // al día solas en la próxima publicación, sin tener que borrar nada a
      // mano. Si el texto es idéntico no hace ninguna llamada de más.
      //
      // OJO: si este guardarAsset falla y se queda silenciado (ver el catch
      // de abajo), la sección vieja se queda instalada en el tema — y si esa
      // versión vieja no sabía dibujar varios botones intercalados, en la
      // página real va a seguir apareciendo solo uno (o ninguno) aunque el
      // taller y el metafield ya tengan varios guardados bien. Por eso ahora
      // se avisa en vez de solo loguearlo.
      const seccionExistente = await this.obtenerAsset(credenciales, temaId, 'sections/landing-imagenes.liquid');
      if (seccionExistente !== this.seccionLandingLiquid) {
        await this.guardarAsset(credenciales, temaId, 'sections/landing-imagenes.liquid', this.seccionLandingLiquid);
        this.logger.log(seccionExistente === null ? 'Sección "landing-imagenes" creada en el tema.' : 'Sección "landing-imagenes" actualizada en el tema.');
      }

      const plantillaExistente = await this.obtenerAsset(credenciales, temaId, 'templates/product.landing.json');
      if (plantillaExistente === null) {
        const baseTexto = await this.obtenerAsset(credenciales, temaId, 'templates/product.json');
        const base = baseTexto ? JSON.parse(baseTexto) : { sections: {}, order: [] };
        base.sections = base.sections || {};
        base.order = Array.isArray(base.order) ? base.order : [];
        this.simplificarSeccionProducto(base);
        base.sections['landing_imagenes_auto'] = { type: 'landing-imagenes' };
        base.order = ['landing_imagenes_auto', ...base.order.filter((k: string) => k !== 'landing_imagenes_auto')];
        await this.guardarAsset(credenciales, temaId, 'templates/product.landing.json', JSON.stringify(base, null, 2));
        this.logger.log('Plantilla "product.landing.json" creada en el tema.');
      } else {
        try {
          const plantilla = JSON.parse(plantillaExistente);
          const antes = JSON.stringify(plantilla);
          this.simplificarSeccionProducto(plantilla);
          if (JSON.stringify(plantilla) !== antes) {
            await this.guardarAsset(credenciales, temaId, 'templates/product.landing.json', JSON.stringify(plantilla, null, 2));
            this.logger.log('Plantilla "product.landing.json" existente reparada: galería/descripción nativas apagadas.');
          }
        } catch (err) {
          this.logger.warn(`No se pudo revisar/reparar la plantilla "landing" existente: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      const mensaje = `No se pudo preparar la plantilla "landing" del tema (se sigue publicando el producto igual): ${(err as Error).message}`;
      this.logger.warn(mensaje);
      if (avisos) {
        avisos.push('No se pudo actualizar la sección de la landing en el tema — los botones "COMPRAR AHORA" intercalados pueden no verse bien en la página real. Volvé a publicar en un momento.');
      }
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
  // contenedor del tema, pero en varios temas ese contenedor recorta
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
    // HTML) y esconden todo el bloque, aunque sí tenga imágenes. Por eso se
    // agrega un textito real al principio: como el div que lo envuelve ya
    // tiene font-size:0, ese texto queda invisible en pantalla, pero sigue
    // contando como "hay texto" para que el tema no oculte el bloque
    // completo.
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

  // Guarda el texto/color personalizado del botón flotante, solo cuando el
  // taller efectivamente mandó algo para ese campo (typeof === 'string') —
  // así una landing vieja, o un reenvío desde una versión del taller que
  // todavía no tiene este selector, no pisa con vacío lo que ya estuviera
  // guardado. Se llama igual en "actualizar" y en "crear" (ver
  // publicarLanding más abajo).
  private async guardarPersonalizacionBotonFlotante(credenciales: ShopifyCredenciales, productId: number, input: PublicarLandingInput, avisos: string[]): Promise<void> {
    if (typeof input.botonFlotanteTexto === 'string' && input.botonFlotanteTexto.trim() !== '') {
      await this.guardarMetafieldBotonFlotanteTexto(credenciales, productId, input.botonFlotanteTexto, avisos);
    }
    if (typeof input.botonFlotanteColor === 'string' && input.botonFlotanteColor.trim() !== '') {
      await this.guardarMetafieldBotonFlotanteColor(
        credenciales,
        productId,
        input.botonFlotanteColor,
        typeof input.botonFlotanteColorTexto === 'string' && input.botonFlotanteColorTexto.trim() !== ''
          ? input.botonFlotanteColorTexto
          : '#111',
        avisos,
      );
    }
  }

  async publicarLanding(credenciales: ShopifyCredenciales, input: PublicarLandingInput): Promise<PublicarLandingResultado> {
    this.validarCredenciales(credenciales);
    if (!input?.imagenes || input.imagenes.length === 0) {
      throw new Error('La landing no tiene imágenes para publicar.');
    }
    if (!input.nombreProducto) {
      throw new Error('Falta el nombre del producto.');
    }

    // Junta avisos de cosas que fallen sin tumbar la publicación (metafield
    // que no se pudo guardar, sección del tema que no se pudo actualizar) —
    // se devuelven al final para que el taller se los pueda mostrar al
    // estudiante en vez de que se pierdan solo en los logs de Railway.
    const avisos: string[] = [];

    // Se asegura (una sola vez por tienda) de que el tema tenga la plantilla
    // alterna "landing" lista, antes de crear/actualizar el producto.
    await this.asegurarPlantillaLanding(credenciales, avisos);

    const handle = `landing-${this.slugify(input.nombreProducto)}-${input.landingNum || 1}`;
    const titulo = `${input.nombreProducto} — Landing ${input.landingNum || 1}`;
    // Todas las imágenes van a la Multimedia del producto (galería nativa) —
    // de ahí las toma también la sección automática "landing-imagenes" para
    // dibujarlas a pantalla completa.
    //
    // "position" se manda explícito (1, 2, 3...) en vez de confiar en que
    // Shopify devuelva las imágenes creadas en el mismo orden en que se
    // mandaron: la documentación oficial de Shopify NO garantiza eso salvo
    // que se fije "position" a mano. Sin esto, el cruce de más abajo (URL de
    // fal.media -> URL ya alojada en Shopify) podría emparejar mal una
    // imagen con el paso equivocado de la secuencia.
    const images = input.imagenes.map((src, i) => ({ src, position: i + 1 }));
    const precio = this.normalizarPrecio(input.precio);
    const precioComparacion = this.normalizarPrecioOpcional(input.precioComparacion);

    // ANTES: se buscaba primero si ya existía un producto con este handle
    // (misma landing reenviada) para actualizarlo en vez de crear uno nuevo.
    // A pedido de Norbey, "Volver a publicar" ahora SIEMPRE crea un producto
    // nuevo — sí, puede quedar duplicado en la tienda si se reenvía varias
    // veces, pero eso resuelve de raíz el problema del caché de Shopify (una
    // página nueva nunca puede estar cacheada de antes) y el estudiante
    // borra a mano el/los producto(s) viejo(s) que ya no necesite. Si el
    // "handle" ya existe (mismo producto/landing reenviado), Shopify no
    // rechaza la creación: le agrega solo un sufijo ("-1", "-2", etc.) para
    // que sea único, así que esto nunca falla por handle repetido.
    const crear = await this.llamarShopify(credenciales, '/products.json', {
      method: 'POST',
      body: JSON.stringify({
        product: {
          title: titulo,
          handle,
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

    // A partir de acá, "imagenesShopify[i]" es la URL DEFINITIVA de esa
    // imagen: la copia que Shopify alojó en su propio CDN (cdn.shopify.com),
    // no la del generador de IA (fal.media). Esto importa por dos motivos:
    // (1) fal.media es almacenamiento temporal, no pensado para quedar
    // alojado ahí para siempre — si en algún momento borra el archivo, una
    // landing ya publicada se rompería sola sin que nadie haya tocado nada;
    // (2) Shopify solo optimiza/convierte a WebP o AVIF automáticamente las
    // imágenes que él mismo aloja, nunca las que están solo hotlinkeadas
    // desde otro dominio. Se cruza por "position" (fijado arriba al armar
    // "images"), nunca por el orden en que vino el array de la respuesta,
    // porque Shopify no lo garantiza.
    const imagenesShopify: string[] = input.imagenes.map((original, i) => {
      const subida = (json.product.images || []).find((img: any) => img.position === i + 1);
      return subida?.src || original; // fallback defensivo: si por lo que sea no aparece, no rompe la publicación
    });

    // La descripción nativa (respaldo por si el tema no soporta la plantilla
    // alterna) se arma DESPUÉS de crear el producto, con las URLs ya
    // alojadas en Shopify — no se puede mandar en el mismo POST de arriba
    // porque esas URLs recién existen una vez que Shopify terminó de subir
    // las imágenes.
    const bodyHtml = this.construirHtml(imagenesShopify);
    const actualizarBody = await this.llamarShopify(credenciales, `/products/${json.product.id}.json`, {
      method: 'PUT',
      body: JSON.stringify({ product: { id: json.product.id, body_html: bodyHtml } }),
    });
    if (!actualizarBody.ok) {
      avisos.push(
        'El producto se creó bien, pero no se pudo terminar de actualizar la descripción con las imágenes ya optimizadas.',
      );
    }

    if (input.secuencia && input.secuencia.length > 0) {
      // Reemplaza cada URL de imagen de la secuencia por su copia ya alojada
      // en Shopify (ver comentario arriba) antes de guardarla en el
      // metafield — así la landing real (sections/landing-imagenes.liquid,
      // que dibuja "paso.url" tal cual viene) también queda apuntando a
      // Shopify, no a fal.media. Los pasos "boton_comprar" no tienen url, se
      // dejan tal cual.
      let idxImagen = 0;
      const secuenciaFinal: LandingSecuenciaPaso[] = input.secuencia.map((paso) => {
        if (paso.tipo === 'boton_comprar') return paso;
        const nuevaUrl = imagenesShopify[idxImagen] ?? paso.url;
        idxImagen++;
        return { ...paso, url: nuevaUrl };
      });
      await this.guardarMetafieldSecuencia(credenciales, json.product.id, secuenciaFinal, avisos);
    }
    await this.guardarMetafieldBotonFlotante(credenciales, json.product.id, !!input.botonFlotante, avisos);
    await this.guardarMetafieldMovimiento(credenciales, json.product.id, !!input.movimiento, avisos);
    await this.guardarMetafieldBarra(credenciales, json.product.id, !!input.barra, avisos);
    await this.guardarPersonalizacionBotonFlotante(credenciales, json.product.id, input, avisos);
    await this.guardarPersonalizacionBarra(credenciales, json.product.id, input, avisos);
    await this.publicarEnTiendaOnline(credenciales, json.product.id);
    this.logger.log(`Producto de Shopify creado: ${json.product.handle} (${credenciales.storeDomain})`);
    return {
      url: `https://${credenciales.storeDomain}/products/${json.product.handle}`,
      handle: json.product.handle,
      creada: true,
      avisos: avisos.length > 0 ? avisos : undefined,
    };
  }
}
