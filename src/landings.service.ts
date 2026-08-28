// landings.service.ts
//
// Guarda en PostgreSQL (Railway) cada landing ensamblada (el conjunto de piezas +
// botones de comprar + botón flotante que arma el usuario en "Ensamblar landing"),
// para que la pestaña "Mis Landings" las siga mostrando aunque se recargue la
// página o se abra desde otro dispositivo. Sigue el mismo patrón que
// historial.service.ts: si no hay DATABASE_URL o algo falla, el taller sigue
// funcionando normal — solo que esa landing no queda guardada.

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
}

export interface CambiosLanding {
  items?: ItemLanding[];
  botonFlotante?: boolean;
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
      this.logger.log('Conectado a PostgreSQL — tabla "landings_ensambladas" lista.');
    } catch (error) {
      this.logger.error('No se pudo conectar/crear la tabla de landings ensambladas: ' + (error as Error).message);
      this.pool = null;
    }
  }

  // Nunca debe romper el ensamblado en el frontend: si guardar falla, solo se
  // registra en el log y la landing queda solo en memoria del navegador.
  async guardar(registro: RegistroLanding): Promise<any | null> {
    if (!this.pool) return null;
    try {
      const resultado = await this.pool.query(
        `INSERT INTO landings_ensambladas (nombre_producto, num, items_json, boton_flotante)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [registro.nombreProducto, registro.num, JSON.stringify(registro.items), !!registro.botonFlotante],
      );
      return resultado.rows[0];
    } catch (error) {
      this.logger.error('No se pudo guardar la landing ensamblada: ' + (error as Error).message);
      return null;
    }
  }

  async listar(nombreProducto?: string): Promise<any[]> {
    if (!this.pool) return [];
    const resultado = nombreProducto
      ? await this.pool.query(
          `SELECT * FROM landings_ensambladas WHERE nombre_producto = $1 ORDER BY creado_en DESC`,
          [nombreProducto],
        )
      : await this.pool.query(`SELECT * FROM landings_ensambladas ORDER BY creado_en DESC`);
    return resultado.rows;
  }

  async actualizar(id: number, cambios: CambiosLanding): Promise<any | null> {
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
    if (cambios.shopifyUrl !== undefined) {
      sets.push(`shopify_url = $${i++}`);
      values.push(cambios.shopifyUrl);
    }
    if (sets.length === 0) return null;
    sets.push(`actualizado_en = now()`);
    values.push(id);
    try {
      const resultado = await this.pool.query(
        `UPDATE landings_ensambladas SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
        values,
      );
      return resultado.rows[0] || null;
    } catch (error) {
      this.logger.error('No se pudo actualizar la landing ensamblada: ' + (error as Error).message);
      return null;
    }
  }

  async eliminar(id: number): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(`DELETE FROM landings_ensambladas WHERE id = $1`, [id]);
    } catch (error) {
      this.logger.error('No se pudo eliminar la landing ensamblada: ' + (error as Error).message);
    }
  }
}
