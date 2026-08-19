// main.ts
// Punto de entrada: arranca el servidor y lo deja escuchando peticiones.

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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
