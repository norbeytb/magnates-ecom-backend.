// landings.service.ts
//
// Guarda en PostgreSQL (Railway) cada landing ensamblada (el conjunto de piezas +
// botones de comprar + botón flotante que arma el usuario en "Ensamblar landing"),
// para que la pestaña "Mis Landings" las siga mostrando aunque se recargue la
// página o se abra desde otro dispositivo. Sigue el mismo patrón que
// historial.service.ts: si no hay DATABASE_URL o algo falla, el taller sigue
// funcionando normal — solo que esa landing no queda guardada.
//
// Desde que existen cuentas (ver auth.service.ts), cada landing pertenece a
// un usuario_id — cada quien ve solo las suyas. Las landings guardadas ANTES
// de que existieran las cuentas quedan con usuario_id NULL (no se borran,
// pero tampoco las va a ver nadie).

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';

export interface ItemLanding {
  id: string;
  tipo?: 'boton_comprar';
  image?: string;
  sectionKey?: string;
  sectionLabel?: string;
  templateId?: string | null;
}

export interface RegistroLanding {
  nombreProducto: string;
  num: number;
  items: ItemLanding[];
  botonFlotante?: boolean;
  // Texto/color propios del botón flotante (uno solo por landing, no un item
  // de la secuencia — ver realBotonFlotanteHtml en el frontend). Agregados
  // 10/09 junto con "aplicar a todos" (Texto del botón / color con confirm):
  // ya se mandaban desde el frontend hacía tiempo pero nunca se guardaban acá
  // (faltaban las columnas), así que se perdían al recargar el taller —
  // ahora si quedan.
  botonFlotanteTexto?: string;
  botonFlotanteColor?: string;
  botonFlotanteColorTexto?: string;
  // Interruptor global "Agregar Movimiento" del Editor de Elementos — anima
  // (shake) TODOS los botones "COMPRAR AHORA" de la landing (intercalados +
  // flotante) cuando está en true. Ver shopify.service.ts (seccionLandingLiquid)
  // para cómo se traduce esto a la página real.
  // OJO: reemplazado por "animacionBoton" (09/09, pedido de agregar más
  // opciones que solo pulso) — se deja esta columna/campo viejo sin usar en
  // vez de borrarlo (mismo criterio que el resto del proyecto con columnas
  // viejas, ver nota grande en productos.service.ts) para no romper landings
  // guardadas con versiones anteriores del taller.
  movimiento?: boolean;
  // Pedido 09/09: reemplaza a "movimiento" (booleano) por un selector con 4
  // opciones, calcado del panel "Animación de botón" de una herramienta de
  // referencia que mostró Norbey. 'ninguna' | 'sacudida' | 'rebote' | 'pulsacion'.
  animacionBoton?: string;
  // Pedido 09/09: ícono que se muestra en TODOS los botones "COMPRAR AHORA"
  // de la landing (intercalados + flotante), en vez del camión fijo de
  // antes — ver ICONOS_BOTON en el frontend y el "{% case %}" de
  // seccionLandingLiquid en shopify.service.ts para las claves válidas
  // ('carrito'|'bolsa'|'tarjeta'|'etiqueta'|'camion'|'flecha'|'caja'|'ninguno').
  iconoBoton?: string;
  // Tarjeta "Agregar Barra de Movimiento": barra de texto que se desliza
  // sola, arriba de todo el resto de la landing.
  barra?: boolean;
  barraTexto?: string;
  barraColor?: string;
  barraColorTexto?: string;
  // Segundos que tarda la barra en dar una vuelta completa (menos = más
  // rápido) — elegido con los botones Lenta/Normal/Rápida del taller.
  barraVelocidad?: number;
}

export interface CambiosLanding {
  items?: ItemLanding[];
  botonFlotante?: boolean;
  botonFlotanteTexto?: string;
  botonFlotanteColor?: string;
  botonFlotanteColorTexto?: string;
  movimiento?: boolean;
  animacionBoton?: string;
  iconoBoton?: string;
  barra?: boolean;
  barraTexto?: string;
  barraColor?: string;
  barraColorTexto?: string;
  barraVelocidad?: number;
  shopifyUrl?: string;
}

@Injectable()
export class LandingsService implements OnModuleInit {
  private readonly logger = new Logger(LandingsService.name);
  private pool: Pool | null = null;

  async onModuleInit() {
    if (!process.env.DATABASE_URL) {
      this.logger.warn('DATABASE_URL no está configurada — las landings ensambladas no se van a guardar.');
      return;
    }
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS landings_ensambladas (
          id SERIAL PRIMARY KEY,
          nombre_producto TEXT NOT NULL,
          num INTEGER NOT NULL,
          items_json JSONB NOT NULL,
          boton_flotante BOOLEAN NOT NULL DEFAULT false,
          shopify_url TEXT,
          creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
          actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      // El id ya es SERIAL PRIMARY KEY (no depende del nombre del producto),
      // así que acá alcanza con agregar la columna — sin FK a "usuarios" por
      // la misma razón que en productos.service.ts (no hay orden garantizado
      // entre los onModuleInit de los distintos *.service.ts).
      await this.pool.query(`ALTER TABLE landings_ensambladas ADD COLUMN IF NOT EXISTS usuario_id INTEGER;`);
      // Tarjeta "Agregar Movimiento" del Editor de Elementos (ver taller-generador-landing.html).
      await this.pool.query(`ALTER TABLE landings_ensambladas ADD COLUMN IF NOT EXISTS movimiento BOOLEAN NOT NULL DEFAULT false;`);
      // Tarjeta "Agregar Barra de Movimiento" del Editor de Elementos — texto/color
      // se guardan como TEXT (no hay valor todavía hasta que el estudiante los toque,
      // por eso no llevan NOT NULL como "movimiento"/"boton_flotante").
      await this.pool.query(`ALTER TABLE landings_ensambladas ADD COLUMN IF NOT EXISTS barra BOOLEAN NOT NULL DEFAULT false;`);
      await this.pool.query(`ALTER TABLE landings_ensambladas ADD COLUMN IF NOT EXISTS barra_texto TEXT;`);
      await this.pool.query(`ALTER TABLE landings_ensambladas ADD COLUMN IF NOT EXISTS barra_color TEXT;`);
      await this.pool.query(`ALTER TABLE landings_ensambladas ADD COLUMN IF NOT EXISTS barra_color_texto TEXT;`);
      await this.pool.query(`ALTER TABLE landings_ensambladas ADD COLUMN IF NOT EXISTS barra_velocidad INTEGER;`);
      // Pedido 09/09: reemplaza a "movimiento" (booleano) por un selector de 4
      // animaciones, más un selector de ícono — ver la nota grande en
      // RegistroLanding de arriba. Sin NOT NULL/DEFAULT propio: el valor
      // "efectivo" para landings viejas (creadas antes de este cambio, con
      // animacion_boton NULL) lo resuelve el propio frontend/Liquid mirando la
      // columna "movimiento" vieja como respaldo — ver animacionEfectiva() en
      // el taller y el "{%- unless animacion_boton -%}" en seccionLandingLiquid.
      await this.pool.query(`ALTER TABLE landings_ensambladas ADD COLUMN IF NOT EXISTS animacion_boton TEXT;`);
      await this.pool.query(`ALTER TABLE landings_ensambladas ADD COLUMN IF NOT EXISTS icono_boton TEXT;`);
      // Texto/color del botón flotante — pedido 10/09 (ver nota grande en
      // RegistroLanding de arriba sobre por qué faltaban).
      await this.pool.query(`ALTER TABLE landings_ensambladas ADD COLUMN IF NOT EXISTS boton_flotante_texto TEXT;`);
      await this.pool.query(`ALTER TABLE landings_ensambladas ADD COLUMN IF NOT EXISTS boton_flotante_color TEXT;`);
      await this.pool.query(`ALTER TABLE landings_ensambladas ADD COLUMN IF NOT EXISTS boton_flotante_color_texto TEXT;`);
      this.logger.log('Conectado a PostgreSQL — tabla "landings_ensambladas" lista.');
    } catch (error) {
      this.logger.error('No se pudo conectar/crear la tabla de landings ensambladas: ' + (error as Error).message);
      this.pool = null;
    }
  }

  // Nunca debe romper el ensamblado en el frontend: si guardar falla, solo se
  // registra en el log y la landing queda solo en memoria del navegador.
  async guardar(usuarioId: number, registro: RegistroLanding): Promise<any | null> {
    if (!this.pool) return null;
    try {
      const resultado = await this.pool.query(
        `INSERT INTO landings_ensambladas (nombre_producto, num, items_json, boton_flotante, boton_flotante_texto, boton_flotante_color, boton_flotante_color_texto, movimiento, animacion_boton, icono_boton, barra, barra_texto, barra_color, barra_color_texto, barra_velocidad, usuario_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
        [
          registro.nombreProducto,
          registro.num,
          JSON.stringify(registro.items),
          !!registro.botonFlotante,
          registro.botonFlotanteTexto ?? null,
          registro.botonFlotanteColor ?? null,
          registro.botonFlotanteColorTexto ?? null,
          !!registro.movimiento,
          registro.animacionBoton ?? null,
          registro.iconoBoton ?? null,
          !!registro.barra,
          registro.barraTexto ?? null,
          registro.barraColor ?? null,
          registro.barraColorTexto ?? null,
          registro.barraVelocidad ?? null,
          usuarioId,
        ],
      );
      return resultado.rows[0];
    } catch (error) {
      this.logger.error('No se pudo guardar la landing ensamblada: ' + (error as Error).message);
      return null;
    }
  }

  async listar(usuarioId: number, nombreProducto?: string): Promise<any[]> {
    if (!this.pool) return [];
    const resultado = nombreProducto
      ? await this.pool.query(
          `SELECT * FROM landings_ensambladas WHERE usuario_id = $1 AND nombre_producto = $2 ORDER BY creado_en DESC`,
          [usuarioId, nombreProducto],
        )
      : await this.pool.query(`SELECT * FROM landings_ensambladas WHERE usuario_id = $1 ORDER BY creado_en DESC`, [usuarioId]);
    return resultado.rows;
  }

  // "id" ya identifica una sola fila sin ambigüedad, pero igual se exige
  // usuario_id en el WHERE — así nadie puede tocar (ni siquiera adivinando el
  // id) una landing que no es suya.
  async actualizar(usuarioId: number, id: number, cambios: CambiosLanding): Promise<any | null> {
    if (!this.pool) return null;
    const sets: string[] = [];
    const values: any[] = [];
    let i = 1;
    if (cambios.items !== undefined) {
      sets.push(`items_json = $${i++}`);
      values.push(JSON.stringify(cambios.items));
    }
    if (cambios.botonFlotante !== undefined) {
      sets.push(`boton_flotante = $${i++}`);
      values.push(!!cambios.botonFlotante);
    }
    if (cambios.botonFlotanteTexto !== undefined) {
      sets.push(`boton_flotante_texto = $${i++}`);
      values.push(cambios.botonFlotanteTexto);
    }
    if (cambios.botonFlotanteColor !== undefined) {
      sets.push(`boton_flotante_color = $${i++}`);
      values.push(cambios.botonFlotanteColor);
    }
    if (cambios.botonFlotanteColorTexto !== undefined) {
      sets.push(`boton_flotante_color_texto = $${i++}`);
      values.push(cambios.botonFlotanteColorTexto);
    }
    if (cambios.movimiento !== undefined) {
      sets.push(`movimiento = $${i++}`);
      values.push(!!cambios.movimiento);
    }
    if (cambios.animacionBoton !== undefined) {
      sets.push(`animacion_boton = $${i++}`);
      values.push(cambios.animacionBoton);
    }
    if (cambios.iconoBoton !== undefined) {
      sets.push(`icono_boton = $${i++}`);
      values.push(cambios.iconoBoton);
    }
    if (cambios.barra !== undefined) {
      sets.push(`barra = $${i++}`);
      values.push(!!cambios.barra);
    }
    if (cambios.barraTexto !== undefined) {
      sets.push(`barra_texto = $${i++}`);
      values.push(cambios.barraTexto);
    }
    if (cambios.barraColor !== undefined) {
      sets.push(`barra_color = $${i++}`);
      values.push(cambios.barraColor);
    }
    if (cambios.barraColorTexto !== undefined) {
      sets.push(`barra_color_texto = $${i++}`);
      values.push(cambios.barraColorTexto);
    }
    if (cambios.barraVelocidad !== undefined) {
      sets.push(`barra_velocidad = $${i++}`);
      values.push(cambios.barraVelocidad);
    }
    if (cambios.shopifyUrl !== undefined) {
      sets.push(`shopify_url = $${i++}`);
      values.push(cambios.shopifyUrl);
    }
    if (sets.length === 0) return null;
    sets.push(`actualizado_en = now()`);
    values.push(id, usuarioId);
    try {
      const resultado = await this.pool.query(
        `UPDATE landings_ensambladas SET ${sets.join(', ')} WHERE id = $${i} AND usuario_id = $${i + 1} RETURNING *`,
        values,
      );
      return resultado.rows[0] || null;
    } catch (error) {
      this.logger.error('No se pudo actualizar la landing ensamblada: ' + (error as Error).message);
      return null;
    }
  }

  async eliminar(usuarioId: number, id: number): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(`DELETE FROM landings_ensambladas WHERE id = $1 AND usuario_id = $2`, [id, usuarioId]);
    } catch (error) {
      this.logger.error('No se pudo eliminar la landing ensamblada: ' + (error as Error).message);
    }
  }

  // Borra TODAS las landings ensambladas de un producto — se usa cuando el
  // usuario elimina el producto completo desde "Generador de Landings".
  async eliminarPorProducto(usuarioId: number, nombreProducto: string): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(`DELETE FROM landings_ensambladas WHERE usuario_id = $1 AND nombre_producto = $2`, [usuarioId, nombreProducto]);
    } catch (error) {
      this.logger.error('No se pudo eliminar las landings del producto: ' + (error as Error).message);
    }
  }
}
