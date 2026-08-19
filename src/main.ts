// main.ts
// Punto de entrada: arranca el servidor y lo deja escuchando peticiones.

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { json } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Por defecto Express/NestJS solo acepta hasta 100kb de JSON en el body.
  // La foto de producto viaja como base64 dentro del JSON y puede pesar
  // varios MB, así que subimos el límite para que no la rechace.
  app.use(json({ limit: '25mb' }));

  // Permite que el taller (que corre en el navegador, en otro dominio)
  // pueda llamar a este backend. En producción, cambia '*' por el dominio
  // real donde publiques el taller.
  app.enableCors({ origin: '*' });

  // Railway asigna el puerto automáticamente vía la variable PORT.
  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`Backend IA escuchando en el puerto ${port}`);
}
bootstrap();
