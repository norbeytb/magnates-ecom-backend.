// auth.controller.ts
//
// Endpoints de cuentas: registrarse, iniciar sesión, y consultar quién está
// conectado (lo usa el taller al abrir la página, para saber si ya hay una
// sesión guardada y que valga la pena, o si hay que mostrar la pantalla de
// entrada). El correo/contraseña viajan por HTTPS (Railway lo da por
// defecto) — nunca se guardan en el backend, solo se validan una vez y se
// devuelve un token.

import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard, UsuarioActual, UsuarioAutenticado } from './auth.guard';

interface CredencialesDto {
  email: string;
  password: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('registro')
  async registro(@Body() dto: CredencialesDto) {
    return this.authService.registrar(dto?.email, dto?.password);
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: CredencialesDto) {
    return this.authService.login(dto?.email, dto?.password);
  }

  // El taller lo llama al cargar la página con el token guardado en
  // localStorage, para confirmar que sigue siendo válido antes de mostrar el
  // taller directo (si no, manda de vuelta a la pantalla de entrada).
  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@UsuarioActual() usuario: UsuarioAutenticado) {
    return usuario;
  }
}
