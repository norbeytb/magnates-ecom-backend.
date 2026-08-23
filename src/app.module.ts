// app.module.ts
// Módulo raíz: le dice a NestJS qué controladores y servicios existen.

import { Module } from '@nestjs/common';
import { ImageEditController } from './image-edit.controller';
import { ImageEditService } from './image-edit.service';
import { TextGenerationController } from './text-generation.controller';
import { TextGenerationService } from './text-generation.service';
import { HistorialController } from './historial.controller';
import { HistorialService } from './historial.service';

@Module({
  controllers: [ImageEditController, TextGenerationController, HistorialController],
  providers: [ImageEditService, TextGenerationService, HistorialService],
})
export class AppModule {}
