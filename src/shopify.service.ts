// shopify.service.ts
//
// Publica una landing ensamblada (una lista de imágenes ya generadas) como un
// PRODUCTO en la tienda de Shopify del cliente, usando la Admin API. Todas
// las imágenes suben a la Multimedia del producto, y ADEMÁS este backend le
// prepara automáticamente al tema del cliente una plantilla alterna
// "landing" con una sección propia que dibuja esas mismas imágenes una
// debajo de otra, a pantalla completa (sin título/reseñas encima) — ver
// asegurarPlantillaLanding() más abajo. Esto es lo mismo que hacen otras
// herramientas de landings: le agregan al tema su propia sección al
// instalarse, en vez de depender del bloque de "Descripción" del tema (que
// en muchos temas nuevos —como el tema Horizon del cliente— usa un campo de
// tipo "richtext" que no acepta imágenes sueltas). Además, la sección normal
// de producto de esa plantilla se recorta (simplificarSeccionProducto) para
// que solo queden el precio y el botón nativo de comprar debajo de las
// imágenes — nada de galería/título/descripción duplicados. Esa preparación
// del tema se hace UNA sola vez por tienda (revisa si ya existe antes de
// crear nada, y repara sola la plantilla si ya existía de antes de este
// recorte) y no requiere que el estudiante toque el editor del tema. El
// precio se toma de la Ficha Técnica (Oferta → Precio 1) que el usuario ya
// llenó en el taller.
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
//   read_products,write_products,read_themes,write_themes,write_publications
// (read_themes/write_themes son para poder crearle al tema la plantilla/
// sección automática de la landing — ver asegurarPlantillaLanding().
// write_publications es NUEVO y es imprescindible: sin él el producto queda
// creado pero NUNCA se ve en la tienda pública, solo en la vista previa del
// admin — ver publicarEnTiendaOnline() más abajo. Si se agrega este scope a
// una app que ya estaba instalada, Shopify no lo re-otorga solo: hay que
// guardar una versión nueva en el Dev Dashboard y REINSTALAR la app en la
// tienda, igual que la vez que se agregó read_products/write_products).
//
// Reenviar la misma landing (mismo producto + mismo número de landing) actualiza
// el producto ya creado en vez de duplicarlo: se identifica por un "handle" fijo.

import { Injectable, Logger } from '@nestjs/common';

// Un paso de la secuencia editable de la landing: o una imagen (el orden en
// que se suben a la Multimedia) o un marcador de "botón de comprar" que el
// estudiante insertó a mano con el "+" en la vista previa del taller — ver
// enviarLandingAShopify() en el frontend. La sección del tema dibuja cada
// paso en el mismo orden en que viene, así el botón queda exactamente donde
// el estudiante lo puso dentro de las imágenes (no solo al final).
export type LandingSecuenciaPaso = { tipo: 'imagen'; url: string } | { tipo: 'boton_comprar' };

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

interface TokenEnCache {
  token: string;
  expiraEn: number; // timestamp epoch ms
}

@Injectable()
export class ShopifyService {
  private readonly logger = new Logger(ShopifyService.name);
  private readonly apiVersion = '2026-07';
  private tokenEnCache: TokenEnCache | null = null;
  // Id (GraphQL) del canal "Tienda online" — se busca una sola vez y se
  // reutiliza, ver obtenerPublicationIdTiendaOnline() más abajo.
  private publicationIdTiendaOnline: string | null = null;

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

  // Llama al endpoint de GraphQL de la Admin API (mismo dominio/token que
  // llamarShopify). Usado solo para publicar el producto en el canal
  // "Tienda online" — ver publicarEnTiendaOnline() más abajo — porque eso ya
  // no se puede hacer de forma confiable por REST (Shopify lo dejó solo en
  // GraphQL, con la mutación publishablePublish).
  private async graphql(query: string, variables?: Record<string, unknown>): Promise<any> {
    const resp = await this.llamarShopify('/graphql.json', {
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

  // Busca (una sola vez, se cachea) el id del canal "Tienda online" — el que
  // hay que usar para que el producto se pueda ver en la URL pública de la
  // tienda, no solo en la vista previa del admin. Este backend lo va a usar
  // cualquier estudiante con SU PROPIA tienda (no solo la del cliente
  // original), y el admin de cada tienda puede estar en cualquier idioma —
  // así que no alcanza con buscar el canal por el texto "Online Store" (ese
  // nombre puede venir traducido, ej. "Tienda online" en español, y además
  // Shopify lo tiene marcado como campo obsoleto). Por eso se intenta primero
  // por el id de la app del canal (fijo, no cambia con el idioma) y solo si
  // eso no aparece, se cae de vuelta a buscar por nombre probando las
  // traducciones más comunes.
  private async obtenerPublicationIdTiendaOnline(): Promise<string> {
    if (this.publicationIdTiendaOnline) return this.publicationIdTiendaOnline;
    const data = await this.graphql(`{
      publications(first: 20) {
        edges {
          node {
            id
            name
            channels(first: 5) { edges { node { app { id } } } }
          }
        }
      }
    }`);
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
    this.publicationIdTiendaOnline = nodo.id;
    return nodo.id;
  }

  // Publica el producto en el canal "Tienda online" — IMPRESCINDIBLE para
  // que la landing se vea en la URL pública para cualquier visitante. Antes
  // este backend solo mandaba status:"active" al crear/actualizar el
  // producto por REST, lo cual lo deja activo EN EL ADMIN pero, en las
  // versiones actuales de la API de Shopify, ya NO lo publica solo en
  // ningún canal de venta — por eso la landing se veía bien en la vista
  // previa del editor de temas (el admin sí puede ver productos sin
  // publicar) pero daba 404 para un visitante cualquiera. Se llama después
  // de crear/actualizar el producto, tanto en la primera publicación como en
  // cada reenvío (si ya estaba publicado, volver a publicarlo no hace daño).
  // Si esto falla (por ejemplo porque el scope write_publications todavía no
  // está en la app — hay que agregarlo en el Dev Dashboard y reinstalar,
  // igual que la vez pasada con los scopes de productos), no debe tumbar la
  // publicación: el producto igual queda creado/actualizado, solo sin
  // publicar en el canal por esta vez.
  private async publicarEnTiendaOnline(productId: number): Promise<void> {
    try {
      const publicationId = await this.obtenerPublicationIdTiendaOnline();
      const data = await this.graphql(
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
      this.logger.log(`Producto ${productId} publicado en el canal "Tienda online".`);
    } catch (err) {
      this.logger.warn(`No se pudo publicar el producto ${productId} en el canal "Tienda online" (revisa el scope write_publications en la app): ${(err as Error).message}`);
    }
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
  private async guardarMetafield(productId: number, key: string, type: string, value: string, avisos?: string[]): Promise<void> {
    try {
      // Shopify no deja "POST" dos veces el mismo namespace+key en un
      // producto (da error de duplicado) — hay que revisar primero si ya
      // existe (de una publicación anterior de esta misma landing) para
      // actualizarlo (PUT) en vez de crearlo de nuevo, o el dato se quedaría
      // pegado en la primera versión para siempre en los reenvíos.
      const buscar = await this.llamarShopify(`/products/${productId}/metafields.json?namespace=ecom_magnates&key=${encodeURIComponent(key)}`);
      if (!buscar.ok) throw new Error(`HTTP ${buscar.status} al buscar el metafield "${key}": ${await buscar.text()}`);
      const buscarJson: any = await buscar.json();
      const existente = buscarJson?.metafields?.[0];

      const resp = existente
        ? await this.llamarShopify(`/products/${productId}/metafields/${existente.id}.json`, {
            method: 'PUT',
            body: JSON.stringify({ metafield: { id: existente.id, type, value } }),
          })
        : await this.llamarShopify(`/products/${productId}/metafields.json`, {
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
  private async guardarMetafieldSecuencia(productId: number, secuencia: LandingSecuenciaPaso[], avisos?: string[]): Promise<void> {
    await this.guardarMetafield(productId, 'landing_secuencia', 'json', JSON.stringify(secuencia), avisos);
  }

  // El metafield del "Botón Flotante" (checkbox del taller): si está
  // activado, la sección dibuja una barra fija abajo de la pantalla con el
  // botón de comprar, que sigue al visitante mientras hace scroll — además
  // de (no en vez de) los botones intercalados entre imágenes. Se guarda
  // SIEMPRE (true o false), a diferencia de la secuencia, para que también
  // se pueda APAGAR en un reenvío si el estudiante desmarca el checkbox.
  private async guardarMetafieldBotonFlotante(productId: number, activo: boolean, avisos?: string[]): Promise<void> {
    await this.guardarMetafield(productId, 'boton_flotante', 'boolean', activo ? 'true' : 'false', avisos);
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
    '<div style="width:100%; margin:0; padding:0; line-height:0; font-size:0;">',
    '  {%- if secuencia -%}',
    '    {%- for paso in secuencia -%}',
    '      {%- if paso.tipo == "boton_comprar" -%}',
    '        {%- if product.selected_or_first_available_variant -%}',
    '          <form method="post" action="/cart/add" style="margin:0; padding:0; font-size:0; line-height:0;">',
    '            <input type="hidden" name="id" value="{{ product.selected_or_first_available_variant.id }}">',
    '            <input type="hidden" name="quantity" value="1">',
    '            <button',
    '              type="submit"',
    '              name="checkout"',
    '              style="display:block; width:100%; margin:0; padding:16px; background:#000; color:#fff; border:0; font-size:15px; font-weight:800; letter-spacing:0.03em; border-radius:4px; cursor:pointer;"',
    '            >COMPRAR AHORA</button>',
    '          </form>',
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
    '  <div style="position:fixed; left:0; right:0; bottom:0; z-index:999; padding:10px 14px; background:#fff; box-shadow:0 -2px 12px rgba(0,0,0,0.18);">',
    '    <form method="post" action="/cart/add" style="margin:0;">',
    '      <input type="hidden" name="id" value="{{ product.selected_or_first_available_variant.id }}">',
    '      <input type="hidden" name="quantity" value="1">',
    '      <button',
    '        type="submit"',
    '        name="checkout"',
    '        style="display:block; width:100%; margin:0; padding:14px; background:#000; color:#fff; border:0; font-size:15px; font-weight:800; letter-spacing:0.03em; border-radius:4px; cursor:pointer;"',
    '      >COMPRAR AHORA</button>',
    '    </form>',
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
  // En Dawn y temas viejos se llama "main-product"; en Horizon (el tema real
  // del cliente, confirmado leyendo su templates/product.landing.json) se
  // llama "product-information" — se dejan los dos para no romper si el
  // cliente cambia de tema más adelante.
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
  // usa el propio tema del cliente para sus otros bloques) el bloque de
  // galería nativa y el de Descripción, en cualquier nivel de anidamiento.
  // No se BORRAN los bloques (en Horizon el de galería es "estático" y no
  // se puede quitar del JSON) y no se toca nada más de esa sección (precio,
  // variantes, botón de comprar, etc. quedan exactamente como el cliente los
  // tenga configurados en su tema — no es cosa nuestra decidir eso). Así la
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
  // que el resto del catálogo del cliente no se ve afectado). Si la
  // plantilla "landing" ya existía (por ejemplo de antes de que existiera
  // simplificarSeccionProducto), se revisa y se repara en el momento si su
  // sección de producto todavía trae de más (galería, título, descripción,
  // etc.) — así las tiendas que ya tenían la plantilla creada también quedan
  // corregidas, sin necesidad de borrarla a mano. Si algo falla acá (por
  // ejemplo, el permiso de temas todavía no está activo), no debe tumbar la
  // publicación del producto — solo queda sin la plantilla especial (o sin
  // la reparación) por esta vez.
  private async asegurarPlantillaLanding(avisos?: string[]): Promise<void> {
    try {
      const temaId = await this.obtenerTemaActivoId();

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
      const seccionExistente = await this.obtenerAsset(temaId, 'sections/landing-imagenes.liquid');
      if (seccionExistente !== this.seccionLandingLiquid) {
        await this.guardarAsset(temaId, 'sections/landing-imagenes.liquid', this.seccionLandingLiquid);
        this.logger.log(seccionExistente === null ? 'Sección "landing-imagenes" creada en el tema.' : 'Sección "landing-imagenes" actualizada en el tema.');
      }

      const plantillaExistente = await this.obtenerAsset(temaId, 'templates/product.landing.json');
      if (plantillaExistente === null) {
        const baseTexto = await this.obtenerAsset(temaId, 'templates/product.json');
        const base = baseTexto ? JSON.parse(baseTexto) : { sections: {}, order: [] };
        base.sections = base.sections || {};
        base.order = Array.isArray(base.order) ? base.order : [];
        this.simplificarSeccionProducto(base);
        base.sections['landing_imagenes_auto'] = { type: 'landing-imagenes' };
        base.order = ['landing_imagenes_auto', ...base.order.filter((k: string) => k !== 'landing_imagenes_auto')];
        await this.guardarAsset(temaId, 'templates/product.landing.json', JSON.stringify(base, null, 2));
        this.logger.log('Plantilla "product.landing.json" creada en el tema.');
      } else {
        try {
          const plantilla = JSON.parse(plantillaExistente);
          const antes = JSON.stringify(plantilla);
          this.simplificarSeccionProducto(plantilla);
          if (JSON.stringify(plantilla) !== antes) {
            await this.guardarAsset(temaId, 'templates/product.landing.json', JSON.stringify(plantilla, null, 2));
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

    // Junta avisos de cosas que fallen sin tumbar la publicación (metafield
    // que no se pudo guardar, sección del tema que no se pudo actualizar) —
    // se devuelven al final para que el taller se los pueda mostrar al
    // estudiante en vez de que se pierdan solo en los logs de Railway.
    const avisos: string[] = [];

    // Se asegura (una sola vez por tienda) de que el tema tenga la plantilla
    // alterna "landing" lista, antes de crear/actualizar el producto.
    await this.asegurarPlantillaLanding(avisos);

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
      if (input.secuencia && input.secuencia.length > 0) {
        await this.guardarMetafieldSecuencia(json.product.id, input.secuencia, avisos);
      }
      await this.guardarMetafieldBotonFlotante(json.product.id, !!input.botonFlotante, avisos);
      await this.publicarEnTiendaOnline(json.product.id);
      this.logger.log(`Producto de Shopify actualizado: ${json.product.handle}`);
      return {
        url: `https://${process.env.SHOPIFY_STORE_DOMAIN}/products/${json.product.handle}`,
        handle: json.product.handle,
        creada: false,
        avisos: avisos.length > 0 ? avisos : undefined,
      };
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
    if (input.secuencia && input.secuencia.length > 0) {
      await this.guardarMetafieldSecuencia(json.product.id, input.secuencia, avisos);
    }
    await this.guardarMetafieldBotonFlotante(json.product.id, !!input.botonFlotante, avisos);
    await this.publicarEnTiendaOnline(json.product.id);
    this.logger.log(`Producto de Shopify creado: ${json.product.handle}`);
    return {
      url: `https://${process.env.SHOPIFY_STORE_DOMAIN}/products/${json.product.handle}`,
      handle: json.product.handle,
      creada: true,
      avisos: avisos.length > 0 ? avisos : undefined,
    };
  }
}
