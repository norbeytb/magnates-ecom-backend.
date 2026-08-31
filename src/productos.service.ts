// productos.service.ts
//
// Guarda en PostgreSQL (Railway) las fotos reales del producto (Imagen 1/2/3)
// que el usuario sube en el taller — independiente de si llega a generar
// alguna sección o no. Así, cada vez que se abre un producto (aunque sea
// recién recargada la página, o desde otro navegador), sus fotos reaparecen
// solas en los slots en vez de quedar solo en memoria del navegador.
// Sigue el mismo patrón que historial.service.ts y landings.service.ts.
//
// Desde que existen cuentas (ver auth.service.ts), cada producto pertenece a
// un usuario_id — dos personas distintas pueden tener cada una un producto
// llamado igual sin pisarse, y nadie ve los productos de otra cuenta. Los
// productos guardados ANTES de que existieran las cuentas quedan con
// usuario_id NULL: no se borran, pero tampoco los va a ver nadie hasta que
// se vuelvan a crear ya con una sesión iniciada — es la única forma limpia
// de "repartir" datos viejos que nunca tuvieron dueño.

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
      // Sin FK a "usuarios" a propósito: los distintos *.service.ts abren su
      // propio Pool y crean su tabla en onModuleInit cada uno por su lado, sin
      // garantía de orden entre ellos — una FK podría fallar si esta tabla se
      // crea antes que la de usuarios. Al ser un solo backend simple (no una
      // app bancaria), alcanza con validar la sesión en el guard (ver
      // auth.guard.ts) sin forzar la integridad referencial a nivel de base.
      await this.pool.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS usuario_id INTEGER;`);
      // La clave primaria original era solo "nombre_producto" (de cuando todo
      // era compartido) — ahora dos usuarios distintos pueden tener cada uno
      // un producto con el mismo nombre, así que la unicidad pasa a ser
      // "nombre_producto POR usuario". Ambos pasos son idempotentes: no
      // truena si ya se migró en un arranque anterior.
      await this.pool.query(`ALTER TABLE productos DROP CONSTRAINT IF EXISTS productos_pkey;`);
      await this.pool.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'productos_usuario_nombre_key') THEN
            ALTER TABLE productos ADD CONSTRAINT productos_usuario_nombre_key UNIQUE (usuario_id, nombre_producto);
          END IF;
        END
        $$;
      `);
      this.logger.log('Conectado a PostgreSQL — tabla "productos" lista.');
    } catch (error) {
      this.logger.error('No se pudo conectar/crear la tabla de productos: ' + (error as Error).message);
      this.pool = null;
    }
  }

  // Guarda (o actualiza) las hasta 3 fotos de un producto de una sola vez —
  // el frontend manda siempre el arreglo completo de los 3 slots.
  async guardarFotos(usuarioId: number, nombreProducto: string, fotos: (string | null)[]): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO productos (nombre_producto, usuario_id, fotos_producto_json, actualizado_en)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (usuario_id, nombre_producto)
         DO UPDATE SET fotos_producto_json = $3, actualizado_en = now()`,
        [nombreProducto, usuarioId, JSON.stringify(fotos || [])],
      );
    } catch (error) {
      this.logger.error('No se pudo guardar la foto del producto: ' + (error as Error).message);
    }
  }

  async listarFotos(usuarioId: number): Promise<any[]> {
    if (!this.pool) return [];
    const resultado = await this.pool.query(
      `SELECT nombre_producto, fotos_producto_json FROM productos WHERE usuario_id = $1`,
      [usuarioId],
    );
    return resultado.rows;
  }

  async eliminar(usuarioId: number, nombreProducto: string): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(`DELETE FROM productos WHERE usuario_id = $1 AND nombre_producto = $2`, [usuarioId, nombreProducto]);
    } catch (error) {
      this.logger.error('No se pudo eliminar el producto: ' + (error as Error).message);
    }
  }
}
