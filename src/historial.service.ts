// historial.service.ts
//
// Guarda en PostgreSQL (Railway) un registro de cada imagen generada con éxito:
// producto, sección, URL de la imagen, el prompt usado y el costo estimado.
// La tabla se crea sola la primera vez que el backend arranca con la base de
// datos conectada — no hace falta correr ninguna migración a mano.

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';

export interface RegistroHistorial {
  nombreProducto: string;
  seccion: string;
  imagenUrl: string;
  promptUsado: string;
  costoEstimadoUsd: number;
  fichaJson?: unknown;
  fotoProductoUrl?: string;
  templateId?: string;
}

@Injectable()
export class HistorialService implements OnModuleInit {
  private readonly logger = new Logger(HistorialService.name);
  private pool: Pool | null = null;

  async onModuleInit() {
    if (!process.env.DATABASE_URL) {
      // Sin base de datos conectada, el backend sigue funcionando normal — el
      // historial simplemente no se guarda (no debe tumbar la generación de imágenes).
      this.logger.warn('DATABASE_URL no está configurada — el historial no se va a guardar.');
      return;
    }
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS generaciones (
          id SERIAL PRIMARY KEY,
          nombre_producto TEXT NOT NULL,
          seccion TEXT NOT NULL,
          imagen_url TEXT NOT NULL,
          prompt_usado TEXT,
          costo_estimado_usd NUMERIC(10, 4),
          creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      // La tabla puede ya existir de antes de que se guardara la ficha técnica —
      // esto agrega la columna sola, sin borrar nada, tanto en una base nueva como
      // en una que ya tenía filas guardadas.
      await this.pool.query(`
        ALTER TABLE generaciones ADD COLUMN IF NOT EXISTS ficha_json JSONB;
      `);
      await this.pool.query(`
        ALTER TABLE generaciones ADD COLUMN IF NOT EXISTS foto_producto_url TEXT;
      `);
      // Sin esto, al recargar la página se pierde de qué plantilla salió cada pieza
      // y el bloque "Referencia" del visor de una sola pieza queda vacío para siempre.
      await this.pool.query(`
        ALTER TABLE generaciones ADD COLUMN IF NOT EXISTS template_id TEXT;
      `);
      this.logger.log('Conectado a PostgreSQL — tabla "generaciones" lista.');
    } catch (error) {
      this.logger.error('No se pudo conectar/crear la tabla de historial: ' + (error as Error).message);
      this.pool = null;
    }
  }

  // Nunca debe romper una generación: si guardar el historial falla, solo se
  // registra en el log y se sigue de largo — el usuario ya tiene su imagen.
  async guardar(registro: RegistroHistorial): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO generaciones (nombre_producto, seccion, imagen_url, prompt_usado, costo_estimado_usd, ficha_json, foto_producto_url, template_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          registro.nombreProducto,
          registro.seccion,
          registro.imagenUrl,
          registro.promptUsado,
          registro.costoEstimadoUsd,
          registro.fichaJson ? JSON.stringify(registro.fichaJson) : null,
          registro.fotoProductoUrl || null,
          registro.templateId || null,
        ],
      );
    } catch (error) {
      this.logger.error('No se pudo guardar el historial: ' + (error as Error).message);
    }
  }

  async listar(nombreProducto?: string): Promise<any[]> {
    if (!this.pool) return [];
    const resultado = nombreProducto
      ? await this.pool.query(
          `SELECT * FROM generaciones WHERE nombre_producto = $1 ORDER BY creado_en DESC LIMIT 200`,
          [nombreProducto],
        )
      : await this.pool.query(`SELECT * FROM generaciones ORDER BY creado_en DESC LIMIT 200`);
    return resultado.rows;
  }

  // Borra TODO el historial de piezas generadas de un producto — se usa cuando
  // el usuario elimina el producto completo desde "Generador de Landings".
  // Nunca debe tumbar el flujo del taller: si falla, solo se registra en el log.
  async eliminarPorProducto(nombreProducto: string): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(`DELETE FROM generaciones WHERE nombre_producto = $1`, [nombreProducto]);
    } catch (error) {
      this.logger.error('No se pudo eliminar el historial del producto: ' + (error as Error).message);
    }
  }
}
