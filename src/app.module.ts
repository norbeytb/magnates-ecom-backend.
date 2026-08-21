// app.module.ts
// Módulo raíz: le dice a NestJS qué controladores y servicios existen.
 
import { Module } from '@nestjs/common';
import { ImageEditController } from './image-edit.controller';
import { ImageEditService } from './image-edit.service';
import { TextGenerationController } from './text-generation.controller';
import { TextGenerationService } from './text-generation.service';
 
@Module({
  controllers: [ImageEditController, TextGenerationController],
  providers: [ImageEditService, TextGenerationService],
})
export class AppModule {}
