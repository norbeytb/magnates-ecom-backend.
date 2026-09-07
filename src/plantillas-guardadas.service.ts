// plantillas-guardadas.service.ts
//
// Pedido 07/09: cuando un estudiante ya armó una buena combinación de plantillas (una por
// sección — ej. una de Hero, una de Oferta, una de Beneficios) y sabe que la va a querer usar
// otra vez más adelante (en otro producto, o para "testear" varias combinaciones guardadas con
// nombre — ej. "Plantilla Testeos", "Plantilla Salud"), antes tenía que volver a elegir cada
// plantilla de cada sección a mano cada vez. Ahora puede guardar esa combinación con un nombre
// desde el modal "Plantillas de Secciones" (pestaña "💾 Plantillas guardadas" — ver
// taller-generador-landing.html) y volver a aplicarla completa con un clic.
//
// Guardado por usuario (no por producto): la idea es reusar la misma combinación en CUALQUIER
// producto futuro, no solo en el que estaba abierto cuando se guardó. Mismo patrón que
// historial.service.ts: la tabla se crea sola al arrancar, sin FK a "usuarios" (no hay orden
// garantizado entre los onModuleInit de los distintos *.service.ts).

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';

// { [sectionKey]: templateId } — ej. { hero: 'hero-12', oferta: 'oferta-3', beneficios: 'beneficios-7' }.
// Se guarda tal cual viene del frontend (st.templateSelections, ya reducido a un solo id por
// sección — ver realizarGuardarPlantillas() en el taller) sin validar las claves acá: si mañana
// se agrega o renombra un tipo de sección, esto sigue funcionando sin tocar el backend.
export type SeleccionesPlantillas = Record<string, string>;

export interface PlantillaGuardada {
  id: number;
  nombre: string;
  selecciones: SeleccionesPlantillas;
  creadoEn: string;
}

@Injectable()
export class PlantillasGuardadasService implements OnModuleInit {
  private readonly logger = new Logger(PlantillasGuardadasService.name);
  private pool: Pool | null = null;

  async onModuleInit() {
    if (!process.env.DATABASE_URL) {
      this.logger.warn('DATABASE_URL no está configurada — las plantillas guardadas no se van a guardar.');
      return;
    }
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS plantillas_guardadas (
          id SERIAL PRIMARY KEY,
          usuario_id INTEGER NOT NULL,
          nombre TEXT NOT NULL,
          selecciones JSONB NOT NULL,
          creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      this.logger.log('Conectado a PostgreSQL — tabla "plantillas_guardadas" lista.');
    } catch (error) {
      this.logger.error('No se pudo conectar/crear la tabla de plantillas guardadas: ' + (error as Error).message);
      this.pool = null;
    }
  }

  private sinBaseDeDatos(): never {
    throw new Error('Todavía no se puede guardar: la base de datos no está conectada. Contactá al administrador.');
  }

  async crear(usuarioId: number, nombre: string, selecciones: SeleccionesPlantillas): Promise<PlantillaGuardada> {
    if (!this.pool) this.sinBaseDeDatos();
    const resultado = await this.pool!.query(
      `INSERT INTO plantillas_guardadas (usuario_id, nombre, selecciones) VALUES ($1, $2, $3)
       RETURNING id, nombre, selecciones, creado_en`,
      [usuarioId, nombre, JSON.stringify(selecciones)],
    );
    return this.aPlantillaGuardada(resultado.rows[0]);
  }

  async listar(usuarioId: number): Promise<PlantillaGuardada[]> {
    if (!this.pool) return [];
    const resultado = await this.pool.query(
      `SELECT id, nombre, selecciones, creado_en FROM plantillas_guardadas WHERE usuario_id = $1 ORDER BY creado_en DESC`,
      [usuarioId],
    );
    return resultado.rows.map((fila) => this.aPlantillaGuardada(fila));
  }

  // Solo borra si la fila es de ESE usuario (nunca la de otro) — el WHERE con
  // ambas condiciones hace de guarda de seguridad sin necesitar una consulta aparte.
  async eliminar(usuarioId: number, id: number): Promise<void> {
    if (!this.pool) this.sinBaseDeDatos();
    await this.pool!.query(`DELETE FROM plantillas_guardadas WHERE id = $1 AND usuario_id = $2`, [id, usuarioId]);
  }

  private aPlantillaGuardada(fila: any): PlantillaGuardada {
    return {
      id: fila.id,
      nombre: fila.nombre,
      selecciones: fila.selecciones,
      creadoEn: fila.creado_en,
    };
  }
}
