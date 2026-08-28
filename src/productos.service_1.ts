// productos.service.ts
//
// Guarda en PostgreSQL (Railway) las fotos reales del producto (Imagen 1/2/3)
// que el usuario sube en el taller — independiente de si llega a generar
// alguna sección o no. Así, cada vez que se abre un producto (aunque sea
// recién recargada la página, o desde otro navegador), sus fotos reaparecen
// solas en los slots en vez de quedar solo en memoria del navegador.
// Sigue el mismo patrón que historial.service.ts y landings.service.ts.

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class ProductosService implements OnModuleInit {
  private readonly logger = new Logger(ProductosService.name);
  private pool: Pool | null = null;

  async onModuleInit() {
    if (!process.env.DATABASE_URL) {
      this.logger.warn('DATABASE_URL no está configurada — las fotos de producto no se van a guardar.');
      return;
    }
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS productos (
          nombre_producto TEXT PRIMARY KEY,
          fotos_producto_json JSONB,
          actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      this.logger.log('Conectado a PostgreSQL — tabla "productos" lista.');
    } catch (error) {
      this.logger.error('No se pudo conectar/crear la tabla de productos: ' + (error as Error).message);
      this.pool = null;
    }
  }

  // Guarda (o actualiza) las hasta 3 fotos de un producto de una sola vez —
  // el frontend manda siempre el arreglo completo de los 3 slots.
  async guardarFotos(nombreProducto: string, fotos: (string | null)[]): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO productos (nombre_producto, fotos_producto_json, actualizado_en)
         VALUES ($1, $2, now())
         ON CONFLICT (nombre_producto)
         DO UPDATE SET fotos_producto_json = $2, actualizado_en = now()`,
        [nombreProducto, JSON.stringify(fotos || [])],
      );
    } catch (error) {
      this.logger.error('No se pudo guardar la foto del producto: ' + (error as Error).message);
    }
  }

  async listarFotos(): Promise<any[]> {
    if (!this.pool) return [];
    const resultado = await this.pool.query(`SELECT nombre_producto, fotos_producto_json FROM productos`);
    return resultado.rows;
  }

  async eliminar(nombreProducto: string): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(`DELETE FROM productos WHERE nombre_producto = $1`, [nombreProducto]);
    } catch (error) {
      this.logger.error('No se pudo eliminar el producto: ' + (error as Error).message);
    }
  }
}
