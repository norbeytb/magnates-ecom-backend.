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
  // OJO: reemplazado por "animacionBoton" (09/09) — se deja el campo viejo
  // sin usar para no romper compatibilidad con un frontend viejo que todavía
  // lo mande; publicarLanding() lo usa solo como respaldo si animacionBoton
  // no vino (ver ahí mismo).
  movimiento?: boolean;
  // Pedido 09/09: reemplaza a "movimiento" (booleano) por un selector de 4
  // animaciones para los botones "COMPRAR AHORA" (intercalados + flotante),
  // calcado del panel "Animación de botón" de una herramienta de referencia
  // que mostró Norbey. Valores válidos: 'ninguna' | 'sacudida' | 'rebote' |
  // 'pulsacion' (cualquier otro valor, o ausente, cae a 'ninguna' salvo que
  // "movimiento" venga en true, ver más abajo).
  animacionBoton?: string;
  // Pedido 09/09: ícono que se dibuja en TODOS los botones "COMPRAR AHORA"
  // de la landing, en vez del camión fijo de antes. Claves válidas (ver el
  // "{% case %}" de seccionLandingLiquid más abajo): 'ninguno' | 'carrito' |
  // 'bolsa' | 'tarjeta' | 'etiqueta' | 'camion' | 'flecha' | 'caja'. Una
  // clave desconocida o ausente cae a 'camion' (el ícono de antes).
  iconoBoton?: string;
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
  // OJO: reemplazado por guardarMetafieldAnimacionBoton (09/09) — se deja
  // este método y su metafield ("landing_movimiento") sin usar en el nuevo
  // flujo, solo como respaldo de lectura para landings viejas ya publicadas
  // (ver "{%- unless animacion_boton -%}" en seccionLandingLiquid), nunca se
  // vuelve a ESCRIBIR desde acá.
  private async guardarMetafieldMovimiento(credenciales: ShopifyCredenciales, productId: number, activo: boolean, avisos?: string[]): Promise<void> {
    await this.guardarMetafield(credenciales, productId, 'landing_movimiento', 'boolean', activo ? 'true' : 'false', avisos);
  }

  // Pedido 09/09: reemplaza a guardarMetafieldMovimiento — guarda SIEMPRE
  // (nunca condicional) para poder cambiarla o apagarla ("ninguna") en un
  // reenvío. La sección lee este metafield como fuente de verdad; solo si
  // nunca se guardó (landing vieja, nunca resubida con este código) cae de
  // respaldo al booleano viejo "landing_movimiento".
  private async guardarMetafieldAnimacionBoton(credenciales: ShopifyCredenciales, productId: number, animacion: string, avisos?: string[]): Promise<void> {
    await this.guardarMetafield(credenciales, productId, 'landing_animacion_boton', 'single_line_text_field', animacion, avisos);
  }

  // Pedido 09/09: ícono del botón "COMPRAR AHORA" — mismo criterio, se
  // guarda SIEMPRE para poder cambiarlo en un reenvío.
  private async guardarMetafieldIconoBoton(credenciales: ShopifyCredenciales, productId: number, icono: string, avisos?: string[]): Promise<void> {
    await this.guardarMetafield(credenciales, productId, 'landing_icono_boton', 'single_line_text_field', icono, avisos);
  }

  // Valores válidos del selector "Animación de botón" del taller — cualquier
  // otro valor (typo, versión vieja del frontend, etc.) cae a "ninguna" salvo
  // que venga el booleano viejo "movimiento" en true, para no desactivar sin
  // querer el pulso de landings armadas con una versión del taller que todavía
  // no manda animacionBoton.
  private readonly ANIMACIONES_BOTON_VALIDAS = ['ninguna', 'sacudida', 'rebote', 'pulsacion'];
  private normalizarAnimacionBoton(valor: string | undefined, legacyMovimiento: boolean | undefined): string {
    if (valor && this.ANIMACIONES_BOTON_VALIDAS.includes(valor)) return valor;
    return legacyMovimiento ? 'pulsacion' : 'ninguna';
  }

  // Mismo criterio para el ícono — una clave desconocida o ausente cae al
  // camión (el único ícono que existía antes de este cambio), así una
  // landing vieja o un frontend desactualizado siguen viendo lo mismo que ya
  // tenían.
  // "canasta" y "bolso" agregados 10/09 — pedido de Norbey con captura de
  // referencia de otra app: quería exactamente los mismos íconos de esa
  // captura, y estos dos faltaban (se habían dejado afuera al principio).
  private readonly ICONOS_BOTON_VALIDOS = ['ninguno', 'carrito', 'bolsa', 'canasta', 'tarjeta', 'etiqueta', 'camion', 'flecha', 'caja', 'bolso'];
  private normalizarIconoBoton(valor: string | undefined): string {
    return valor && this.ICONOS_BOTON_VALIDOS.includes(valor) ? valor : 'camion';
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
    // Pedido 09/09: reemplaza al viejo booleano "movimiento" (pulso sí/no)
    // por un selector de 4 animaciones — ver guardarMetafieldAnimacionBoton
    // más arriba. Si el metafield nuevo nunca se guardó (landing publicada
    // con una versión del taller anterior a este cambio, todavía sin
    // resubir), cae de respaldo al booleano viejo "landing_movimiento" para
    // no apagar sin querer un pulso que ya estaba activado.
    '{%- assign animacion_boton = product.metafields.ecom_magnates.landing_animacion_boton.value -%}',
    '{%- unless animacion_boton -%}',
    '  {%- if product.metafields.ecom_magnates.landing_movimiento.value -%}',
    '    {%- assign animacion_boton = "pulsacion" -%}',
    '  {%- else -%}',
    '    {%- assign animacion_boton = "ninguna" -%}',
    '  {%- endif -%}',
    '{%- endunless -%}',
    // Pedido 09/09: ícono del botón "COMPRAR AHORA", en vez del camión fijo
    // de antes — "camion" de respaldo para landings publicadas antes de este
    // cambio (nunca guardaron este metafield).
    '{%- assign icono_boton = product.metafields.ecom_magnates.landing_icono_boton.value | default: "camion" -%}',
    // Pedido 09/09: arma UNA vez el SVG del ícono elegido (según icono_boton)
    // para no repetir este "{% case %}" en el botón intercalado Y en el
    // flotante — los dos solo hacen "{{ icono_boton_svg }}". Los íconos son
    // el mismo set de trazos simples (estilo Feather Icons, "sin color": usan
    // stroke="currentColor" así heredan el color de texto que el estudiante
    // ya eligió para ESE botón, en vez de traer un color propio fijo — mismo
    // set que ICONOS_BOTON en el frontend, mantenerlos sincronizados si se
    // agrega/cambia alguno). "ninguno" deja el botón sin ícono, solo texto.
    '{%- capture icono_boton_svg -%}',
    '{%- case icono_boton -%}',
    '  {%- when "ninguno" -%}',
    '  {%- when "carrito" -%}',
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; vertical-align:-3px;"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path></svg>',
    '  {%- when "bolsa" -%}',
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; vertical-align:-3px;"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path><line x1="3" y1="6" x2="21" y2="6"></line><path d="M16 10a4 4 0 0 1-8 0"></path></svg>',
    '  {%- when "canasta" -%}',
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; vertical-align:-3px;"><path d="M9 4L7 10"></path><path d="M15 4l2 6"></path><path d="M5 10h14l-1.2 8.4a2 2 0 0 1-1.98 1.6H8.18a2 2 0 0 1-1.98-1.6L5 10z"></path><path d="M12 10v6"></path><path d="M9 13h6"></path></svg>',
    '  {%- when "tarjeta" -%}',
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; vertical-align:-3px;"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"></rect><line x1="1" y1="10" x2="23" y2="10"></line></svg>',
    '  {%- when "etiqueta" -%}',
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; vertical-align:-3px;"><path d="M20.59 13.41L13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg>',
    '  {%- when "flecha" -%}',
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; vertical-align:-3px;"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>',
    '  {%- when "caja" -%}',
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; vertical-align:-3px;"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>',
    '  {%- when "bolso" -%}',
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; vertical-align:-3px;"><path d="M4 9h16l-1.5 10.5a2 2 0 0 1-2 1.5H7.5a2 2 0 0 1-2-1.5L4 9z"></path><path d="M8 9V7a4 4 0 0 1 8 0v2"></path><circle cx="12" cy="14" r="1"></circle></svg>',
    '  {%- else -%}',
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; vertical-align:-3px;"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg>',
    '{%- endcase -%}',
    '{%- endcapture -%}',
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
    // tanto, para llamar la atención) — el @keyframes se define UNA vez acá
    // (no se puede definir dentro de un style="" en línea) y cada botón de
    // abajo lo referencia por nombre con animation:. Antes era un "shake"
    // (temblor + rotación); se cambió a este pulso de escala a pedido de
    // Norbey el 03/09, calibrado con un video de referencia que mandó: queda
    // quieto la mayor parte del ciclo de 3s y crece ~6% en un pulso breve
    // antes de volver a su tamaño normal.
    //
    // OJO: este @keyframes es solo el RESPALDO. El 03/09 Norbey mostró con
    // otro video que en su tienda real la propiedad animation: SÍ queda bien
    // puesta en el botón (confirmado con su propio inspector), pero el botón
    // igual se quedaba quieto — algo del lado de la tienda (muy probablemente
    // el CSS de accesibilidad "reducir movimiento" que traen varios temas,
    // Dawn incluido, que apaga TODAS las animaciones del sitio si el
    // visitante tiene esa preferencia activada en el sistema/navegador)
    // estaba ganándole a esta animación por CSS. Por eso ahora el pulso lo
    // maneja además un <script> (ver más abajo, después del botón flotante)
    // que lo recalcula a mano en cada frame — ese es el que manda de verdad.
    //
    // Lo mismo para el scroll infinito de la barra de movimiento (translateX
    // de 0% a -50%): el contenido de la barra se repite varias veces
    // seguidas e idénticas, así al llegar a -50% (el ancho de una sola
    // copia) el loop vuelve a 0% sin que se note ningún salto.
    '<style>@keyframes ecomMagnatesBtnPulse{0%,70%{transform:scale(1);}80%{transform:scale(1.06);}90%,100%{transform:scale(1);}}@keyframes ecomMagnatesBtnShake{0%,80%{transform:translateX(0);}84%{transform:translateX(-5px);}88%{transform:translateX(4px);}92%{transform:translateX(-3px);}96%{transform:translateX(2px);}100%{transform:translateX(0);}}@keyframes ecomMagnatesBtnBounce{0%,68%,100%{transform:translateY(0);}75%{transform:translateY(-8px);}82%{transform:translateY(0);}88%{transform:translateY(-4px);}94%{transform:translateY(0);}}@keyframes ecomMagnatesBarraScroll{0%{transform:translateX(0);}100%{transform:translateX(-50%);}}</style>',
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
    // Pedido 09/09 (5), reemplaza TODO el mecanismo anterior de "mover/clonar
    // por JavaScript el botón real de Releasit" (ver más abajo en el
    // historial de comentarios del <script> final para el detalle de cómo
    // era antes): Norbey consiguió, con capturas reales de código de dos
    // tiendas de estudiantes, el identificador EXACTO que Shopify le pone al
    // bloque nativo del botón de contra entrega cuando se agrega a mano
    // desde "Agregar bloque → Apps" en el editor de temas — uno para la
    // versión vieja de la app (se llamaba "Releasit") y otro para la
    // versión nueva (se renombró a "EasySell"), cada estudiante tiene
    // instalada una sola de las dos según cuándo se dio de alta. Con
    // Con "{% render <bloque> %}" (la forma documentada por Shopify para
    // dibujar un bloque de app, ver "App blocks for themes" en shopify.dev)
    // se le puede pedir a Shopify que dibuje ACÁ ese bloque real de la app,
    // nativo, sin ningún truco de JavaScript — es Shopify mismo quien lo
    // arma, exactamente igual que si el estudiante lo hubiera puesto a mano
    // en el editor. Como cada estudiante solo tiene UNA de las dos
    // versiones, se intentan las DOS acá abajo: la que no corresponda a la
    // app instalada en esa tienda no dibuja nada (Shopify no rompe la
    // página por una referencia a una app que no está instalada, solo la
    // deja vacía) y la que sí corresponde se ve normal.
    // OJO (11/09, tras varias vueltas fallidas): se probó primero con
    // "{% content_for 'block', id: ..., type: ... %}" para poder elegir el
    // bloque exacto por su id — Shopify lo rechazó siempre con "Liquid syntax
    // error... Error in tag 'content_for 'block'", tanto con id/type sacados
    // de una propiedad (bloque.id) como con el tipo escrito fijo. Investigando
    // (docs oficiales + foros), "content_for 'block', type:, id:" resultó ser
    // una función DISTINTA ("bloques estáticos": declarar un bloque nuevo con
    // un id/tipo fijo, escrito literal en el código, que Shopify autocompleta
    // solo) — no sirve para elegir, en tiempo real, uno ya existente entre
    // varios posibles. Para ESO (nuestro caso: ya sabemos qué bloque
    // encontramos con "where" y solo queremos dibujar ESE) la forma correcta y
    // documentada es "render" pasándole directo el bloque encontrado.
    // "asegurarBloquesRealesReleasit" (ver más abajo en el archivo) es quien
    // se encarga de que la plantilla realmente tenga estos dos bloques
    // declarados para esta posición puntual antes de que esta sección
    // intente usarlos — por eso acá se verifica con "section.blocks | where"
    // que el bloque exista de verdad antes de dibujarlo con render: si
    // todavía no se sincronizó (por ejemplo, la primera vez que se sube este
    // cambio, antes de que alguna landing de esa tienda se vuelva a
    // publicar), no se intenta nada raro y se cae directo al botón de
    // respaldo de siempre, sin arriesgarse a un error de Liquid por pedir un
    // bloque que no existe.
    '          <div style="margin:0 !important; padding:0 !important; font-size:0 !important; line-height:0 !important; display:block !important;">',
    '            <form id="rsi-fallback-form-{{ forloop.index }}" method="post" action="/cart/add" style="display:none !important;">',
    '              <input type="hidden" name="id" value="{{ product.selected_or_first_available_variant.id }}">',
    '              <input type="hidden" name="quantity" value="1">',
    '            </form>',
    '            {%- assign ecom_clave_old = "releasit_btn_" | append: forloop.index | append: "_old" -%}',
    '            {%- assign ecom_clave_new = "releasit_btn_" | append: forloop.index | append: "_new" -%}',
    '            {%- assign ecom_bloque_old = section.blocks | where: "id", ecom_clave_old | first -%}',
    '            {%- assign ecom_bloque_new = section.blocks | where: "id", ecom_clave_new | first -%}',
    '            <span class="ecomMagnatesRsiHueco">',
    '              <span class="ecomMagnatesRsiBloque">{%- if ecom_bloque_old -%}{%- render ecom_bloque_old -%}{%- endif -%}</span>',
    '              <span class="ecomMagnatesRsiBloque">{%- if ecom_bloque_new -%}{%- render ecom_bloque_new -%}{%- endif -%}</span>',
    '            <button',
    '              type="button"',
    '              class="ecomMagnatesRsiRespaldo {% if animacion_boton == \'sacudida\' %}ecomMagnatesShakeBtn{% elsif animacion_boton == \'rebote\' %}ecomMagnatesBounceBtn{% elsif animacion_boton == \'pulsacion\' %}ecomMagnatesPulseBtn{% endif %}"',
    '              onclick="var rsiBtn=document.getElementById(\'rsi_buy_now_button\'); if(rsiBtn){ rsiBtn.click(); } else { var f=document.getElementById(\'rsi-fallback-form-{{ forloop.index }}\'); if(f){ f.submit(); } }"',
    // El texto sale de paso.texto — lo que el estudiante haya escrito en el
    // taller para ESE botón puntual — y si no escribió nada cae en "COMPRAR
    // AHORA". El color (fondo y texto) también sale del taller. Este botón
    // ahora arranca OCULTO (display:none) — el script del final de la
    // sección lo muestra solo si ninguno de los dos bloques reales de arriba
    // llegó a dibujar algo (ver "ecomMagnatesRsiHueco" en ese script).
    '              style="all:revert !important; box-sizing:border-box !important; position:relative !important; display:none; width:100% !important; margin:0 !important; padding:16px !important; background:{{ paso.color | default: "#f0b90b" }} !important; color:{{ paso.colorTexto | default: "#111" }} !important; border:0 !important; font-family:inherit !important; font-size:15px !important; font-weight:800 !important; letter-spacing:0.03em !important; line-height:normal !important; text-align:center !important; text-transform:none !important; border-radius:999px !important; cursor:pointer !important; appearance:none !important; -webkit-appearance:none !important; box-shadow:0 2px 8px rgba(0,0,0,0.18) !important;{% if animacion_boton == \'sacudida\' %} animation:ecomMagnatesBtnShake 3s ease-in-out infinite !important;{% elsif animacion_boton == \'rebote\' %} animation:ecomMagnatesBtnBounce 3s ease-in-out infinite !important;{% elsif animacion_boton == \'pulsacion\' %} animation:ecomMagnatesBtnPulse 3s ease-in-out infinite !important;{% endif %}"',
    '            >{% unless icono_boton == "ninguno" %}<span style="position:absolute !important; left:16px !important; top:50% !important; transform:translateY(-50%) !important; display:flex !important; align-items:center !important; justify-content:center !important; color:{{ paso.colorTexto | default: "#111" }} !important; pointer-events:none !important;">{{ icono_boton_svg }}</span>{% endunless %}{{ paso.texto | default: "COMPRAR AHORA" | escape }}</button>',
    '            </span>',
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
    // Mismo mecanismo que el botón intercalado de arriba (bloque nativo real
    // vía content_for "block", ver el comentario grande ahí sobre
    // "ecomMagnatesRsiHueco") — clave fija "releasit_btn_flotante_old" /
    // "_new" en vez de un número, porque solo hay UN botón flotante por
    // landing (no está adentro del "for paso in secuencia").
    '    <form id="rsi-fallback-form-flotante" method="post" action="/cart/add" style="display:none !important;">',
    '      <input type="hidden" name="id" value="{{ product.selected_or_first_available_variant.id }}">',
    '      <input type="hidden" name="quantity" value="1">',
    '    </form>',
    '    {%- assign ecom_clave_old = "releasit_btn_flotante_old" -%}',
    '    {%- assign ecom_clave_new = "releasit_btn_flotante_new" -%}',
    '    {%- assign ecom_bloque_old = section.blocks | where: "id", ecom_clave_old | first -%}',
    '    {%- assign ecom_bloque_new = section.blocks | where: "id", ecom_clave_new | first -%}',
    '    <span class="ecomMagnatesRsiHueco">',
    '      <span class="ecomMagnatesRsiBloque">{%- if ecom_bloque_old -%}{%- render ecom_bloque_old -%}{%- endif -%}</span>',
    '      <span class="ecomMagnatesRsiBloque">{%- if ecom_bloque_new -%}{%- render ecom_bloque_new -%}{%- endif -%}</span>',
    '    <button',
    '      type="button"',
    '      class="ecomMagnatesRsiRespaldo {% if animacion_boton == \'sacudida\' %}ecomMagnatesShakeBtn{% elsif animacion_boton == \'rebote\' %}ecomMagnatesBounceBtn{% elsif animacion_boton == \'pulsacion\' %}ecomMagnatesPulseBtn{% endif %}"',
    '      onclick="var rsiBtn=document.getElementById(\'rsi_buy_now_button\'); if(rsiBtn){ rsiBtn.click(); } else { var f=document.getElementById(\'rsi-fallback-form-flotante\'); if(f){ f.submit(); } }"',
    // Igual que el intercalado: arranca oculto, el script del final lo
    // muestra solo si ninguno de los dos bloques reales dibujó algo.
    '      style="all:revert !important; box-sizing:border-box !important; position:relative !important; display:none; width:100% !important; margin:0 !important; padding:14px !important; background:{{ boton_flotante_color | default: "#f0b90b" }} !important; color:{{ boton_flotante_color_texto | default: "#111" }} !important; border:0 !important; font-family:inherit !important; font-size:15px !important; font-weight:800 !important; letter-spacing:0.03em !important; line-height:normal !important; text-align:center !important; text-transform:none !important; border-radius:999px !important; cursor:pointer !important; appearance:none !important; -webkit-appearance:none !important; box-shadow:0 2px 8px rgba(0,0,0,0.18) !important;{% if animacion_boton == \'sacudida\' %} animation:ecomMagnatesBtnShake 3s ease-in-out infinite !important;{% elsif animacion_boton == \'rebote\' %} animation:ecomMagnatesBtnBounce 3s ease-in-out infinite !important;{% elsif animacion_boton == \'pulsacion\' %} animation:ecomMagnatesBtnPulse 3s ease-in-out infinite !important;{% endif %}"',
    '    >{% unless icono_boton == "ninguno" %}<span style="position:absolute !important; left:16px !important; top:50% !important; transform:translateY(-50%) !important; display:flex !important; align-items:center !important; justify-content:center !important; color:{{ boton_flotante_color_texto | default: "#111" }} !important; pointer-events:none !important;">{{ icono_boton_svg }}</span>{% endunless %}{{ boton_flotante_texto | default: "COMPRAR AHORA" | escape }}</button>',
    '    </span>',
    '  </div>',
    '{%- endif -%}',
    // El pulso lo mueve este script (ver el comentario largo junto al botón
    // intercalado más arriba, sobre por qué se pasó de CSS puro a JS): busca
    // TODOS los botones marcados con la clase "ecomMagnatesPulseBtn" (el
    // intercalado y/o el flotante, los que estén agregados en esta landing
    // puntual — si ninguno tiene movimiento activado, la lista sale vacía y
    // el script no hace nada) y en cada frame les recalcula el "transform:
    // scale()" a mano según el mismo ciclo de 3s ya calibrado con el video
    // de Norbey (quieto hasta el 70%, crece hasta 90% en el ciclo, un 6% más
    // grande en el pico a los 2.4s), aplicándolo con .setProperty(...,
    // "important") para que le gane a cualquier otro estilo del tema o de
    // otra app que ande tocando ese mismo botón.
    // Mismo mecanismo de arriba (JS en vez de CSS puro), ahora generalizado a
    // las 3 animaciones del selector "Animación de botón" del taller
    // (Sacudida y Rebote agregadas el 08/09, además del Pulsación original).
    // Cada animación tiene su propia lista de botones (según la clase que le
    // haya tocado más arriba) y su propia fórmula de transform por cuadro,
    // calcada punto por punto de los mismos porcentajes que sus @keyframes
    // de respaldo (arriba en el <style>) para que JS y CSS coincidan si por
    // algún motivo ambos llegan a aplicarse a la vez.
    '<script>',
    '(function(){',
    '  var pulseEls = document.querySelectorAll(".ecomMagnatesPulseBtn");',
    '  var shakeEls = document.querySelectorAll(".ecomMagnatesShakeBtn");',
    '  var bounceEls = document.querySelectorAll(".ecomMagnatesBounceBtn");',
    '  if(!pulseEls.length && !shakeEls.length && !bounceEls.length) return;',
    '  function aplicar(list, v){ for(var i = 0; i < list.length; i++){ list[i].style.setProperty("transform", v, "important"); } }',
    '  function tick(ts){',
    '    var t = (ts % 3000) / 3000;',
    '    if(pulseEls.length){',
    '      var s = 1;',
    '      if(t > 0.70 && t <= 0.80){ s = 1 + 0.06 * ((t - 0.70) / 0.10); }',
    '      else if(t > 0.80 && t <= 0.90){ s = 1.06 - 0.06 * ((t - 0.80) / 0.10); }',
    '      aplicar(pulseEls, "scale(" + s.toFixed(4) + ")");',
    '    }',
    '    if(shakeEls.length){',
    '      var x = 0;',
    '      if(t > 0.80 && t <= 0.84){ x = -5 * ((t - 0.80) / 0.04); }',
    '      else if(t > 0.84 && t <= 0.88){ x = -5 + 9 * ((t - 0.84) / 0.04); }',
    '      else if(t > 0.88 && t <= 0.92){ x = 4 - 7 * ((t - 0.88) / 0.04); }',
    '      else if(t > 0.92 && t <= 0.96){ x = -3 + 5 * ((t - 0.92) / 0.04); }',
    '      else if(t > 0.96){ x = 2 - 2 * ((t - 0.96) / 0.04); }',
    '      aplicar(shakeEls, "translateX(" + x.toFixed(2) + "px)");',
    '    }',
    '    if(bounceEls.length){',
    '      var y = 0;',
    '      if(t > 0.68 && t <= 0.75){ y = -8 * ((t - 0.68) / 0.07); }',
    '      else if(t > 0.75 && t <= 0.82){ y = -8 + 8 * ((t - 0.75) / 0.07); }',
    '      else if(t > 0.82 && t <= 0.88){ y = -4 * ((t - 0.82) / 0.06); }',
    '      else if(t > 0.88 && t <= 0.94){ y = -4 + 4 * ((t - 0.88) / 0.06); }',
    '      aplicar(bounceEls, "translateY(" + y.toFixed(2) + "px)");',
    '    }',
    '    requestAnimationFrame(tick);',
    '  }',
    '  requestAnimationFrame(tick);',
    '})();',
    '</script>',
    // Pedido 09/09 (5): reemplaza TODO el mecanismo anterior de mover/clonar
    // por JavaScript el botón real de Releasit (esa versión vieja quedó
    // documentada en el historial de git si hace falta volver a mirarla).
    // Ahora el botón real se dibuja de forma NATIVA con content_for "block"
    // (ver "ecomMagnatesRsiHueco" más arriba, en el botón intercalado y en
    // el flotante) — así que este script ya NO necesita mover ni copiar
    // nada. Su único trabajo es: si NINGUNO de los dos bloques reales
    // (Releasit viejo / EasySell nuevo) llegó a dibujar algo — porque esa
    // tienda tiene otra app de contra entrega, o todavía no tiene ninguna,
    // o la plantilla no se sincronizó a tiempo — mostrar el botón de
    // respaldo de siempre (que ya venía oculto por defecto, ver
    // "ecomMagnatesRsiRespaldo" arriba) para que el visitante nunca se
    // quede sin ningún botón para comprar. Se corre UNA sola vez al cargar
    // la página (los bloques de apps se dibujan del lado del servidor, ya
    // vienen listos en el HTML — no hace falta ningún MutationObserver como
    // antes, que era para el widget flotante que Releasit creaba por JS).
    '<script>',
    '(function(){',
    '  function tieneContenidoReal(nodo){',
    '    if(!nodo) return false;',
    '    if(nodo.querySelector("button, a, input, iframe")) return true;',
    '    return nodo.textContent.replace(/\\s+/g, "") !== "";',
    '  }',
    '  var huecos = document.querySelectorAll(".ecomMagnatesRsiHueco");',
    '  for(var i = 0; i < huecos.length; i++){',
    '    var hueco = huecos[i];',
    '    var bloques = hueco.querySelectorAll(".ecomMagnatesRsiBloque");',
    '    var hayReal = false;',
    '    for(var j = 0; j < bloques.length; j++){',
    '      if(tieneContenidoReal(bloques[j])){ hayReal = true; break; }',
    '    }',
    '    if(!hayReal){',
    '      var respaldo = hueco.querySelector(".ecomMagnatesRsiRespaldo");',
    '      if(respaldo){ respaldo.style.display = "block"; }',
    '    }',
    '  }',
    '})();',
    '</script>',
    '',
    '{% schema %}',
    '{',
    '  "name": "Imágenes landing",',
    '  "settings": [],',
    // Pedido 09/09 (5): habilita que esta sección pueda alojar bloques de
    // OTRAS apps (Releasit/EasySell, la del botón de contra entrega) — sin
    // esto Shopify no deja referenciar ningún "shopify://apps/..." en las
    // plantillas que usan esta sección (ver más abajo, "releasit_btn_...").
    '  "blocks": [{ "type": "@app" }],',
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

  // Nombre de archivo de la plantilla alterna (bug encontrado el 04/09, con
  // una landing real de un estudiante que mostraba contenido completamente
  // ajeno — testimonio de "Cristiano Ronaldo", "resultados clínicos" en un
  // producto de cocina, etc.): antes este archivo se llamaba
  // "templates/product.landing.json" — un nombre genérico que CUALQUIER otra
  // app de landings/page-builder, o incluso el propio estudiante armando una
  // plantilla alterna a mano, puede haber creado antes en esa misma tienda
  // con el mismo nombre exacto. asegurarPlantillaLanding() solo "repara" una
  // plantilla que ya existe (nunca la reconstruye de cero, para no borrar
  // configuración ajena) — así que si esa tienda ya tenía un
  // "product.landing.json" de otra cosa, este backend lo daba por nuestro y
  // jamás le agregaba la sección real de la landing, dejando visible el
  // contenido viejo/genérico de lo que sea que lo haya creado antes. Fix:
  // usar un nombre único de nuestra marca, que ninguna otra app ni ningún
  // estudiante va a usar por casualidad — así la primera vez que se publica
  // en una tienda SIEMPRE se crea de cero, nunca se "hereda" contenido ajeno.
  private readonly ARCHIVO_PLANTILLA_LANDING = 'templates/product.ecom-magnates-landing.json';
  private readonly SUFIJO_PLANTILLA_LANDING = 'ecom-magnates-landing';

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

  // Saca de la plantilla "landing" cualquier sección que NO sea la nuestra
  // (landing_imagenes_auto) ni la de producto (main-product/product-information
  // — ver TIPOS_SECCION_PRODUCTO, la que trae precio/variantes/botón de
  // comprar nativo). Bug reportado el 08/09 por un estudiante de Norbey: al
  // crear la plantilla "landing" por primera vez en la tienda de ESE
  // estudiante, este backend parte de su "templates/product.json" (la
  // plantilla NORMAL de esa tienda) como base — y esa plantilla normal ya
  // traía un montón de secciones propias del tema para vender el producto en
  // la ficha de siempre (resultados clínicos, antes y después, testimonios,
  // preguntas frecuentes, etc.). Como antes solo se apagaban los bloques de
  // galería/descripción DENTRO de la sección de producto, todas esas OTRAS
  // secciones quedaban intactas y se veían apiladas debajo de la landing —
  // el "enredo" que reportó Norbey, mezclando la landing limpia con todo el
  // contenido de venta genérico que ya tenía esa tienda. Fix: además de
  // simplificar la sección de producto, se borran del "order" (y de
  // "sections") todas las secciones que no sean ni la nuestra ni la de
  // producto — así la plantilla "landing" muestra ÚNICAMENTE la landing
  // (imágenes + botones) y el bloque de comprar/precio/variantes de siempre,
  // nada más, sea cual sea el tema o las secciones extra que tenga esa
  // tienda puntual en su plantilla normal.
  // Identificadores fijos que Shopify le asigna al bloque nativo del botón
  // de contra entrega de Releasit/EasySell cuando se agrega a mano desde
  // "Agregar bloque → Apps" en el editor de temas — confirmados el 09/09
  // con capturas reales de código de DOS tiendas de estudiantes distintas:
  // una con la versión vieja de la app (se llamaba "Releasit") y otra con
  // la versión nueva (se renombró a "EasySell"). Cada estudiante tiene
  // instalada una sola de las dos, nunca las dos a la vez — por eso en
  // seccionLandingLiquid se intentan las DOS en cada punto donde haya un
  // botón: la que no corresponda a la app de esa tienda no dibuja nada
  // (Shopify no rompe la página por referenciar una app no instalada), y
  // la que sí corresponde se ve normal, con su propio estilo/texto/
  // comportamiento real, sin ningún truco de JavaScript.
  private readonly BLOQUE_RELEASIT_VIEJO =
    'shopify://apps/releasit-cod-form/blocks/button-app-block/72faf214-4174-4fec-886b-0d0e8d3af9a2';
  private readonly BLOQUE_RELEASIT_NUEVO =
    'shopify://apps/easysell-cod-form/blocks/app-block/7bfd0a95-6839-4f02-b2ee-896832dbe67e';

  // Arma la lista de claves de bloque que ESTA landing puntual necesita
  // según su secuencia (2 claves — vieja/nueva, ver arriba — por cada paso
  // "boton_comprar", más 2 para el flotante si está activado).
  private clavesBloquesBotonesNecesarias(
    secuencia: LandingSecuenciaPaso[] | undefined,
    botonFlotante: boolean | undefined,
  ): string[] {
    const claves: string[] = [];
    (secuencia || []).forEach((paso, i) => {
      if (paso.tipo === 'boton_comprar') {
        claves.push(`releasit_btn_${i + 1}_old`, `releasit_btn_${i + 1}_new`);
      }
    });
    if (botonFlotante) {
      claves.push('releasit_btn_flotante_old', 'releasit_btn_flotante_new');
    }
    return claves;
  }

  // Se asegura de que la sección "landing_imagenes_auto" de la plantilla
  // tenga declarado, para cada posición donde ESTA landing puntual necesite
  // un botón "comprar", los bloques nativos de Releasit/EasySell — así
  // seccionLandingLiquid los puede pedir con content_for "block" sin
  // arriesgarse a referenciar un bloque que no existe (ver el comentario
  // grande sobre "ecomMagnatesRsiHueco" en seccionLandingLiquid). Como esta
  // plantilla la comparten TODAS las landings de la misma tienda, nunca se
  // borra ningún bloque ya existente acá (otra landing puede seguir
  // necesitándolo) — solo se agregan los que falten.
  private asegurarBloquesRealesReleasit(plantilla: any, clavesNecesarias: string[]): void {
    const seccion = plantilla?.sections?.['landing_imagenes_auto'];
    if (!seccion || !clavesNecesarias.length) return;
    seccion.blocks = seccion.blocks && typeof seccion.blocks === 'object' ? seccion.blocks : {};
    seccion.block_order = Array.isArray(seccion.block_order) ? seccion.block_order : [];
    for (const clave of clavesNecesarias) {
      const tipo = clave.endsWith('_old') ? this.BLOQUE_RELEASIT_VIEJO : this.BLOQUE_RELEASIT_NUEVO;
      if (!seccion.blocks[clave]) {
        seccion.blocks[clave] = { type: tipo, settings: { product: '{{product}}' } };
      }
      if (!seccion.block_order.includes(clave)) {
        seccion.block_order.push(clave);
      }
    }
  }

  private limpiarSeccionesAjenas(plantilla: any): void {
    const secciones = plantilla?.sections;
    if (!secciones || typeof secciones !== 'object' || !Array.isArray(plantilla.order)) return;
    const conservar = (key: string): boolean => {
      if (key === 'landing_imagenes_auto') return true;
      return this.TIPOS_SECCION_PRODUCTO.includes(secciones[key]?.type);
    };
    plantilla.order = plantilla.order.filter(conservar);
    for (const key of Object.keys(secciones)) {
      if (!conservar(key)) delete secciones[key];
    }
  }

  // Se asegura de que el tema activo tenga la sección y la plantilla alterna
  // "landing" necesarias — las crea solo si todavía no existen (no toca nada
  // más si ya estaban, y nunca modifica la plantilla NORMAL de producto, así
  // que el resto del catálogo del estudiante no se ve afectado). Si la
  // plantilla "landing" ya existía (por ejemplo de antes de que existiera
  // simplificarSeccionProducto o limpiarSeccionesAjenas), se revisa y se
  // repara en el momento si su sección de producto todavía trae de más
  // (galería, título, descripción, etc.) o si tiene secciones ajenas
  // colgando (ver limpiarSeccionesAjenas) — así las tiendas que ya tenían la
  // plantilla creada (aunque sea con el bug del 08/09 ya publicado) también
  // quedan corregidas solas en la próxima publicación, sin necesidad de
  // borrar nada a mano: como todas las landings de una misma tienda
  // comparten este mismo archivo de plantilla, con reparar el archivo una
  // vez alcanza para que TODAS esas landings (viejas y nuevas) se vean
  // limpias. Si algo falla acá (por ejemplo, el permiso de temas todavía no
  // está activo), no debe tumbar la publicación del producto — solo queda
  // sin la plantilla especial (o sin la reparación) por esta vez.
  private async asegurarPlantillaLanding(
    credenciales: ShopifyCredenciales,
    clavesBotones: string[],
    avisos?: string[],
  ): Promise<void> {
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

      const plantillaExistente = await this.obtenerAsset(credenciales, temaId, this.ARCHIVO_PLANTILLA_LANDING);
      if (plantillaExistente === null) {
        const baseTexto = await this.obtenerAsset(credenciales, temaId, 'templates/product.json');
        const base = baseTexto ? JSON.parse(baseTexto) : { sections: {}, order: [] };
        base.sections = base.sections || {};
        base.order = Array.isArray(base.order) ? base.order : [];
        this.simplificarSeccionProducto(base);
        base.sections['landing_imagenes_auto'] = { type: 'landing-imagenes' };
        base.order = ['landing_imagenes_auto', ...base.order.filter((k: string) => k !== 'landing_imagenes_auto')];
        this.limpiarSeccionesAjenas(base);
        this.asegurarBloquesRealesReleasit(base, clavesBotones);
        await this.guardarAsset(credenciales, temaId, this.ARCHIVO_PLANTILLA_LANDING, JSON.stringify(base, null, 2));
        this.logger.log(`Plantilla "${this.ARCHIVO_PLANTILLA_LANDING}" creada en el tema.`);
      } else {
        try {
          const plantilla = JSON.parse(plantillaExistente);
          const antes = JSON.stringify(plantilla);
          this.simplificarSeccionProducto(plantilla);
          // Defensivo: como esta plantilla ahora vive en un archivo con
          // nombre único de nuestra marca (ver comentario grande arriba de
          // ARCHIVO_PLANTILLA_LANDING), en teoría SIEMPRE es una que nosotros
          // mismos creamos antes — pero por si quedó guardada sin la sección
          // "landing_imagenes_auto" (por ejemplo, un estudiante la borró sin
          // querer editando el tema a mano), se vuelve a agregar acá también,
          // no solo en la rama de creación de arriba.
          plantilla.sections = plantilla.sections || {};
          plantilla.order = Array.isArray(plantilla.order) ? plantilla.order : [];
          if (plantilla.sections['landing_imagenes_auto']?.type !== 'landing-imagenes') {
            plantilla.sections['landing_imagenes_auto'] = { type: 'landing-imagenes' };
          }
          if (!plantilla.order.includes('landing_imagenes_auto')) {
            plantilla.order = ['landing_imagenes_auto', ...plantilla.order];
          }
          this.limpiarSeccionesAjenas(plantilla);
          this.asegurarBloquesRealesReleasit(plantilla, clavesBotones);
          if (JSON.stringify(plantilla) !== antes) {
            await this.guardarAsset(credenciales, temaId, this.ARCHIVO_PLANTILLA_LANDING, JSON.stringify(plantilla, null, 2));
            this.logger.log(`Plantilla "${this.ARCHIVO_PLANTILLA_LANDING}" existente reparada.`);
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
    await this.asegurarPlantillaLanding(
      credenciales,
      this.clavesBloquesBotonesNecesarias(input.secuencia, input.botonFlotante),
      avisos,
    );

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
          template_suffix: this.SUFIJO_PLANTILLA_LANDING,
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
    await this.guardarMetafieldAnimacionBoton(credenciales, json.product.id, this.normalizarAnimacionBoton(input.animacionBoton, input.movimiento), avisos);
    await this.guardarMetafieldIconoBoton(credenciales, json.product.id, this.normalizarIconoBoton(input.iconoBoton), avisos);
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
