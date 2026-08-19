// app.module.ts
// Módulo raíz: le dice a NestJS qué controladores y servicios existen.

import { Module } from '@nestjs/common';
import { ImageEditController } from './image-edit.controller';
import { ImageEditService } from './image-edit.service';

@Module({
  controllers: [ImageEditController],
  providers: [ImageEditService],
})
export class AppModule {}
