// app.module.ts
// Módulo raíz: le dice a NestJS qué controladores y servicios existen.

import { Module } from '@nestjs/common';
import { ImageEditController } from './image-edit.controller';
import { ImageEditService } from './image-edit.service';
import { TextGenerationController } from './text-generation.controller';
import { TextGenerationService } from './text-generation.service';
import { HistorialController } from './historial.controller';
import { HistorialService } from './historial.service';
import { ShopifyController } from './shopify.controller';
import { ShopifyService } from './shopify.service';
import { LandingsController } from './landings.controller';
import { LandingsService } from './landings.service';
import { ProductosController } from './productos.controller';
import { ProductosService } from './productos.service';

@Module({
  controllers: [ImageEditController, TextGenerationController, HistorialController, ShopifyController, LandingsController, ProductosController],
  providers: [ImageEditService, TextGenerationService, HistorialService, ShopifyService, LandingsService, ProductosService],
})
export class AppModule {}
